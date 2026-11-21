/**
 * Deterministic claim ledger.
 *
 * Most defects that survived verification were contradictions between a
 * precise claim in the outline ("under 1%", "nearly 6x", "raises to 30 mm")
 * and the data or prose the scene actually shows. Those are token-level facts
 * in structured content, so they can be extracted and compared with code —
 * no summarising model, no lossy hop, no extra generation call.
 *
 * The ledger deliberately reports only high-confidence, literal mismatches.
 * Qualitative problems stay with the existing blind verifier.
 */

import type { SceneOutline } from './outline-types.js';
import type { VerificationIssue } from './verification-loop.js';

export interface ClaimReviewContext {
  outline: SceneOutline;
  content: unknown;
  /** Findings the deterministic ledger already produced for this content. */
  findings: readonly VerificationIssue[];
}

/**
 * Optional host-provided reviewer (e.g. a typed decision head in shadow mode).
 * Never required: absent means no call. Returning null/undefined means no
 * signal, and any throw is swallowed by the caller.
 */
export type ClaimReviewHook = (
  context: ClaimReviewContext,
) => Promise<readonly VerificationIssue[] | null | undefined>;

export async function reviewClaimsSafely(
  hook: ClaimReviewHook | undefined,
  context: ClaimReviewContext,
  log?: { warn: (message: string) => void },
): Promise<readonly VerificationIssue[]> {
  if (!hook) return [];
  try {
    const verdict = await hook(context);
    if (!verdict) return [];
    return verdict.filter(
      (issue) => typeof issue.code === 'string' && typeof issue.message === 'string',
    );
  } catch (error) {
    log?.warn(
      `Claim reviewer failed for "${context.outline.title}"; keeping content: ${String(error)}`,
    );
    return [];
  }
}

const DROP_KEYS = new Set([
  'id',
  'sceneId',
  'src',
  'mediaRef',
  'assetId',
  'imageIds',
  'referenceFiles',
  'style',
  'layout',
  'position',
  'x',
  'y',
  'width',
  'height',
  'rotate',
  'left',
  'top',
  'color',
  'fontSize',
  'defaultColor',
  'defaultFontName',
]);

function learnerStrings(value: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 8 || out.length > 400) return out;
  if (typeof value === 'string') {
    if (value.trim()) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 200)) learnerStrings(item, depth + 1, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (DROP_KEYS.has(key)) continue;
      learnerStrings(child, depth + 1, out);
    }
  }
  return out;
}

const NUMBER = '(\\d+(?:\\.\\d+)?)';
const PCT = `${NUMBER}\\s*(?:%|％)`;
const MULT = `${NUMBER}\\s*(?:×|x|倍)`;

const UNDER = new RegExp(`(?:under|below|less\\s+than|低于|不足|小于)\\s*${PCT}`, 'gi');
const NEARLY_MULT = new RegExp(
  `(?:nearly|about|roughly|approximately|接近|大约|约)\\s*${MULT}`,
  'gi',
);
const EXACT_MULT = new RegExp(`(?<!nearly\\s)(?<!about\\s)(?<!roughly\\s)${MULT}`, 'gi');
const RAISES = new RegExp(`(?:raises?|increases?|grows?)(?:\\s+\\w+)?\\s+to\\s+${NUMBER}`, 'gi');
const STAYS = new RegExp(`(?:stays?|remains?)\\s+at\\s+${NUMBER}`, 'gi');

function number(text: string): number {
  const match = text.match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : Number.NaN;
}

function outlineStrings(outline: SceneOutline): string[] {
  return [outline.title ?? '', outline.description ?? '', ...(outline.keyPoints ?? [])].filter(
    Boolean,
  );
}

/**
 * Compare the outline's precise claims with the learner-facing content.
 * Returns stable, model-facing issues; an empty list means "no literal
 * contradiction found" and says nothing about qualitative quality.
 */
