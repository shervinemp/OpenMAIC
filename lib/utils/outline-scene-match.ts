/**
 * Which scene materializes an outline.
 *
 * Generated scenes carry the `outlineId` of the outline they were built
 * from, and that is the key. `order` is not: once a finished deck is edited
 * (Pro-mode insert, drag-reorder), scenes are renumbered and outlines are
 * not, so an order match pairs an outline with some other slide — a retry
 * then reused that slide's content, and progress counted the wrong lesson.
 *
 * `order` stays the key only for scenes without an `outlineId` (decks that
 * predate it). The fallback is per scene, not per deck: a legacy deck that
 * resumed generation after the upgrade mixes both kinds, and a per-deck
 * switch would read its older slides as missing and generate them again.
 */

export interface OutlineRef {
  readonly id: string;
  readonly order: number;
}

export interface SceneRef {
  readonly outlineId?: string;
  readonly order: number;
}

export interface OutlineSceneIndex<S extends SceneRef> {
  /** The scene that materializes this outline, if any. */
  sceneFor(outline: OutlineRef): S | undefined;
  /** Whether this outline has its scene. */
  has(outline: OutlineRef): boolean;
}

export function indexScenesByOutline<S extends SceneRef>(
  scenes: readonly S[],
): OutlineSceneIndex<S> {
  const byOutlineId = new Map<string, S>();
  const legacyByOrder = new Map<number, S>();
  for (const scene of scenes) {
    if (scene.outlineId) {
      if (!byOutlineId.has(scene.outlineId)) byOutlineId.set(scene.outlineId, scene);
    } else if (!legacyByOrder.has(scene.order)) {
      legacyByOrder.set(scene.order, scene);
    }
  }
  const sceneFor = (outline: OutlineRef): S | undefined =>
    byOutlineId.get(outline.id) ?? legacyByOrder.get(outline.order);
  return { sceneFor, has: (outline) => sceneFor(outline) !== undefined };
}
