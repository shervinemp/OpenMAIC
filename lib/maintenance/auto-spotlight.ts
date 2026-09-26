/**
 * Spotlights for slides whose narration never points at anything
 * (deterministic, zero tokens).
 *
 * The action generator pairs narration with spotlights ("point first, then
 * speak"), but a slide can end up with none — older generations, split parts
 * whose narration was placed afterwards — and then the learner hears about a
 * row they have to find on their own. This adds a spotlight before a line only
 * where the line is unmistakably about one text element:
 *
 *  - only slides with no authored spotlight or laser at all (an authored
 *    anchor means the author chose; nothing is added beside it);
 *  - at least two words the line shares with the element that are
 *    distinctive on this slide (a word every element carries counts for
 *    nothing), and a clear lead over the runner-up element;
 *  - one spotlight per run of lines about the same element.
 *
 * A line that matches nothing clearly gets nothing: silence beats a wrong
 * highlight. Ids are derived from the line (`auto-spotlight-<line id>`), so a
 * second pass recognizes its own work.
 */

import type { Action } from '@/lib/types/action';
import { plainText, tokenize } from './narration-align';

/** Distinctive words a line must share with its element. */
const MIN_SHARED_TOKENS = 2;
/** How far the best element must lead the runner-up. */
const MIN_LEAD_RATIO = 1.5;
/** Elements shorter than this are labels, not something narration explains. */
const MIN_ELEMENT_TOKENS = 3;

interface SlideLike {
  readonly type?: string;
  readonly content?: unknown;
  readonly actions?: readonly Action[];
}

/**
 * The slide's actions with spotlights added, or null when nothing is added
 * (not a slide, already anchored, nothing matched clearly).
 */
export function withAutoSpotlights(scene: SlideLike): Action[] | null {
  if (scene.type !== 'slide') return null;
  const actions = scene.actions ?? [];
  if (actions.some((action) => action.type === 'spotlight' || action.type === 'laser')) {
    return null;
  }
  if (!actions.some((action) => action.type === 'speech')) return null;

  const elements = (
    (
      scene.content as {
        canvas?: { elements?: Array<{ id?: unknown; type?: unknown; content?: unknown }> };
      }
    )?.canvas?.elements ?? []
  )
    .filter(
      (element): element is { id: string; type: string; content: string } =>
        element.type === 'text' &&
        typeof element.id === 'string' &&
        typeof element.content === 'string',
    )
    .map((element) => ({ id: element.id, tokens: tokenize(plainText(element.content)) }))
    .filter((element) => element.tokens.size >= MIN_ELEMENT_TOKENS);
  // One candidate is no choice: a spotlight on the only text adds nothing.
  if (elements.length < 2) return null;

  const documentFrequency = new Map<string, number>();
  for (const element of elements) {
    for (const token of element.tokens) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  const weight = (token: string) =>
    Math.log(elements.length / (documentFrequency.get(token) ?? elements.length));

  const next: Action[] = [];
  let focused: string | null = null;
  let added = 0;
  for (const action of actions) {
    if (action.type === 'speech' && typeof action.text === 'string') {
      const target = clearTarget(tokenize(action.text), elements, weight);
      if (target && target !== focused) {
        next.push({ id: `auto-spotlight-${action.id}`, type: 'spotlight', elementId: target });
        focused = target;
        added += 1;
      }
    }
    next.push(action);
  }
  return added > 0 ? next : null;
}

function clearTarget(
  line: Set<string>,
  elements: ReadonlyArray<{ id: string; tokens: Set<string> }>,
  weight: (token: string) => number,
): string | null {
  let best: { id: string; score: number; shared: number } | null = null;
  let runnerUp = 0;
  for (const element of elements) {
    let score = 0;
    let shared = 0;
    for (const token of line) {
      if (!element.tokens.has(token)) continue;
      const w = weight(token);
      if (w <= 0) continue;
      score += w;
      shared += 1;
    }
    if (!best || score > best.score) {
      runnerUp = best?.score ?? runnerUp;
      best = { id: element.id, score, shared };
    } else if (score > runnerUp) {
      runnerUp = score;
    }
  }
  if (!best || best.shared < MIN_SHARED_TOKENS) return null;
  if (runnerUp > 0 && best.score < MIN_LEAD_RATIO * runnerUp) return null;
  return best.id;
}
