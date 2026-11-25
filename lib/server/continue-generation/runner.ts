import type { DocumentStore } from '@openmaic/storage';
import { createLogger } from '@/lib/logger';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import type { AppStage } from '@/lib/document-store/persistence-types';
import type { Scene as AppScene } from '@/lib/types/stage';
import type { Action } from '@/lib/types/action';
import type { SceneOutline } from '@/lib/types/generation';
import { putSceneBringingCurrent } from '@/lib/server/agent-runtime/document-writes';
import {
  clearSceneDraftsForStage,
  deleteSceneDraft,
  loadSceneDrafts,
  saveSceneDraft,
} from '@/lib/server/scene-draft-store';
import { sceneDraftSourceKey } from '@/lib/utils/scene-draft-key';
import { synthesizeSceneNarration } from '@/lib/server/agent-runtime/scene-tts';
import { resolveSceneMedia } from '@/lib/server/scene-media-generation';
import {
  applyRelayoutMoves,
  computeRelayoutPlan,
  sanitizeSceneCanvas,
} from '@/lib/maintenance/layout-relayout';
import { applyLayoutPatch } from '@/lib/slides/slide-layout-verify';
import { sanitizeSlidePlacement, validateSlidePlacement } from '@openmaic/dsl';
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

/**
 * In-flight jobs, so DELETE can abort them and a second dispatch cannot start a
 * second loop. Kept on globalThis: Next dev hot-reloads modules, and a fresh
 * module instance with an empty guard would otherwise race the old loop.
 */
const generationState = ((globalThis as typeof globalThis & {
  __openmaicContinueGeneration?: {
    active: Map<string, AbortController>;
    running: Set<string>;
  };
}).__openmaicContinueGeneration ??= {
  active: new Map<string, AbortController>(),
  running: new Set<string>(),
});
const active = generationState.active;
const running = generationState.running;

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
    // Dynamic import: this subpath is ESM-only and the detached worker runs
    // through tsx's CJS loader, which cannot resolve import-only exports.
    const { JsonFileDocumentStore } = await import('@openmaic/storage/server/file-document-store');
    return new JsonFileDocumentStore({
      dir: fileDir,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    }) as unknown as Store;
  }
  const { getOwnerScopedDocumentStore } = await import(
    '@/lib/server/agent-runtime/owner-scoped-documents'
  );
  return getOwnerScopedDocumentStore(input.ownerId) as unknown as Store;
}

interface ApiResult {
  success?: boolean;
  error?: string;
  scene?: AppScene;
  [key: string]: unknown;
}

/**
 * Internal generate calls can take longer than undici's default 5-minute
 * headers timeout with a slow free model. node:http has no such default, so
 * use it directly and only abort on our own job signal.
 */
