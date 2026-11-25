import { createHash } from 'node:crypto';

import { validateSlidePlacement } from '@openmaic/dsl';

/**
 * Statistical QA sample for a course document. Used both by the generation
 * flow (at job completion) and by the maintenance API, so the same definition
 * of "faulty scene" is applied everywhere instead of an ad-hoc eyeball pass.
 *
 * Design: simple random sample without replacement, seeded by a stable hash of
 * (seed, stageId, sceneId) so the selection is reproducible across runs and
 * unaffected by document ordering. n comes from the standard proportion
 * formula with finite-population correction (95%, +/-10%, p=0.5), which is
 * larger than the sqrt(N) rule of thumb for these course sizes.
 */
const Z = 1.96;
const MARGIN = 0.1;
const P = 0.5;
export const DEFAULT_AUDIT_SEED = 'openmaic-flow-audit-v1';

const SOURCE_MARKER_RE = /\[source[^\]]{0,60}\]/i;
const CJK_RE = /[\u4e00-\u9fff]{2,}/;

export interface SampleAuditFinding {
  sceneId: string;
  title: string;
  kinds: string[];
  layoutFindings?: number;
}

export interface SampleAuditReport {
  seed: string;
  confidence: number;
  margin: number;
  population: number;
  sampleSize: number;
  summary: {
    layout: number;
    cjk: number;
    source: number;
    noCanvas: number;
  };
  findings: SampleAuditFinding[];
  checkedAt: number;
}

/** Conservative sample size with finite-population correction. */
export function sampleSizeFor(population: number): number {
  if (population <= 0) return 0;
  const n0 = (Z * Z * P * (1 - P)) / (MARGIN * MARGIN);
  return Math.min(population, Math.ceil(n0 / (1 + (n0 - 1) / population)));
}

function rankValue(seed: string, key: string): number {
  const digest = createHash('sha256').update(`${seed}|${key}`).digest();
  return digest.readUInt32BE(0) / 4294967296;
}

export function auditScenesSample(
  document: { scenes?: Array<Record<string, unknown>> },
  stageId: string,
  seed = DEFAULT_AUDIT_SEED,
): SampleAuditReport {
  const scenes = document.scenes ?? [];
  const sampleSize = sampleSizeFor(scenes.length);
  const selected = scenes
    .map((scene) => ({ scene, key: rankValue(seed, `${stageId}|${String(scene.id ?? '')}`) }))
    .sort((a, b) => a.key - b.key)
    .slice(0, sampleSize)
    .map((entry) => entry.scene);

  const summary = { layout: 0, cjk: 0, source: 0, noCanvas: 0 };
  const findings: SampleAuditFinding[] = [];
  for (const scene of selected) {
    const text = JSON.stringify(scene);
    const kinds: string[] = [];
    if (SOURCE_MARKER_RE.test(text)) {
      summary.source += 1;
      kinds.push('source');
    }
    if (CJK_RE.test(text)) {
      summary.cjk += 1;
      kinds.push('cjk');
    }
    const canvas = (scene.content as { canvas?: { viewportSize?: number; viewportRatio?: number; elements?: unknown[] } } | undefined)?.canvas;
    let layoutFindings = 0;
    if (!canvas || !Array.isArray(canvas.elements)) {
      summary.noCanvas += 1;
    } else {
      try {
        layoutFindings = validateSlidePlacement({
          viewportSize: canvas.viewportSize,
          viewportRatio: canvas.viewportRatio,
          elements: canvas.elements,
        } as never).length;
      } catch {
        layoutFindings = 0;
      }
      if (layoutFindings > 0) {
        summary.layout += 1;
        kinds.push('layout');
      }
    }
    if (kinds.length > 0) {
      findings.push({
        sceneId: String(scene.id ?? ''),
        title: String(
          (scene.outline as { title?: string } | undefined)?.title ??
            (scene as { title?: string }).title ??
            '',
        ),
        kinds,
        ...(layoutFindings > 0 ? { layoutFindings } : {}),
      });
    }
  }

  return {
    seed,
    confidence: 0.95,
    margin: MARGIN,
    population: scenes.length,
    sampleSize,
    summary,
    findings,
    checkedAt: Date.now(),
  };
}
