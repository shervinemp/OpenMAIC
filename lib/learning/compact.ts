/**
 * Physical compaction for the learning partition.
 *
 * The logical evidence log is bounded on read, but a RuntimeStore session is
 * append-only: dropping an old observation from the fold does not remove its
 * record. This pass reclaims that space without rewriting history.
 *
 * Two moves, both conservative:
 *
 * 1. Delete an inactive learning session only when nothing in it is visible:
 *    none of its evidence survives the bounded window, and none of its card
 *    snapshots is the latest snapshot for a card. An active session is never
 *    deleted, because a writer may be about to append to it.
 * 2. Rotate one old, large active session: create a fresh active session first,
 *    then archive the old one with an optimistic tail check. The old records
 *    stay readable; they become deletable on a later pass once their evidence
 *    falls out of the window and their card snapshots are superseded.
 *
 * This is log-structured cleanup, not a checkpoint copy. Nothing is rewritten,
 * so a partial failure only leaves records for a later pass.
 */

import type { RuntimeRecord, RuntimeSession } from '@openmaic/dsl';
import type { RuntimeStore } from '@openmaic/storage';

import { getLearnerKey } from '@/lib/runtime/learner-key';
import { getRuntimeStore } from '@/lib/runtime/store';

import { DEFAULT_EVIDENCE_LIMIT } from './evidence';
import { LEARNING_SESSION_KIND, learningSessionId, type LearningStoreDeps } from './store';
import { foldLearningRecords, normalizeLearningPayload } from './store-payload';

/** One check per process is enough for a maintenance pass this cheap. */
export const LEARNING_COMPACTION_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Rotate an active session once it reaches this size and age. */
export const LEARNING_SESSION_ROTATE_RECORDS = 2_000;
export const LEARNING_SESSION_ROTATE_MIN_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface CompactLearningInput {
  stageId: string;
  /** Evidence window used to decide what is still visible. */
  evidenceLimit?: number;
  /** Test/operator seam: rotate at this record count instead of the default. */
  rotateAfterRecords?: number;
  /** Test/operator seam: rotate regardless of record age. */
  force?: boolean;
}

export interface LearningCompactionResult {
  reason: 'no-sessions' | 'compacted' | 'noop';
  deletedSessions: number;
  deletedRecords: number;
  rotated: boolean;
  sessionsBefore: number;
  sessionsAfter: number;
  recordsBefore: number;
  recordsAfter: number;
}

interface SessionRecords {
  session: RuntimeSession;
  records: RuntimeRecord[];
}

const lastChecks = new Map<string, number>();

function normalizedEvidenceLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_EVIDENCE_LIMIT;
  if (!Number.isFinite(value)) return DEFAULT_EVIDENCE_LIMIT;
  return Math.max(1, Math.floor(value));
}

function recordTime(record: RuntimeRecord): number | null {
  const parsed = Date.parse(record.createdAt);
  return Number.isFinite(parsed) ? parsed : null;
}

function oldestRecordTime(records: readonly RuntimeRecord[]): number | null {
  let oldest: number | null = null;
  for (const record of records) {
    const time = recordTime(record);
    if (time === null) continue;
    if (oldest === null || time < oldest) oldest = time;
  }
  return oldest;
}

/**
 * Session ids that hold the last snapshot for at least one card. Deleting such
 * a session would silently forget that card, even if its evidence is ancient.
 */
function latestCardSessionIds(loaded: readonly SessionRecords[]): Set<string> {
  const latest = new Map<string, string>();
  for (const { session, records } of loaded) {
    for (const record of records) {
      const payload = normalizeLearningPayload(record.payload);
      if (!payload || payload.kind !== 'reviewCards') continue;
      for (const card of payload.cards) latest.set(card.cardId, session.id);
    }
  }
  return new Set(latest.values());
}

function hasVisibleEvidence(
  records: readonly RuntimeRecord[],
  visibleEvidence: ReadonlySet<string>,
): boolean {
  return records.some((record) => {
    const payload = normalizeLearningPayload(record.payload);
    return payload?.kind === 'evidence' && visibleEvidence.has(payload.evidence.id);
  });
}

async function createRotationSession(
  store: RuntimeStore,
  stageId: string,
  learnerKey: string,
  timestamp: string,
  now: number,
): Promise<string | null> {
  const base = learningSessionId(stageId, learnerKey);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const id = `${base}:compact:${now.toString(36)}:${attempt}`;
    if (await store.getSession(id)) continue;
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
    } catch {
      // Another tab won this id; the next suffix is still available.
    }
  }
  return null;
}

