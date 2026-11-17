/**
 * Learner-partition persistence for the learning loop.
 *
 * Everything here rides the existing RuntimeStore partition
 * `(stageId, learnerKey)`. One long-lived `learning` session holds append-only
 * records: a graded observation, or a review-card snapshot. That keeps the
 * history out of the course document (which is shared and git-synced) and out
 * of localStorage (which is per browser, not per learner).
 *
 * Client-only by default: the browser bootstrap supplies the store and the
 * learner key. Server code must inject both through {@link LearningStoreDeps}.
 */

import type { RuntimeStore } from '@openmaic/storage';

import { getLearnerKey } from '@/lib/runtime/learner-key';
import { getRuntimeStore } from '@/lib/runtime/store';

import { appendEvidence, hasEvidence, normalizeEvidence } from './evidence';
import {
  evidenceFromReview,
  newReviewCard,
  normalizeReviewCard,
  reviewCard as scheduleReview,
} from './review';
import {
  LEARNING_PAYLOAD_VERSION,
  foldLearningRecords,
  type LearningRecordPayload,
  type LearningState,
} from './store-payload';
import type { LearningEvidence, ReviewCard, ReviewRating } from './types';

export const LEARNING_SESSION_KIND = 'learning';

/** One item's review identity inside a course. */
export interface LearningItemRef {
  sceneId: string;
  itemId: string;
  conceptIds: readonly string[];
}

export interface LearningStoreDeps {
  store?: RuntimeStore;
  learnerKey?: string;
  now?: () => number;
  mintRecordId?: () => string;
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Deterministic root session id. Learner keys are opaque and may contain the
 * separator, so every segment is encoded rather than concatenated raw.
 */
export function learningSessionId(stageId: string, learnerKey: string): string {
  return `learning:${encodeSegment(stageId)}:${encodeSegment(learnerKey)}`;
}

/** Scene-qualified card id: quiz item ids repeat across scenes. */
export function reviewCardId(stageId: string, sceneId: string, itemId: string): string {
  return `${encodeSegment(stageId)}:${encodeSegment(sceneId)}:${encodeSegment(itemId)}`;
}

export function mintLearningRecordId(): string {
  const suffix =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `learning-record:${suffix}`;
}

/**
 * True for the store's "session is no longer active" rejection. Every
 * RuntimeStore implementation uses this prefix; the retry below is the only
 * consumer, and a different failure (version skew, validation) must propagate
 * untouched.
 */
function isSessionClosedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith('@openmaic/storage: cannot append to session')
  );
}

/**
 * Append one learning record, retrying on a fresh active session when a
 * concurrent compaction archived ours between the session lookup and the
 * write. Without this retry, a learner could lose evidence to a maintenance
 * pass that was supposed to be invisible.
 */
async function appendLearningRecord(input: {
  store: RuntimeStore;
  stageId: string;
  learnerKey: string;
  timestamp: string;
  sessionId: string;
  payload: LearningRecordPayload;
  mint: () => string;
}): Promise<string> {
  const write = (sessionId: string) =>
    input.store.appendRecord({
      id: input.mint(),
      sessionId,
      createdAt: input.timestamp,
      payload: input.payload,
    });

  try {
    await write(input.sessionId);
    return input.sessionId;
  } catch (error) {
    if (!isSessionClosedError(error)) throw error;
    const next = await ensureLearningSession(
      input.store,
      input.stageId,
      input.learnerKey,
      input.timestamp,
    );
    if (next === input.sessionId) throw error;
    await write(next);
    return next;
  }
}