async function postInternal(
  baseUrl: string,
  pathname: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ApiResult> {
  const { request } = await import('node:http');
  const { request: httpsRequest } = await import('node:https');
  const url = new URL(pathname, baseUrl);
  const payload = JSON.stringify(body);
  const transport = url.protocol === 'https:' ? httpsRequest : request;

  const result = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = transport(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 500, text: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', reject);
      },
    );
    const abort = () => req.destroy(new Error('aborted'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    req.on('close', () => signal.removeEventListener('abort', abort));
    req.on('error', reject);
    req.end(payload);
  });

  let data: ApiResult = {};
  try {
    data = JSON.parse(result.text) as ApiResult;
  } catch {
    /* non-JSON error body */
  }
  if (result.status < 200 || result.status >= 300) {
    throw new Error(data.error || `Internal generation call failed (${result.status})`);
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
    // A scoped retry names the outlines to redo (they may already have a scene
    // from a failed pass); an ordinary run fills only missing outlines.
    const scope = input.outlineIds?.length ? new Set(input.outlineIds) : null;
    const pending = outlines
      .filter((outline) =>
        scope
          ? scope.has(outline.id)
          : !byOutlineId.has(outline.id) && !byOrder.has(outline.order),
      )
      .sort((a, b) => a.order - b.order);

    await updateContinueJob(jobId, {
      totalScenes: pending.length,
      message: `Generating ${pending.length} scene(s)`,
    });

    // One shared draft cache for both engines. Reuse is safe only when the
    // fingerprint still matches; the payload still runs gates, TTS and media.
    const drafts = await loadSceneDrafts(input.stageId);
    const stageInfo = (document.stage ?? {}) as unknown as Record<string, unknown>;
    const draftKeyFor = (outline: SceneOutline): string =>
      sceneDraftSourceKey({
        stageId: input.stageId,
        outline,
        languageDirective: input.languageDirective,
        userProfile: input.userProfile,
        model: headers['x-model'] ?? '',
        taskEngineMode: input.taskEngineMode,
        // The server job has no browser PDF images or agent roster; drafts
        // created with those inputs simply won't match and are regenerated.
        pdfImagesCount: 0,
        stageName: typeof stageInfo.name === 'string' ? stageInfo.name : undefined,
        stageDescription: typeof stageInfo.description === 'string' ? stageInfo.description : undefined,
        stageStyle: typeof stageInfo.style === 'string' ? stageInfo.style : undefined,
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

      const draftKey = draftKeyFor(outline);
      const draft = drafts.get(outline.id);
      const contentDraft = draft?.sourceKey === draftKey ? draft.content : undefined;
      let contentResult: ApiResult;
      if (contentDraft !== undefined) {
        contentResult = contentDraft as ApiResult;
        log.info(`Job ${jobId}: reused content draft for "${outline.title}"`);
      } else {
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
      }
      if (!contentResult.success || contentResult.content == null) {
        failed += 1;
        await updateContinueJob(jobId, {
          scenesFailed: failed,
          message: `Content failed for: ${outline.title}`,
        });
        continue;
      }
      if (contentDraft === undefined) {
        await saveSceneDraft(input.stageId, outline.id, {
          sourceKey: draftKey,
          content: contentResult,
        });
      }

      log.info(`Job ${jobId}: actions for "${outline.title}"`);
      const actionsDraft = draft?.sourceKey === draftKey ? draft.actions : undefined;
      let actionsResult: ApiResult;
      if (actionsDraft !== undefined) {
        actionsResult = actionsDraft as ApiResult;
        log.info(`Job ${jobId}: reused actions draft for "${outline.title}"`);
      } else {
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
      }
      let scene = actionsResult.scene;
      if (!actionsResult.success || !scene) {
        failed += 1;
        await updateContinueJob(jobId, {
          scenesFailed: failed,
          message: `Actions failed for: ${outline.title}`,
        });
        continue;
      }

      // Backend jobs have no browser to run the media orchestrator, so resolve
      // this outline's gen_img_*/gen_vid_* placeholders before committing.
      try {
        const media = await resolveSceneMedia({
          scene,
          outline,
          stageId: input.stageId,
          ownerId: input.ownerId,
        });
        scene = media.scene;
        if (media.generated.length) {
          log.info(`Media for "${outline.title}": ${media.generated.join(', ')}`);
        }
      } catch (error) {
        log.warn(`Media resolution failed for "${outline.title}":`, error);
      }

      // The browser generation path runs layout checks before committing.
      // Apply the same deterministic relayout here so backend scenes do not
      // accumulate occlusions just because no tab was open.
      try {
        const plan = computeRelayoutPlan(scene);
        if (plan) {
          const moves = applyRelayoutMoves(scene, plan);
          const clamped = sanitizeSceneCanvas(scene);
          if (moves.length || clamped) {
            log.info(`Layout for "${outline.title}": ${moves.length} moved, ${clamped} clamped`);
          }
        }
      } catch (error) {
        log.warn(`Layout check failed for "${outline.title}":`, error);
      }

      // The browser also asks the LLM layout judge to move elements that the
      // deterministic pass could not separate. Fail open: an unavailable
      // judge must not discard an otherwise valid scene.
      const canvas = (scene.content as { canvas?: { elements?: unknown[] } } | undefined)?.canvas;
      if (canvas && Array.isArray(canvas.elements)) {
        const findings = validateSlidePlacement(canvas as never);
        if (findings.length) {
          try {
            const verified = await postInternal(
              input.baseUrl,
              '/api/generate/scene-verify',
              headers,
              { scene, intent: 'layout-repair', geometryFindings: findings },
              signal,
            );
            const elements = (verified as { layoutPatch?: { elements?: unknown } }).layoutPatch
              ?.elements;
            if (Array.isArray(elements) && applyLayoutPatch(canvas as never, elements as never)) {
              sanitizeSlidePlacement(canvas as never);
              log.info(`Layout judge patched "${outline.title}"`);
            }
          } catch (error) {
            log.warn(`Layout judge failed for "${outline.title}":`, error);
          }
        }
      }

      if (actionsDraft === undefined) {
        await saveSceneDraft(input.stageId, outline.id, {
          sourceKey: draftKey,
          actions: actionsResult,
        });
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
      // The raw payload is no longer needed once its scene is durable.
      await deleteSceneDraft(input.stageId, outline.id);
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
    await clearSceneDraftsForStage(input.stageId);
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
