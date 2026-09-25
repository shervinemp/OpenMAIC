import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { createLogger } from '@/lib/logger';

const log = createLogger('CourseHistoryLog');

/**
 * Append-only JSONL audit log for course lifecycle events that are NOT
 * document generations — durability-relevant operations like inbound git sync
 * applies/imports. One line per event with a UTC-ish timestamp; the file lives
 * beside the git bindings under `<PERSISTENCE_DIR>/course-git/history.jsonl`.
 *
 * Route-analysis note: this complements the per-write stamps inside document
 * files, which answer "what changed"; this answers "WHO approved WHAT to
 * change and when", which document state cannot express.
 */

export async function appendCourseHistory(
  persistenceDir: string,
  event: string,
  payload: unknown,
): Promise<void> {
  const line = `${JSON.stringify({ at: new Date().toISOString(), event, ...(payload as object) })}\n`;
  try {
    const dir = join(persistenceDir, 'course-git');
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, 'history.jsonl'), line, 'utf8');
  } catch (error) {
    log.warn('Failed to append course history entry:', error);
  }
}
