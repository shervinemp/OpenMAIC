import { JsonFileDocumentStore } from '@openmaic/storage/server/file-document-store';
import type { DocumentStore } from '@openmaic/storage';
import { createLogger } from '@/lib/logger';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import type { AppStage } from '@/lib/document-store/persistence-types';
import type { Scene as AppScene } from '@/lib/types/stage';
import type { Action } from '@/lib/types/action';
import type { SceneOutline } from '@/lib/types/generation';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { putSceneBringingCurrent } from '@/lib/server/agent-runtime/document-writes';
import { synthesizeSceneNarration } from '@/lib/server/agent-runtime/scene-tts';
import {
  createContinueJob,
  deleteContinueJobInput,
  findInterruptedContinueJobs,
  readContinueJob,
  readContinueJobInput,
  updateContinueJob,
  type ContinueJobInput,
} from './store';

const log = createLogger('ContinueGeneration');

type Store = DocumentStore<AppScene, AppStage>;

/** In-flight jobs, so DELETE can abort them. */
const active = new Map<string, AbortController>();
const running = new Set<string>();

export function cancelContinueJob(jobId: string): boolean {
  const controller = active.get(jobId);
  if (!controller) return false;
  controller.abort();
  return true;
}

/**
 * Mark a course as server-owned for the lifetime of a continuation job. The
 * classroom's auto-resume guard reads this and will not start a competing
 * browser generator while the backend is producing the remaining scenes.
 */
async function setProducer(store: Store, stageId: string, jobId: string | null): Promise<void> {
  const document = await store.loadDocument(stageId);
  if (!document) return;
  const outline = { ...(document.outline as Record<string, unknown>) };
  if (jobId) {
    outline.producer = 'server-job';
    outline.producerRef = jobId;
  } else {
    delete outline.producer;
    delete outline.producerRef;
  }
  await store.saveDocument({ ...document, outline });
}

async function openDocumentStore(input: ContinueJobInput): Promise<Store> {
  const fileDir = process.env.PERSISTENCE_DIR;
  if (fileDir) {
    return new JsonFileDocumentStore({
      dir: fileDir,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    }) as unknown as Store;
  }
  return getOwnerScopedDocumentStore(input.ownerId) as unknown as Store;
}

interface ApiResult {
  success?: boolean;
  error?: string;
  scene?: AppScene;
  [key: string]: unknown;
}

async function postInternal(
  baseUrl: string,
  pathname: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ApiResult> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });
  const data = (await response.json().catch(() => ({}))) as ApiResult;
  if (!response.ok) {
    throw new Error(data.error || `Internal generation call failed (${response.status})`);
  }
  return data;
}

/**
 * Generate the missing scenes of an EXISTING course on the server, so a run
 * survives browser tabs closing. Content and actions go through the same
 * /api/generate routes the browser uses (so all depth/citation gates apply);
 * narration uses the server's configured TTS provider; each scene is committed
 * to the document store immediately, so progress is durable scene by scene.
 */
