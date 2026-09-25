import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateSlidePlacement, sanitizeSlidePlacement } from '@openmaic/dsl';

const FILE = '.data/persistence/documents/2WjD3KDIez.json';
const doc = JSON.parse(readFileSync(FILE, 'utf8'));
const here = fileURLToPath(new URL('.', import.meta.url));

const kindCounts = Object.create(null);
const flagged = [];
let checked = 0;

for (const scene of doc.scenes) {
  if (scene?.type !== 'slide') continue;
  const canvas = scene?.content?.canvas;
  if (!canvas || !Array.isArray(canvas.elements)) continue;
  checked += 1;
  const findings = validateSlidePlacement({
    viewportSize: canvas.viewportSize,
    viewportRatio: canvas.viewportRatio,
    elements: canvas.elements,
  });
  if (findings.length === 0) continue;
  flagged.push({
    sceneId: scene.id,
    order: scene.order,
    title: scene.title,
    findings: findings.map((f) => ({
      kind: f.kind,
      severity: f.severity,
      message: f.message,
      elementId: f.elementId,
      covered: f.coveredFraction,
    })),
  });
  for (const f of findings) {
    const label = f.finding ?? `${f.kind}/${f.severity}`;
    kindCounts[label] = (kindCounts[label] ?? 0) + 1;
  }
}

const report = {
  file: FILE,
  checked,
  flaggedScenes: flagged.length,
  kindCounts,
  flagged,
};
writeFileSync(here + 'audit-report.json', JSON.stringify(report, null, 2));
console.log(`checked ${checked} slide scenes; flagged ${flagged.length}`);
console.log(JSON.stringify(kindCounts));
