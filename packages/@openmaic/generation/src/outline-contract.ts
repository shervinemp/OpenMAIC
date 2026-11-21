/**
 * Outline-agreement contract for content generation.
 *
 * The generic scene audit sees the outline and the generated content and can
 * report a contradiction — but by then a full generation has already been
 * spent. This module pushes the same contract into the *content* call, as a
 * system-prompt directive rather than a user-prompt directive so it cannot be
 * mistaken for learner-facing text by the language-drift gate.
 *
 * It wraps the host's `aiCall`, so it reaches every content stage (slides,
 * widgets, worked problems, quizzes, depth retries and corrective passes)
 * with one wiring point. Verifier calls are made with the host's original
 * `aiCall` and therefore remain blind and independent.
 */

import type { SceneOutline } from './outline-types.js';
import type { AICallFn } from './pipeline-types.js';

/** Directive appended to every content-generation system prompt. */
export function buildOutlineAgreementDirective(outline: SceneOutline): string {
  const keyPoints = (outline.keyPoints ?? []).filter(Boolean);
  return [
    '## Outline agreement (authoritative)',
    '',
    'The outline is the contract this scene must satisfy. Do not contradict,',
    'tighten, or pre-emptively answer it.',
    '',
    '- Restate any figure the outline gives with the exact same value and unit.',
    '- If you introduce a figure of your own, derive it from a dataset shown in',
    '  this same scene and make the wording match it: a chart showing 1% is',
    '  "about 1%", not "under 1%"; 5.67x is "about 5.7x", not "nearly 6x".',
    '- Do not add a superlative, "raises to", "always"/"never", or a verdict',
    "  unless both the outline and the scene's own data support it.",
    '- For worked problems and data-reading tasks, state the claim neutrally',
    '  and let the shown data decide. Never label a claim "supported" when the',
    '  data you show refutes it.',
    '- If the outline and your intended wording disagree, keep the outline and',
    '  drop the conflicting statement.',
    '',
    `Outline title: ${outline.title ?? ''}`,
    `Outline description: ${outline.description ?? ''}`,
    keyPoints.length > 0
      ? `Outline key points:\n${keyPoints.map((point, index) => `${index + 1}. ${point}`).join('\n')}`
      : 'Outline key points: (none)',
  ].join('\n');
}

/**
 * Wrap a content-generation call so every request carries the agreement
 * directive, without changing the user prompt or the learner-visible text.
 */
export function withOutlineAgreement(aiCall: AICallFn, outline: SceneOutline): AICallFn {
  const directive = buildOutlineAgreementDirective(outline);
  return async (systemPrompt, userPrompt, images) =>
    aiCall(`${systemPrompt}\n\n${directive}`, userPrompt, images);
}