export async function runContinueGenerationJob(
  jobId: string,
  input: ContinueJobInput,
  headers: Record<string, string> = {},
): Promise<void> {
  if (running.has(jobId)) return;
  running.add(jobId);
  const controller = new AbortController();
  active.set(jobId, controller);
  const signal = controller.signal;
  let store: Store | undefined;

  try {
    const current = await readContinueJob(jobId);
    if (!current || current.status === 'cancelled') return;
    await updateContinueJob(jobId, {
      status: 'running',
      startedAt: current.startedAt ?? new Date().toISOString(),
      message: 'Loading course',
    });

    store = await openDocumentStore(input);
    await setProducer(store, input.stageId, jobId);
    const document = await store.loadDocument(input.stageId);
    if (!document) throw new Error(`Course ${input.stageId} not found`);

    const outlines: SceneOutline[] = (
      (document.outline as { outlines?: SceneOutline[] } | undefined)?.outlines ?? []
    ) as SceneOutline[];
    const byOutlineId = new Set(document.scenes.map((scene) => scene.outlineId).filter(Boolean));
    const byOrder = new Set(document.scenes.map((scene) => scene.order));
    const pending = outlines
      .filter((outline) => !byOutlineId.has(outline.id) && !byOrder.has(outline.order))
      .sort((a, b) => a.order - b.order);

    await updateContinueJob(jobId, {
      totalScenes: pending.length,
      message: `Generating ${pending.length} scene(s)`,
    });

    log.info(`Job ${jobId}: entering scene loop, ${pending.length} pending`);
    let generated = 0;
    let failed = 0;
    let previousSpeeches: string[] = [];
    const lastScene = [...document.scenes].sort((a, b) => b.order - a.order)[0];
    if (lastScene) {
      previousSpeeches = (lastScene.actions ?? [])
        .filter((action): action is Action => action.type === 'speech' && 'text' in action)
        .map((action) => String((action as { text?: string }).text ?? ''))
        .filter(Boolean);
    }

    for (const outline of pending) {
      if (signal.aborted) throw new Error('aborted');
      log.info(`Job ${jobId}: content for "${outline.title}"`);

      let contentResult: ApiResult;
      try {
        contentResult = await postInternal(
          input.baseUrl,
          '/api/generate/scene-content',
          headers,
          {
            outline,
            allOutlines: outlines,
            stageId: input.stageId,
            languageDirective: input.languageDirective,
            userProfile: input.userProfile,
            ...(input.taskEngineMode ? { requirements: { taskEngineMode: true } } : {}),
          },
          signal,
        );
      } catch (error) {
        if (signal.aborted) throw error;
        failed += 1;
        log.warn(`Content failed for "${outline.title}":`, error);
        await updateContinueJob(jobId, {
          scenesFailed: failed,
          message: `Content failed for: ${outline.title}`,
        });
        continue;
      }
      if (!contentResult.success || contentResult.content == null) {
        failed += 1;
        await updateContinueJob(jobId, {
          scenesFailed: failed,
          message: `Content failed for: ${outline.title}`,
        });
        continue;
      }

      log.info(`Job ${jobId}: actions for "${outline.title}"`);
      let actionsResult: ApiResult;
      try {
        actionsResult = await postInternal(
          input.baseUrl,
          '/api/generate/scene-actions',
          headers,
          {
            outline,
            allOutlines: outlines,
            content: contentResult.content,
            stageId: input.stageId,
            previousSpeeches,
            languageDirective: input.languageDirective,
            userProfile: input.userProfile,
          },
          signal,
        );
      } catch (error) {
        if (signal.aborted) throw error;
        failed += 1;
        log.warn(`Actions failed for "${outline.title}":`, error);
        await updateContinueJob(jobId, {
          scenesFailed: failed,
          message: `Actions failed for: ${outline.title}`,
        });
        continue;
      }
      const scene = actionsResult.scene;
      if (!actionsResult.success || !scene) {
        failed += 1;
        await updateContinueJob(jobId, {
          scenesFailed: failed,
          message: `Actions failed for: ${outline.title}`,
        });
        continue;
      }

      scene.stageId = input.stageId;
      scene.order = outline.order;
      if (!scene.outlineId) scene.outlineId = outline.id;

      if (input.enableTTS !== false) {
        try {
          const narration = await synthesizeSceneNarration({ scene, force: false, signal });
          if (narration.generated > 0) log.info(`Narrated ${outline.title}: ${narration.generated}`);
        } catch (error) {
          if (signal.aborted) throw error;
          log.warn(`Narration failed for "${outline.title}":`, error);
        }
      }

      await putSceneBringingCurrent(store, input.stageId, scene);
      generated += 1;
      previousSpeeches = (scene.actions ?? [])
        .filter((action): action is Action => action.type === 'speech' && 'text' in action)
        .map((action) => String((action as { text?: string }).text ?? ''))
        .filter(Boolean);
      await updateContinueJob(jobId, {
        scenesGenerated: generated,
        scenesFailed: failed,
        message: `${generated}/${pending.length}: ${outline.title}`,
      });
    }

    if (signal.aborted) throw new Error('aborted');

    // Reload before marking complete: scene writes and this flag commit in
    // separate operations, so saving the original snapshot would drop them.
    if (failed === 0) {
      const finalDocument = await store.loadDocument(input.stageId);
      if (finalDocument) {
        await store.saveDocument({
          ...finalDocument,
          outline: {
            ...(finalDocument.outline as Record<string, unknown>),
            generationComplete: true,
          },
        });
      }
    }
    await setProducer(store, input.stageId, null);
    await updateContinueJob(jobId, {
      status: 'succeeded',
      completedAt: new Date().toISOString(),
      message: `Finished: ${generated} scene(s), ${failed} failure(s)`,
    });
    await deleteContinueJobInput(jobId);
    log.info(`Continue job ${jobId} finished for ${input.stageId}`);
  } catch (error) {
    const aborted = signal.aborted;
    if (store) await setProducer(store, input.stageId, null).catch(() => undefined);
    await updateContinueJob(jobId, {
      status: aborted ? 'cancelled' : 'failed',
      completedAt: new Date().toISOString(),
      error: aborted ? undefined : error instanceof Error ? error.message : String(error),
      message: aborted ? 'Cancelled' : 'Failed',
    });
    if (!aborted) log.error(`Continue job ${jobId} failed:`, error);
  } finally {
    active.delete(jobId);
    running.delete(jobId);
  }
}

/** Requeue jobs that were running when the process died. Credentials are not
 * persisted, so recovery relies on server-configured model routes. */
export async function recoverInterruptedContinueJobs(baseUrl: string): Promise<number> {
  const interrupted = await findInterruptedContinueJobs();
  let recovered = 0;
  for (const job of interrupted) {
    const input = await readContinueJobInput(job.id);
    if (!input) {
      await updateContinueJob(job.id, {
        status: 'failed',
        error: 'Input unavailable after restart; resume from the UI',
      });
      continue;
    }
    const attempts = (job.resumeCount ?? 0) + 1;
    if (attempts > 2) {
      await updateContinueJob(job.id, {
        status: 'failed',
        error: 'Generation interrupted too many times; resume from the UI',
      });
      continue;
    }
    await updateContinueJob(job.id, { status: 'queued', resumeCount: attempts });
    void runContinueGenerationJob(job.id, { ...input, baseUrl });
    recovered += 1;
  }
  return recovered;
}

/** Used by tests and callers that need a fresh job record without an HTTP request. */
export { createContinueJob };