export function checkClaimLedger(outline: SceneOutline, content: unknown): VerificationIssue[] {
  const promises = outlineStrings(outline);
  const shown = learnerStrings(content);
  if (promises.length === 0 || shown.length === 0) return [];

  const promiseText = promises.join(' ');
  const shownText = shown.join(' ');
  const issues: VerificationIssue[] = [];

  // "under 1%" in the outline vs an exact "1%" presented by the scene.
  for (const match of promiseText.matchAll(UNDER)) {
    const value = number(match[0]);
    const exact = new RegExp(
      `(?<!under\\s)(?<!below\\s)(?<!about\\s)(?<!roughly\\s)${numberToPattern(value)}\\s*(?:%|％)`,
      'gi',
    );
    // A neutral wording anywhere in the scene settles the claim: the chart may
    // legitimately label the value exactly while the prose says "about N%".
    const neutral = new RegExp(
      `(?:about|roughly|approximately)\\s+${numberToPattern(value)}\\s*(?:%|％)`,
      'i',
    );
    if (exact.test(shownText) && !neutral.test(shownText)) {
      issues.push({
        code: 'qualifier-conflict',
        message: `The outline says "${match[0].trim()}" but the scene presents exactly ${format(value)}%. Restate the figure you show (for example "about ${format(value)}%") instead of a stricter qualifier.`,
      });
      break;
    }
  }

  // "nearly 6x" in the outline vs a different computed ratio in the scene.
  for (const match of promiseText.matchAll(NEARLY_MULT)) {
    const promised = number(match[0]);
    const computed = [...shownText.matchAll(EXACT_MULT)].map((candidate) => number(candidate[0]));
    const closest = computed.reduce<number | null>(
      (best, candidate) =>
        best === null || Math.abs(candidate - promised) < Math.abs(best - promised)
          ? candidate
          : best,
      null,
    );
    if (closest !== null && Math.abs(closest - promised) > 0.3) {
      issues.push({
        code: 'qualifier-conflict',
        message: `The outline says "${match[0].trim()}" but the scene computes ${format(closest)}x. State the figure the scene actually derives.`,
      });
      break;
    }
  }

  // "raises to 30" in the outline vs "stays at 30" in the task data is a
  // direct contradiction of the premise, not a rounding difference.
  for (const match of promiseText.matchAll(RAISES)) {
    const value = number(match[0]);
    const stays = [...shownText.matchAll(STAYS)].some(
      (candidate) => Math.abs(number(candidate[0]) - value) < 1e-9,
    );
    if (stays) {
      issues.push({
        code: 'premise-conflict',
        message: `The outline says "${match[0].trim()}" but the scene states the value stays at ${format(value)}. Keep the outline and drop the conflicting statement.`,
      });
      break;
    }
  }

  return issues.slice(0, 3);
}

function numberToPattern(value: number): string {
  return value.toString().replace('.', '\\.');
}

function format(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, '');
}

/**
 * Conservative deterministic repair: only a qualifier phrase that the scene
 * itself contradicts is rewritten, and only to the neutral wording the ledger
 * already recommends. Everything else is left for the corrective model pass.
 */
export function repairClaimLedger(
  content: unknown,
  issues: readonly VerificationIssue[],
): { content: unknown; repaired: number } {
  const qualifiers = issues.filter((issue) => issue.code === 'qualifier-conflict');
  if (qualifiers.length === 0) return { content, repaired: 0 };
  let repaired = 0;

  function visit(value: unknown, depth: number): unknown {
    if (depth > 8) return value;
    if (typeof value === 'string') {
      let next = value;
      for (const issue of qualifiers) {
        const match = issue.message.match(/exactly\s+(\d+(?:\.\d+)?)%/);
        if (!match) continue;
        const valuePattern = match[1].replace('.', '\\.');
        const strict = new RegExp(
          `(under|below|less\\s+than|低于|不足|小于)\\s+${valuePattern}\\s*(%|％)`,
          'gi',
        );
        if (strict.test(next)) {
          next = next.replace(
            strict,
            (_all, _word: string, unit: string) => `about ${match[1]}${unit}`,
          );
          repaired += 1;
        }
      }
      return next;
    }
    if (Array.isArray(value)) return value.slice(0, 200).map((item) => visit(item, depth + 1));
    if (value && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        result[key] = visit(child, depth + 1);
      }
      return result;
    }
    return value;
  }

  return { content: visit(content, 0), repaired };
}
