/**
 * Slides that teach something and say nothing.
 *
 * A split slide's narration follows the elements it points at, so a continuation
 * part whose rows no line pointed at is left with its full text on screen and no
 * voice over it: in the worked-problem lessons that is the worked solution
 * itself. The learner reads it unaided.
 *
 * Detection is deterministic and free. Filling the gap is a model call per
 * slide, so it is the owner's call (a button with a count), never something
 * that happens on open.
 */
import type { Scene } from '@/lib/types/stage';
import { slideTextOf } from './narration-align';

/** Below this a slide is a title or a label, not something narration explains. */
export const MIN_SILENT_WORDS = 12;

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Whether a scene plays any narration. */
export function hasNarration(scene: Pick<Scene, 'actions'>): boolean {
  return (scene.actions ?? []).some(
    (action) => action.type === 'speech' && typeof action.text === 'string' && action.text.trim(),
  );
}

/** The slides with enough on screen to need narration and none, in play order. */
export function findSilentSlides(scenes: readonly Scene[]): Scene[] {
  return scenes
    .filter(
      (scene) =>
        scene.type === 'slide' &&
        !hasNarration(scene) &&
        wordCount(slideTextOf(scene as { content?: unknown })) >= MIN_SILENT_WORDS,
    )
    .sort((a, b) => a.order - b.order);
}

/**
 * The lines spoken just before a scene, oldest first: what the narrator has
 * said so far, so a generated continuation picks up the thread instead of
 * starting the lesson again.
 */
export function precedingSpeeches(
  scenes: readonly Scene[],
  scene: Pick<Scene, 'id' | 'order'>,
  limit = 6,
): string[] {
  const lines: string[] = [];
  const before = scenes
    .filter((candidate) => candidate.order < scene.order && candidate.id !== scene.id)
    .sort((a, b) => b.order - a.order);
  for (const candidate of before) {
    const spoken = (candidate.actions ?? []).flatMap((action) =>
      action.type === 'speech' && typeof action.text === 'string' && action.text.trim()
        ? [action.text]
        : [],
    );
    lines.unshift(...spoken);
    if (lines.length >= limit) break;
  }
  return lines.slice(-limit);
}
