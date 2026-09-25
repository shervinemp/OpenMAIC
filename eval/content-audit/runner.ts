import { readFileSync } from 'node:fs';
import {
  sceneContentFindings,
  splitFamilyDuplicateFindings,
} from '../../lib/maintenance/content-audit';

const FILE = process.argv[2] ?? '.data/persistence/documents/2WjD3KDIez.json';
const doc = JSON.parse(readFileSync(FILE, 'utf8')) as {
  scenes?: Array<Record<string, unknown>>;
};

const stripHtml = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const isText = (el: unknown) => (el as { type?: string }).type === 'text';
const rows = (scene: Record<string, unknown>) =>
  (
    (scene as { content?: { canvas?: { elements?: unknown[] } } }).content?.canvas?.elements ?? []
  ).filter(isText) as Array<{ id: string; content?: string; width?: number; top?: number }>;

const STOP = new Set([
  'the',
  'a',
  'an',
  'of',
  'to',
  'in',
  'is',
  'and',
  'or',
  'it',
  'you',
  'your',
  'we',
  'this',
  'that',
  'on',
  'for',
  'with',
  'as',
  'are',
  'be',
  'by',
  'from',
  'at',
  'so',
  'not',
  'have',
  'has',
  'was',
]);

// ---------- tier-1 counts ----------
const kindCounts: Record<string, { count: number; scenes: string[] }> = {};
const record = (kind: string, severity: string, sceneId: string, title: string) => {
  const key = `${kind}/${severity}`;
  const entry = (kindCounts[key] ??= { count: 0, scenes: [] });
  entry.count += 1;
  if (entry.scenes.length < 6) entry.scenes.push(title || sceneId);
};

const slides = (doc.scenes ?? []).filter((s) => s.type === 'slide');
const dupIndex = new Set(
  splitFamilyDuplicateFindings({ scenes: slides as never }).map((e) => e.sceneId),
);

for (const scene of slides) {
  const id = String(scene.id);
  const title = String(scene.title ?? '');
  for (const finding of sceneContentFindings(scene as never)) {
    record(finding.kind, finding.severity, id, title);
  }
  if (dupIndex.has(id)) {
    record('identity/cross-part-duplicate-element-id', 'warn', id, title);
  }
}

// ---------- token-free redundancy prefilter (cross-scene row shingles) ----------
const shingles = (s: string, n = 6) => {
  const words = s.split(/\s+/);
  const set = new Set<string>();
  for (let i = 0; i < words.length - n + 1; i++) set.add(words.slice(i, i + n).join(' '));
  return set;
};
const jaccard = (a: Set<string>, b: Set<string>) => {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return a.size + b.size === inter ? 1 : inter / (a.size + b.size - inter);
};

let dupPairs = 0;
const dupExamples: string[] = [];
const rowBodies = slides.map((scene) => ({
  id: String(scene.id),
  title: String(scene.title ?? ''),
  rows: rows(scene)
    .map((r) => ({ id: r.id, body: stripHtml(r.content ?? '') }))
    .filter((r) => r.body.length >= 80),
}));
const sims: Array<{ sim: number; label: string }> = [];
for (let i = 0; i < rowBodies.length; i += 1) {
  for (let j = i + 1; j < rowBodies.length; j += 1) {
    const A = rowBodies[i] ?? { rows: [] as Array<{ id: string; body: string }> };
    const B = rowBodies[j] ?? { rows: [] as Array<{ id: string; body: string }> };
    if (B.id.split('__')[0] === A.id.split('__')[0]) continue; // same family dupes counted as tier-1
    const shA = A.rows.map((r) => ({ ...r, sh: shingles(r.body) }));
    const shB = B.rows.map((r) => ({ ...r, sh: shingles(r.body) }));
    for (const x of shA) {
      for (const y of shB) {
        const sim = x.sh.size > 0 && y.sh.size > 0 ? jaccard(x.sh, y.sh) : 0;
        if (sim >= 0.4) {
          sims.push({
            sim,
            label: `[${A.title}] "${x.body.slice(0, 60)}…" vs [${B.title}] "${y.body.slice(0, 60)}…"`,
          });
          if (sim >= 0.55) {
            dupPairs += 1;
            if (dupExamples.length < 8) {
              dupExamples.push(sim.toFixed(2) + ' ' + sims[sims.length - 1]?.label);
            }
          }
        }
      }
    }
  }
}
sims.sort((a, b) => b.sim - a.sim);

// ---------- spotlight-mismatch proxy (no LLM): rare-word overlap ----------

// narrated speech vs the element its preceding spotlight highlights: count
// content words in the speech that appear in the highlighted row's text.
let mismtchCandidates = 0;
const mismatchExamples: string[] = [];
for (const scene of slides) {
  const actions = (scene.actions ?? []) as Array<{
    type?: string;
    elementId?: string;
    text?: string;
  }>;
  const bodies = new Map(rows(scene).map((r) => [r.id, stripHtml(r.content ?? '')]));
  for (let i = 0; i < actions.length; i += 1) {
    const action = actions[i];
    if (action.type !== 'spotlight' || !action.elementId) continue;
    let speech: string | undefined;
    for (let j = i - 1; j >= 0; j -= 1) {
      if (actions[j]?.type === 'speech') {
        speech = actions[j].text;
        break;
      }
    }
    if (!speech) continue;
    const target = bodies.get(action.elementId) ?? '';
    const speechWords = new Set(stripHtml(speech).split(/\s+/));
    let hit = 0;
    for (const w of target.split(/\s+/).filter((word) => word.length > 4 && !STOP.has(word))) {
      if (speechWords.has(w)) hit += 1;
    }
    if (hit === 0) {
      mismtchCandidates += 1;
      if (mismatchExamples.length < 8) {
        mismatchExamples.push(
          `[${scene.title}] spotlight "${action.elementId}" names none of the narrated words`,
        );
      }
    }
  }
}

// ---------- figure-gap heuristic (text-only canvas, shape-worded title) ----------
let figureGapCandidates = 0;
const figureGapExamples: string[] = [];
for (const scene of slides) {
  const title = String(scene.title ?? '').toLowerCase();
  const els =
    (scene as { content?: { canvas?: { elements?: unknown[] } } }).content?.canvas?.elements ?? [];
  const shapes = els.filter((el) => !isText(el));
  const isHairline = shapes.every((el) => Number((el as { height?: number }).height) <= 6);
  if (shapes.length === 0 || !isHairline) continue;
  if (!/shape|anatomy|structure|architecture|diagram|compare|side by side|anatomy of/.test(title))
    continue;
  figureGapCandidates += 1;
  if (figureGapExamples.length < 8) figureGapExamples.push(String(scene.title));
}

console.log('=== tier-1 finding counts ===');
for (const [key, val] of Object.entries(kindCounts)) {
  console.log(`${key}: ${val.count}  (${val.scenes.join(' | ')})`);
}
console.log(`\ncross-scene near-dup pairs (shingle>=0.55): ${dupPairs}; (>=0.40): ${sims.length}`);
sims.slice(0, 10).forEach((s) => console.log(`  sim=${s.sim.toFixed(2)} ${s.label}`));
dupExamples.slice(0, 4).forEach((x) => console.log('  STRONG ' + x));
console.log(`\nspotlight-mismatch candidates (rare-word proxy): ${mismtchCandidates}`);
mismatchExamples.forEach((x) => console.log('  ' + x));
console.log(`\nfigure-gap candidates (text-only, shape-title): ${figureGapCandidates}`);
figureGapExamples.forEach((x) => console.log('  ' + x));