async function ensureLearningSession(
  store: RuntimeStore,
  stageId: string,
  learnerKey: string,
  timestamp: string,
): Promise<string> {
  const sessions = await store.listSessions(stageId, learnerKey);
  const active = sessions.find(
    (session) => session.kind === LEARNING_SESSION_KIND && session.status === 'active',
  );
  if (active) return active.id;

  const base = learningSessionId(stageId, learnerKey);
  for (let index = 0; index < 100; index += 1) {
    const id = index === 0 ? base : `${base}:${index}`;
    const existing = await store.getSession(id);
    if (existing) {
      if (
        existing.kind !== LEARNING_SESSION_KIND ||
        existing.stageId !== stageId ||
        existing.learnerKey !== learnerKey
      ) {
        throw new Error(
          `Learning session ${JSON.stringify(id)} already belongs to another partition`,
        );
      }
      if (existing.status === 'active') return existing.id;
      // An archived session is history; keep looking for a fresh slot.
      continue;
    }
    try {
      await store.createSession({
        id,
        kind: LEARNING_SESSION_KIND,
        stageId,
        learnerKey,
        status: 'active',
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      return id;
    } catch (error) {
      // Another tab may have created the same deterministic id between our
      // read and write. Adopt the winner when it is usable.
      const raced = await store.getSession(id);
      if (
        raced &&
        raced.kind === LEARNING_SESSION_KIND &&
        raced.stageId === stageId &&
        raced.learnerKey === learnerKey &&
        raced.status === 'active'
      ) {
        return raced.id;
      }
      if (!raced) throw error;
    }
  }
  throw new Error(`Could not allocate a learning session for stage ${JSON.stringify(stageId)}`);
}

/**
 * Fold every learning session of this learner and stage. Reading all sessions
 * (not just the active one) keeps evidence visible after an operator archives
 * a session; sessions are listed in creation order, so records stay ordered.
 */
export async function loadLearningState(
  input: { stageId: string },
  deps: LearningStoreDeps = {},
): Promise<LearningState> {
  const store = deps.store ?? getRuntimeStore();
  const learnerKey = deps.learnerKey ?? (await getLearnerKey());
  const sessions = (await store.listSessions(input.stageId, learnerKey)).filter(
    (session) => session.kind === LEARNING_SESSION_KIND,
  );

  const records: { payload: unknown }[] = [];
  for (const session of sessions) {
    try {
      records.push(...(await store.listRecords(session.id)));
    } catch (error) {
      // One unreadable session must not hide the rest of the learner's history.
      console.warn(`Skipping unreadable learning session ${session.id}:`, error);
    }
  }
  return foldLearningRecords(records);
}

/**
 * Append observations, skipping ids the log already holds.
 *
 * The read-then-append is not a transaction: two tabs can both decide an id is
 * new and append it. That is harmless because the fold is idempotent; the
 * stored duplicate is read once and later dropped by the bound.
 */
export async function appendLearningEvidence(
  input: { stageId: string; evidence: readonly LearningEvidence[] },
  deps: LearningStoreDeps = {},
): Promise<void> {
  const incoming = input.evidence
    .map((entry) => normalizeEvidence(entry))
    .filter((entry): entry is LearningEvidence => entry !== null);
  if (incoming.length === 0) return;

  const store = deps.store ?? getRuntimeStore();
  const learnerKey = deps.learnerKey ?? (await getLearnerKey());
  const state = await loadLearningState({ stageId: input.stageId }, { ...deps, store, learnerKey });

  let log: readonly LearningEvidence[] = state.evidence;
  const pending: LearningEvidence[] = [];
  for (const evidence of incoming) {
    if (hasEvidence(log, evidence.id)) continue;
    log = appendEvidence(log, evidence);
    pending.push(evidence);
  }
  if (pending.length === 0) return;

  const now = deps.now ?? Date.now;
  const timestamp = new Date(now()).toISOString();
  const sessionId = await ensureLearningSession(store, input.stageId, learnerKey, timestamp);
  const mint = deps.mintRecordId ?? mintLearningRecordId;

  let activeSessionId = sessionId;
  for (const evidence of pending) {
    const payload: LearningRecordPayload = {
      version: LEARNING_PAYLOAD_VERSION,
      kind: 'evidence',
      evidence,
    };
    activeSessionId = await appendLearningRecord({
      store,
      stageId: input.stageId,
      learnerKey,
      timestamp,
      sessionId: activeSessionId,
      payload,
      mint,
    });
  }
}

function sameConceptSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

function cleanConceptIds(values: readonly string[]): string[] {
  const ids: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const conceptId = value.trim();
    if (!conceptId || ids.includes(conceptId)) continue;
    ids.push(conceptId);
    if (ids.length >= 16) break;
  }
  return ids;
}

/**
 * Create a review card for every tagged, graded item that does not have one,
 * and refresh tags when a question was retagged. Schedule state is preserved on
 * refresh: editing a question's concepts must not silently postpone its review.
 */
export async function ensureReviewCards(
  input: { stageId: string; items: readonly LearningItemRef[] },
  deps: LearningStoreDeps = {},
): Promise<void> {
  if (input.items.length === 0) return;

  const store = deps.store ?? getRuntimeStore();
  const learnerKey = deps.learnerKey ?? (await getLearnerKey());
  const state = await loadLearningState({ stageId: input.stageId }, { ...deps, store, learnerKey });
  const existing = new Map(state.reviewCards.map((card) => [card.cardId, card]));
  const now = (deps.now ?? Date.now)();
  const updates: ReviewCard[] = [];
  const seen = new Set<string>();

  for (const item of input.items) {
    const conceptIds = cleanConceptIds(item.conceptIds);
    if (conceptIds.length === 0) continue;
    const cardId = reviewCardId(input.stageId, item.sceneId, item.itemId);
    if (seen.has(cardId)) continue;
    seen.add(cardId);

    const card = existing.get(cardId);
    if (!card) {
      updates.push({
        ...newReviewCard(cardId, conceptIds, now),
        sceneId: item.sceneId,
        itemId: item.itemId,
      });
    } else if (
      !sameConceptSet(card.conceptIds, conceptIds) ||
      card.sceneId !== item.sceneId ||
      card.itemId !== item.itemId
    ) {
      updates.push({
        ...card,
        conceptIds,
        sceneId: item.sceneId,
        itemId: item.itemId,
      });
    }
  }
  if (updates.length === 0) return;

  const timestamp = new Date(now).toISOString();
  const sessionId = await ensureLearningSession(store, input.stageId, learnerKey, timestamp);
  const payload: LearningRecordPayload = {
    version: LEARNING_PAYLOAD_VERSION,
    kind: 'reviewCards',
    cards: updates,
  };
  await appendLearningRecord({
    store,
    stageId: input.stageId,
    learnerKey,
    timestamp,
    sessionId,
    payload,
    mint: deps.mintRecordId ?? mintLearningRecordId,
  });
}

export interface RecordReviewRatingInput {
  stageId: string;
  /** The card as the caller saw it; the stored schedule wins when present. */
  card: ReviewCard;
  rating: ReviewRating;
  /** Idempotency key for this rating action. */
  reviewId: string;
}

export interface ReviewRatingResult {
  card: ReviewCard;
  evidence: LearningEvidence;
}

/**
 * Apply one review rating: advance the card, then record the half-weight
 * mastery observation.
 *
 * The stored card, not the caller's copy, is the schedule source of truth:
 * a second tab may have reviewed it since the dashboard loaded. A repeated
 * `reviewId` returns the existing observation without advancing the schedule
 * twice, which makes a double click safe.
 *
 * Card and evidence are separate appends (the runtime has no cross-record
 * transaction). A failure between them leaves the schedule advanced and the
 * observation missing; the next rating repairs the observation, and mastery is
 * never fed a fabricated result in the meantime.
 */
export async function recordReviewRating(
  input: RecordReviewRatingInput,
  deps: LearningStoreDeps = {},
): Promise<ReviewRatingResult> {
  const reviewId = input.reviewId.trim();
  if (!reviewId) throw new Error('recordReviewRating requires a non-empty reviewId');

  const store = deps.store ?? getRuntimeStore();
  const learnerKey = deps.learnerKey ?? (await getLearnerKey());
  const state = await loadLearningState({ stageId: input.stageId }, { ...deps, store, learnerKey });
  const current =
    state.reviewCards.find((card) => card.cardId === input.card.cardId) ??
    normalizeReviewCard(input.card);
  if (!current) throw new Error('recordReviewRating received an invalid review card');

  const evidenceId = `review:${reviewId}`;
  const replay = state.evidence.find((record) => record.id === evidenceId);
  if (replay) return { card: current, evidence: replay };

  const now = (deps.now ?? Date.now)();
  const updated = scheduleReview(current, input.rating, now);
  const timestamp = new Date(now).toISOString();
  let sessionId = await ensureLearningSession(store, input.stageId, learnerKey, timestamp);
  const mint = deps.mintRecordId ?? mintLearningRecordId;

  const cardPayload: LearningRecordPayload = {
    version: LEARNING_PAYLOAD_VERSION,
    kind: 'reviewCards',
    cards: [updated],
  };
  sessionId = await appendLearningRecord({
    store,
    stageId: input.stageId,
    learnerKey,
    timestamp,
    sessionId,
    payload: cardPayload,
    mint,
  });

  const evidence = evidenceFromReview({
    id: evidenceId,
    learnerKey,
    stageId: input.stageId,
    card: updated,
    rating: input.rating,
    recordedAt: now,
  });
  const evidencePayload: LearningRecordPayload = {
    version: LEARNING_PAYLOAD_VERSION,
    kind: 'evidence',
    evidence,
  };
  await appendLearningRecord({
    store,
    stageId: input.stageId,
    learnerKey,
    timestamp,
    sessionId,
    payload: evidencePayload,
    mint,
  });

  return { card: updated, evidence };
}
