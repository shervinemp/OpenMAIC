/**
 * Server-side cover slide creation.
 *
 * The browser normally turns an outline's `gen_img_*` placeholder into a real
 * asset. Backend-generated courses have no browser, so this module performs the
 * same three steps over the app's own HTTP APIs: ask the LLM for a slide that
 * uses one generated image, render that image, allocate it in the asset pool,
 * then prepend the finished scene to the document. It is shared by new-course
 * creation and the one-off backfill for courses that already exist.
 */
import { randomBytes } from 'node:crypto';

const COVER_OUTLINE_PREFIX = 'cover-outline-';

function replaceRefs(value, from, to) {
  if (typeof value === 'string') return value.split(from).join(to);
  if (Array.isArray(value)) return value.map((item) => replaceRefs(item, from, to));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceRefs(item, from, to)]),
    );
  }
  return value;
}

async function jsonRequest(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }
  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${url} -> ${response.status} ${text.slice(0, 300)}`);
  }
  return payload;
}

async function fetchImageBytes(result) {
  if (result.base64) {
    return {
      bytes: Buffer.from(result.base64, 'base64'),
      mimeType: result.mimeType || 'image/png',
    };
  }
  const url = result.ossUrl || result.url;
  if (!url) throw new Error('image provider returned neither bytes nor a URL');
  const response = await fetch(url);
  if (!response.ok) throw new Error(`image download failed: ${response.status}`);
  const mimeType = result.mimeType || response.headers.get('content-type') || 'image/png';
  return { bytes: Buffer.from(await response.arrayBuffer()), mimeType };
}

async function allocateAsset(base, token, bytes, mimeType) {
  const form = new FormData();
  form.set(
    'meta',
    new Blob([JSON.stringify({ origin: 'cover-slide' })], { type: 'application/json' }),
    'meta.json',
  );
  form.set('bytes', new Blob([bytes], { type: mimeType }), 'cover');
  const response = await fetch(`${base}/api/persistence/assets`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  if (response.status !== 201) {
    throw new Error(`asset allocation failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
  }
  const body = await response.json();
  if (typeof body.id !== 'string' || !body.id) throw new Error('asset allocation returned no id');
  return body.id;
}

function coverOutline({ stageId, title, description, imagePrompt }) {
  return {
    id: `${COVER_OUTLINE_PREFIX}${stageId}`,
    type: 'slide',
    title,
    description:
      `Opening visual overview of "${title}". Use one large generated hero image as the focal point, ` +
      `with a short title and a single line that frames what the learner will gain. ${description}`,
    keyPoints: [title, 'Course roadmap', 'What you will be able to do'],
    order: -1,
    lessonId: 'opening',
    mediaGenerations: [
      {
        type: 'image',
        elementId: 'gen_img_1',
        prompt: imagePrompt,
        aspectRatio: '16:9',
      },
    ],
  };
}

/**
 * Generate one cover slide and prepend it to a course document. Idempotent by
 * outline id, so re-running never adds a second cover.
 */
export async function ensureCoverSlide({
  base,
  token,
  stageId,
  title,
  description = '',
  modelHeaders,
  imagePrompt,
}) {
  const persistenceHeaders = {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    'x-learner-key': 'local',
  };
  const documentPayload = await jsonRequest(
    `${base}/api/persistence/documents/${encodeURIComponent(stageId)}`,
    { headers: persistenceHeaders },
  );
  const document = documentPayload.document ?? documentPayload.data ?? documentPayload;
  const outlineId = `${COVER_OUTLINE_PREFIX}${stageId}`;
  const existing = document.scenes?.find((scene) => scene.outlineId === outlineId);
  if (existing) return { created: false, sceneId: existing.id };

  const outline = coverOutline({
    stageId,
    title,
    description,
    imagePrompt:
      imagePrompt ||
      `A cinematic, clean editorial illustration representing "${title}". ` +
        `Bold geometric composition, layered depth, calm academic palette, no text, no letters, ` +
        `no numbers, wide 16:9 framing with a clear visual focal point.`,
  });

  const contentResult = await jsonRequest(`${base}/api/generate/scene-content`, {
    method: 'POST',
    headers: modelHeaders,
    body: JSON.stringify({
      outline,
      allOutlines: [outline],
      stageId,
      languageDirective: '',
      userProfile: '',
    }),
    signal: AbortSignal.timeout(30 * 60_000),
  });
  // scene-content returns the canvas itself; scene-actions wraps it into the
  // final scene.content = { type, canvas }, so do not wrap it here.
  const content = contentResult.content;
  if (!content || !Array.isArray(content.elements)) {
    throw new Error(`cover content had no canvas elements: ${JSON.stringify(content).slice(0, 200)}`);
  }

  const actionsResult = await jsonRequest(`${base}/api/generate/scene-actions`, {
    method: 'POST',
    headers: modelHeaders,
    body: JSON.stringify({
      outline,
      allOutlines: [outline],
      content,
      stageId,
      previousSpeeches: [],
      languageDirective: '',
      userProfile: '',
    }),
    signal: AbortSignal.timeout(30 * 60_000),
  });
  if (!actionsResult.scene) throw new Error('cover actions returned no scene');

  const imageResult = await jsonRequest(`${base}/api/generate/image`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: outline.mediaGenerations[0].prompt,
      aspectRatio: '16:9',
      width: 1280,
      height: 720,
    }),
    signal: AbortSignal.timeout(45 * 60_000),
  });
  if (!imageResult.result) throw new Error('image generation returned no result');
  const { bytes, mimeType } = await fetchImageBytes(imageResult.result);
  const assetId = await allocateAsset(base, token, bytes, mimeType);

  const scene = replaceRefs(actionsResult.scene, 'gen_img_1', assetId);
  scene.type = 'slide';
  const orders = (document.scenes ?? []).map((item) => Number(item.order ?? 0));
  scene.id = `cover_${randomBytes(9).toString('base64url')}`;
  scene.stageId = stageId;
  scene.outlineId = outlineId;
  scene.type = 'slide';
  scene.order = orders.length ? Math.min(...orders) - 1 : 0;
  scene.title = title;
  scene.createdAt = Date.now();
  scene.updatedAt = Date.now();

  document.scenes = [scene, ...(document.scenes ?? [])];
  document.stage.updatedAt = Date.now();
  if (document.outline) document.outline.updatedAt = Date.now();
  const saved = await fetch(`${base}/api/persistence/documents/${encodeURIComponent(stageId)}`, {
    method: 'PUT',
    headers: persistenceHeaders,
    body: JSON.stringify(document),
  });
  if (!saved.ok) {
    throw new Error(`document save failed: ${saved.status} ${(await saved.text()).slice(0, 300)}`);
  }
  return { created: true, sceneId: scene.id, assetId, imageBytes: bytes.length };
}
