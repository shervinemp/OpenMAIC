import type { DocumentStore, MaicDocument } from '@openmaic/storage';

import type { CourseGitCommitScheduler } from '@/lib/persistence/git-course-sync';
import type { Scene, Stage } from '@/lib/types/stage';

type BaseStore = DocumentStore<Scene, Stage>;

/**
 * Decorator that schedules a debounced git commit into the course's bound
 * repository after every mutation that can change an aggregate. Read paths
 * are passed through untouched.
 *
 * The decorator is fail-open by construction: scheduling a commit never
 * throws, and the scheduler never rethrows git failures — a repository that
 * is offline, read-only, or mid-rebase can only cost the commit, never the
 * course write. `loadDocument` is the snapshot source at commit time, which
 * also means the repo always records the migrated document shape.
 */
export class GitSyncDocumentStore implements BaseStore {
  constructor(
    private readonly inner: BaseStore,
    private readonly scheduler: CourseGitCommitScheduler,
  ) {}

  private schedule(stageId: string, reason: string): void {
    this.scheduler.schedule(stageId, reason, async () => this.inner.loadDocument(stageId));
  }

  async saveDocument(
    doc: MaicDocument<Scene, Stage>,
    options?: Parameters<BaseStore['saveDocument']>[1],
  ): Promise<void> {
    await this.inner.saveDocument(doc, options);
    this.schedule(doc.stage.id, `save course (${doc.scenes.length} pages)`);
  }

  async loadDocument(stageId: string): Promise<MaicDocument<Scene, Stage> | null> {
    return this.inner.loadDocument(stageId);
  }

  listDocuments() {
    return this.inner.listDocuments();
  }

  async deleteDocument(stageId: string): Promise<void> {
    await this.inner.deleteDocument(stageId);
    this.schedule(stageId, 'delete course');
  }

  async putStage(stageId: string, stage: Stage): Promise<void> {
    await this.inner.putStage(stageId, stage);
    this.schedule(stageId, `update stage "${stage.name}"`);
  }

  async putScene(stageId: string, scene: Scene): Promise<void> {
    await this.inner.putScene(stageId, scene);
    this.schedule(stageId, `upsert page ${JSON.stringify(scene.order)} "${scene.title}"`);
  }

  getScene(stageId: string, sceneId: string) {
    return this.inner.getScene(stageId, sceneId);
  }

  async deleteScene(stageId: string, sceneId: string): Promise<void> {
    await this.inner.deleteScene(stageId, sceneId);
    this.schedule(stageId, `delete page ${JSON.stringify(sceneId)}`);
  }
}
