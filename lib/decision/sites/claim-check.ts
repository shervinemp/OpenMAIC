/**
 * `claim-check` as a decision site: typed shadow review of the deterministic
 * claim ledger.
 *
 * The code ledger already produces a literal outline-vs-content verdict at
 * zero token cost. This site asks a typed head whether it agrees — in `shadow`
 * mode the router runs both and returns the baseline, so enabling it changes
 * no generated content and only accumulates agreement telemetry.
 *
 * A `replace` mode is possible but should be opt-in per site: the typed answer
 * carries only a yes/no, not the specific contradiction a corrective rewrite
 * needs, so the deterministic findings remain the better correction signal.
 */

import type { ClaimReviewContext, ClaimReviewHook } from '@openmaic/generation';
import type { VerificationIssue } from '@openmaic/generation';

import { runDecisionSite } from '../router';
import type { DecisionRequest, DecisionSiteConfig } from '../types';

const OPTIONS = [
  { value: 'yes', label: 'Yes, a number or verdict directly contradicts the outline' },
  { value: 'no', label: 'No, the content is consistent with the outline' },
] as const;

function compactStrings(value: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 5 || out.length >= 30) return out;
  if (typeof value === 'string') {
    if (value.trim()) out.push(value.slice(0, 300));
  } else if (Array.isArray(value)) {
    for (const item of value.slice(0, 30)) compactStrings(item, depth + 1, out);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'id' || key === 'src' || key === 'mediaRef' || key === 'referenceFiles') continue;
      compactStrings(child, depth + 1, out);
    }
  }
  return out;
}

export function buildClaimDecisionRequest(context: ClaimReviewContext): DecisionRequest {
  const outline = context.outline;
  return {
    state: [
      'Decide whether the scene content contradicts its outline. Compare exact',
      'numbers, percentages, ratios, superlatives and verdict labels. Ignore',
      'layout, ids and media references. The outline is authoritative.',
      '',
      `Title: ${outline.title ?? ''}`,
      `Description: ${outline.description ?? ''}`,
      `Key points: ${(outline.keyPoints ?? []).join(' | ')}`,
      '',
      `Learner-facing content:\n${compactStrings(context.content).join(' ')}`,
    ].join('\n'),
    questions: [
      {
        id: 'conflict',
        kind: 'choice',
        prompt: 'Does any stated number or verdict in the content directly contradict the outline?',
        options: OPTIONS.map((option) => ({ ...option })),
      },
    ],
  };
}

export function createClaimReviewHook(config: DecisionSiteConfig): ClaimReviewHook {
  return async (context) => {
    const request = buildClaimDecisionRequest(context);
    const outcome = await runDecisionSite<readonly VerificationIssue[]>({
      site: 'claim-check',
      inputChars: request.state.length + request.questions[0].prompt.length,
      request,
      // The code ledger is the baseline in every mode; shadow compares against it.
      baseline: async () => context.findings,
      fromResult: (result, _config) => {
        const answer = result.answers.get('conflict');
        if (!answer || answer.kind !== 'choice') return null;
        const conflict = answer.values.includes('yes');
        return {
          value: conflict
            ? [
                {
                  code: 'typed-claim-conflict',
                  message: 'A typed reviewer flagged a claim that contradicts the outline.',
                },
              ]
            : [],
          confidence: answer.confidence,
        };
      },
      compare: (decision, baseline) => decision.length > 0 === baseline.length > 0,
    }, { config });

    if (outcome.source === 'none') return null;
    return outcome.value;
  };
}
