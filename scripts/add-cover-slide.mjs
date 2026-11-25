/**
 * One-off backfill: add one graphic opening slide to an existing course.
 *
 * It prepends a single scene and leaves every existing scene untouched; the
 * document store keeps a .bak of the pre-change version.
 *
 *   node scripts/add-cover-slide.mjs --stage-id 6Df-YFatt3 \
 *     --model opencode:opencode-go/hy4-flash-free
 */
import fs from 'node:fs';
import path from 'node:path';

import { ensureCoverSlide } from './lib/cover-slide.mjs';

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
const modelHeaders = {
  'content-type': 'application/json',
  'x-model': model,
  'x-provider-type': 'openai',
  'x-base-url': 'http://127.0.0.1:8787/v1',
  authorization: `Bearer ${token}`,
  'x-learner-key': 'local',
};

// Title and description come from the course itself, so the backfill never
// invents course content or depends on the original creation parameters.
const response = await fetch(
  `${base}/api/persistence/documents/${encodeURIComponent(stageId)}`,
  { headers: { authorization: `Bearer ${token}`, 'x-learner-key': 'local' } },
);
if (!response.ok) throw new Error(`document read failed: ${response.status}`);
const payload = await response.json();
const document = payload.document ?? payload.data ?? payload;
const title = arg('--title') || document.stage?.name || stageId;
const description = arg('--description') || document.outline?.requirement || '';

const cover = await ensureCoverSlide({
  base,
  token,
  stageId,
  title,
  description,
  modelHeaders,
  imagePrompt: arg('--prompt') || undefined,
});
console.log(JSON.stringify({ stageId, title, ...cover }));
