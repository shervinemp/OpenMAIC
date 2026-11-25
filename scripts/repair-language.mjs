/**
 * Regenerate learner-visible scenes whose widget text came back in the wrong
 * language. Removes only the affected scenes and starts a scoped job so every
 * other committed scene is untouched.
 *
 *   node scripts/repair-language.mjs --stage-id 6Df-YFatt3 \
 *     --model opencode:opencode-go/hy4-flash-free
 */
import fs from 'node:fs';
import path from 'node:path';

const arg = (name, fallback = '') => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? fallback : fallback;
};
const root = process.cwd();
const stageId = arg('--stage-id');
if (!stageId) throw new Error('--stage-id is required');
const model = arg('--model', 'opencode:opencode-go/hy4-flash-free');
const base = 'http://127.0.0.1:3000';
const token = /^PERSISTENCE_DEV_TOKEN=(.+)$/m
  .exec(fs.readFileSync(path.join(root, '.env.local'), 'utf8'))[1]
  .trim();
const headers = {
  'content-type': 'application/json',
  authorization: `Bearer ${token}`,
  'x-learner-key': 'local',
};

const response = await fetch(`${base}/api/persistence/documents/${encodeURIComponent(stageId)}`, {
  headers,
});
if (!response.ok) throw new Error(`document read failed: ${response.status}`);
const payload = await response.json();
const doc = payload.document ?? payload.data ?? payload;
const cjk = /[\u4e00-\u9fff]{2,}/;
const bad = doc.scenes.filter((scene) => cjk.test(JSON.stringify(scene)));
if (!bad.length) {
  console.log(JSON.stringify({ stageId, repaired: 0 }));
  process.exit(0);
}
const ids = [...new Set(bad.map((scene) => scene.outlineId).filter(Boolean))];
if (!ids.length) throw new Error('affected scenes have no outlineId');
const before = doc.scenes.length;
doc.scenes = doc.scenes.filter((scene) => !ids.includes(scene.outlineId));
const now = Date.now();
doc.stage.updatedAt = now;
doc.outline.updatedAt = now;
const saved = await fetch(`${base}/api/persistence/documents/${encodeURIComponent(stageId)}`, {
  method: 'PUT',
  headers,
  body: JSON.stringify(doc),
});
if (!saved.ok) throw new Error(`document save failed: ${saved.status}`);

const modelHeaders = {
  ...headers,
  'x-model': model,
  'x-provider-type': 'openai',
  'x-base-url': 'http://127.0.0.1:8787/v1',
  'x-user-locale': 'en-US',
};
const started = await fetch(`${base}/api/generation/continue`, {
  method: 'POST',
  headers: modelHeaders,
  body: JSON.stringify({
    stageId,
    outlineIds: ids,
    includeFailed: true,
    languageDirective:
      'Deliver all learner-visible content strictly in English. Use English labels, titles, node text and explanations throughout, with no Chinese characters.',
  }),
});
if (!started.ok) throw new Error(`job start failed: ${started.status} ${(await started.text()).slice(0, 300)}`);
console.log(
  JSON.stringify({
    stageId,
    removed: before - doc.scenes.length,
    outlines: ids.length,
    jobId: (await started.json()).jobId,
  }),
);
