import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createLogger } from '@/lib/logger';
import { writeJsonFileAtomic } from '@/lib/server/classroom-storage';
import {
  isStaleDraft,
  mergeSceneDraft,
  pruneSceneDrafts,
  sceneDraftId,
  type SceneDraft,
  type SceneDraftPayload,
} from '@/lib/utils/scene-draft-model';

const log = createLogger('ServerSceneDraftStore');

/**
 * One JSON file per stage. Drafts are raw LLM payloads only, so losing this
 * cache costs a re-paid call — never a scene. PERSISTENCE_DIR keeps it beside
 * the course documents; SCENE_DRAFTS_DIR can override it for tests.
 */
function draftsDir(): string {
  if (process.env.SCENE_DRAFTS_DIR) return path.resolve(process.env.SCENE_DRAFTS_DIR);
  const base = process.env.PERSISTENCE_DIR
    ? path.resolve(process.env.PERSISTENCE_DIR)
    : path.join(process.cwd(), 'data');
  return path.join(base, 'scene-drafts');
}

function safeStageId(stageId: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(stageId) && stageId.length <= 128;
}

function stagePath(stageId: string): string | null {
  return safeStageId(stageId) ? path.join(draftsDir(), `${stageId}.json`) : null;
}

const locks = new Map<string, Promise<void>>();

async function withStageLock<T>(stageId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(stageId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(stageId, prev.then(() => current));
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (locks.get(stageId) === current) locks.delete(stageId);
  }
}

async function readStage(stageId: string): Promise<SceneDraft[]> {
  const file = stagePath(stageId);
  if (!file) return [];
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf-8')) as SceneDraft[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    log.warn('Failed to read scene drafts:', error);
    return [];
  }
}

async function writeStage(stageId: string, drafts: SceneDraft[]): Promise<void> {
  const file = stagePath(stageId);
  if (!file) return;
  if (drafts.length === 0) {
    await fs.rm(file, { force: true }).catch(() => undefined);
    return;
  }
  await writeJsonFileAtomic(file, drafts);
}

/** Sweep abandoned drafts across all stages. */
export async function sweepStaleSceneDrafts(): Promise<void> {
  try {
    const names = await fs.readdir(draftsDir()).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const stageId = name.slice(0, -'.json'.length);
      if (!safeStageId(stageId)) continue;
      await withStageLock(stageId, async () => {
        const drafts = await readStage(stageId);
        const live = drafts.filter((draft) => !isStaleDraft(draft));
        if (live.length !== drafts.length) await writeStage(stageId, live);
      });
    }
  } catch (error) {
    log.warn('Failed to sweep stale scene drafts:', error);
  }
}

/** All usable drafts for a stage, keyed by outline id. */
export async function loadSceneDrafts(stageId: string): Promise<Map<string, SceneDraft>> {
  await sweepStaleSceneDrafts();
  const drafts = await readStage(stageId);
  return new Map(drafts.map((draft) => [draft.outlineId, draft]));
}

/** Store a partial payload, merging and evacuating under a per-stage lock. */
export async function saveSceneDraft(
  stageId: string,
  outlineId: string,
  payload: SceneDraftPayload,
): Promise<void> {
  if (!stagePath(stageId) || !/^[A-Za-z0-9_-]+$/.test(outlineId)) return;
  try {
    await withStageLock(stageId, async () => {
      const drafts = await readStage(stageId);
      const id = sceneDraftId(stageId, outlineId);
      const existing = drafts.find((draft) => draft.id === id);
      const merged = mergeSceneDraft(existing, stageId, outlineId, payload);
      const next = drafts.filter((draft) => draft.id !== id);
      next.push(merged);
      await writeStage(stageId, pruneSceneDrafts(next));
    });
  } catch (error) {
    log.warn('Failed to save scene draft:', error);
  }
}

export async function deleteSceneDraft(stageId: string, outlineId: string): Promise<void> {
  await withStageLock(stageId, async () => {
    const drafts = await readStage(stageId);
    const id = sceneDraftId(stageId, outlineId);
    const next = drafts.filter((draft) => draft.id !== id);
    if (next.length !== drafts.length) await writeStage(stageId, next);
  });
}

export async function clearSceneDraftsForStage(stageId: string): Promise<void> {
  await withStageLock(stageId, () => writeStage(stageId, []));
}
