import { JsonFileDocumentStore } from '@openmaic/storage/server/file-document-store';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import {
  getCourseGitScheduler,
  type CourseGitCommitScheduler,
} from '@/lib/persistence/git-course-sync';
import { GitSyncDocumentStore } from '@/lib/persistence/git-sync-document-store';

/**
 * The one construction path for the course-backed document store used by the
 * maintenance routes: file backend + app validators + the git snapshot
 * scheduler. Keeping it in a single place means every route reads and writes
 * through the same persistence contract (validation, atomic writes, per-path
 * serialization, snapshot debounce) instead of hand-rolling its own
 * composition — the kind of drift that silently drops a guarantee.
 */
export function createCourseDocumentStore(
  fileDir: string,
  scheduler: CourseGitCommitScheduler = getCourseGitScheduler(fileDir),
): GitSyncDocumentStore {
  return new GitSyncDocumentStore(
    new JsonFileDocumentStore({
      dir: fileDir,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    }),
    scheduler,
  );
}