export async function compactLearningHistory(
  input: CompactLearningInput,
  deps: LearningStoreDeps = {},
): Promise<LearningCompactionResult> {
  const store = deps.store ?? getRuntimeStore();
  const learnerKey = deps.learnerKey ?? (await getLearnerKey());
  const now = deps.now?.() ?? Date.now();
  const evidenceLimit = normalizedEvidenceLimit(input.evidenceLimit);
  const rotateAfterRecords = Math.max(
    1,
    Math.floor(input.rotateAfterRecords ?? LEARNING_SESSION_ROTATE_RECORDS),
  );

  const sessions = (await store.listSessions(input.stageId, learnerKey)).filter(
    (session) => session.kind === LEARNING_SESSION_KIND,
  );
  const sessionsBefore = sessions.length;
  if (sessionsBefore === 0) {
    return {
      reason: 'no-sessions',
      deletedSessions: 0,
      deletedRecords: 0,
      rotated: false,
      sessionsBefore: 0,
      sessionsAfter: 0,
      recordsBefore: 0,
      recordsAfter: 0,
    };
  }

  const loaded: SessionRecords[] = [];
  let recordsBefore = 0;
  for (const session of sessions) {
    let records: RuntimeRecord[];
    try {
      records = await store.listRecords(session.id);
    } catch {
      // An unreadable session may hold unique history. Leave the partition
      // untouched instead of deleting a sibling that only looks superseded.
      return {
        reason: 'noop',
        deletedSessions: 0,
        deletedRecords: 0,
        rotated: false,
        sessionsBefore,
        sessionsAfter: sessionsBefore,
        recordsBefore,
        recordsAfter: recordsBefore,
      };
    }
    loaded.push({ session, records });
    recordsBefore += records.length;
  }

  const state = foldLearningRecords(
    loaded.flatMap((entry) => entry.records),
    { evidenceLimit },
  );
  const visibleEvidence = new Set(state.evidence.map((entry) => entry.id));
  const latestCards = latestCardSessionIds(loaded);

  let deletedSessions = 0;
  let deletedRecords = 0;
  const kept: SessionRecords[] = [];
  for (const entry of loaded) {
    const { session, records } = entry;
    if (session.status === 'active') {
      kept.push(entry);
      continue;
    }
    if (latestCards.has(session.id) || hasVisibleEvidence(records, visibleEvidence)) {
      kept.push(entry);
      continue;
    }
    try {
      await store.deleteSession(session.id);
      deletedSessions += 1;
      deletedRecords += records.length;
    } catch {
      // A concurrent reader or a transient store failure: retry next pass.
      kept.push(entry);
    }
  }

  let rotated = false;
  const active = kept.filter((entry) => entry.session.status === 'active');
  if (active.length === 1) {
    const entry = active[0]!;
    const oldest = oldestRecordTime(entry.records);
    const oldEnough =
      input.force === true ||
      (oldest !== null && now - oldest >= LEARNING_SESSION_ROTATE_MIN_AGE_MS);
    if (entry.records.length >= rotateAfterRecords && oldEnough) {
      const timestamp = new Date(now).toISOString();
      const rotatedId = await createRotationSession(
        store,
        input.stageId,
        learnerKey,
        timestamp,
        now,
      );
      if (rotatedId) {
        const lastSeq = entry.records.at(-1)?.seq ?? null;
        try {
          await store.setSessionStatus(entry.session.id, 'archived', timestamp, {
            expectedLastSeq: lastSeq,
          });
          rotated = true;
        } catch {
          // A concurrent append won the race; discard the empty session and
          // leave the old one active. No record was lost.
          await store.deleteSession(rotatedId).catch(() => undefined);
        }
      }
    }
  }

  return {
    reason: deletedSessions > 0 || rotated ? 'compacted' : 'noop',
    deletedSessions,
    deletedRecords,
    rotated,
    sessionsBefore,
    sessionsAfter: kept.length + (rotated ? 1 : 0),
    recordsBefore,
    recordsAfter: recordsBefore - deletedRecords,
  };
}

/**
 * Throttled entry point for the learning overlay. A failed pass is retried on
 * the next visit rather than on every render; a successful pass (including a
 * no-op) waits for the next interval.
 */
export async function maybeCompactLearningHistory(
  input: CompactLearningInput,
  deps: LearningStoreDeps = {},
): Promise<LearningCompactionResult | null> {
  const now = deps.now?.() ?? Date.now();
  // Multi-learner runtimes share a stage; one learner's check must not suppress
  // another learner's maintenance. Resolve the partition once and reuse it.
  const learnerKey = deps.learnerKey ?? (await getLearnerKey());
  const checkKey = `${input.stageId}\u0000${learnerKey}`;
  const last = lastChecks.get(checkKey);
  if (last !== undefined && now - last < LEARNING_COMPACTION_CHECK_INTERVAL_MS) return null;
  lastChecks.set(checkKey, now);
  try {
    return await compactLearningHistory(input, { ...deps, learnerKey });
  } catch (error) {
    lastChecks.delete(checkKey);
    throw error;
  }
}

/** Tests need a deterministic first check. */
export function resetLearningCompactionForTests(): void {
  lastChecks.clear();
}
