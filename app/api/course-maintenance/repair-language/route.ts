import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { isMaintenanceUnauthorized } from '@/lib/server/maintenance-auth';

export const runtime = 'nodejs';

const CJK_RE = /[\u4e00-\u9fff]{2,}/;
const DEFAULT_DIRECTIVE =
  'Teach the entire course in English. Write all learner-facing text, widget labels, button copy, narration and explanations in English.';

/**
 * Regenerate the learner-facing content of scenes whose text drifted into the
 * wrong language, in place. Unlike a scoped continuation this does not delete
 * scenes and does not need a generation slot - it is safe to run while the
 * regular job is still producing other outlines.
 */
export async function POST(request: Request): Promise<Response> {
  if (isMaintenanceUnauthorized(request)) return apiError('UNAUTHENTICATED', 401, 'Unauthorized');
  const body = (await request.json().catch(() => ({}))) as {
    courseId?: string;
    sceneIds?: string[];
    languageDirective?: string;
  };
  const courseId = body.courseId?.trim() ?? '';
  if (!/^[A-Za-z0-9_-]+$/.test(courseId)) {
    return apiError('INVALID_REQUEST', 400, 'A valid courseId is required');
  }
  const dir = process.env.PERSISTENCE_DIR;
  if (!dir) return apiError('INVALID_REQUEST', 400, 'Only the file-backed store is supported');

  const directive = body.languageDirective?.trim() || DEFAULT_DIRECTIVE;
  const forwarded: Record<string, string> = {};
  for (const [name, value] of request.headers.entries()) {
    if (name.startsWith('x-') && !/key|token|secret/i.test(name)) forwarded[name] = value;
  }

  try {
    const { JsonFileDocumentStore } = await import('@openmaic/storage/server/file-document-store');
    const store = new JsonFileDocumentStore({
      dir,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    });
    const document = await store.loadDocument(courseId);
    if (!document) return apiError('INVALID_REQUEST', 404, 'Course not found');

    const outlines = new Map(
      ((document.outline as { outlines?: Array<Record<string, unknown>> } | undefined)?.outlines ??
        []).map((outline) => [String(outline.id), outline]),
    );
    const wanted = Array.isArray(body.sceneIds) ? new Set(body.sceneIds) : null;
    const targets = document.scenes.filter((scene) => {
      if (wanted && !wanted.has(scene.id)) return false;
      return CJK_RE.test(JSON.stringify(scene));
    });

    let repaired = 0;
    const failed: string[] = [];
    const reasons: Record<string, string> = {};
    for (const scene of targets) {
      const outline = outlines.get(String((scene as unknown as { outlineId?: string }).outlineId ?? ''));
      if (!outline) {
        failed.push(scene.id);
        continue;
      }
      try {
        const payload = JSON.stringify({
          outline,
          allOutlines: [...outlines.values()],
          stageId: courseId,
          languageDirective: directive,
        });
        const origin = new URL(request.url);
        const target = new URL('/api/generate/scene-content', origin);
        const transport = target.protocol === 'https:' ? httpsRequest : httpRequest;
        const result = await new Promise<{ status: number; text: string }>((resolve, reject) => {
          const req = transport(
            target,
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
                ...forwarded,
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
          req.on('error', reject);
          req.end(payload);
        });
        if (result.status !== 200) {
          failed.push(scene.id);
          reasons[scene.id] = `generation HTTP ${result.status}: ${result.text.slice(0, 120)}`;
          continue;
        }
        const parsed = JSON.parse(result.text) as { success?: boolean; content?: unknown };
        if (!parsed.success || !parsed.content) {
          failed.push(scene.id);
          reasons[scene.id] = 'generation returned no content';
          continue;
        }
        if (CJK_RE.test(JSON.stringify(parsed.content))) {
          failed.push(scene.id);
          reasons[scene.id] = 'regenerated content still contains CJK';
          continue;
        }
        // The generation response is a content payload, not a full scene: it
        // can omit `type`. Restore the scene's own type so the DSL validator
        // can match content to scene before the in-place write.
        const nextContent = {
          ...(parsed.content as Record<string, unknown>),
          type: (parsed.content as { type?: unknown }).type ?? (scene.content as { type?: unknown }).type,
        };
        await store.putScene(courseId, { ...scene, content: nextContent } as never);
        repaired += 1;
      } catch (error) {
        failed.push(scene.id);
        reasons[scene.id] = error instanceof Error ? error.message.slice(0, 160) : String(error);
      }
    }
    return apiSuccess({ courseId, scanned: targets.length, repaired, failed, reasons });
  } catch (error) {
    return apiError(
      'INTERNAL_ERROR',
      500,
      'Language repair failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}
