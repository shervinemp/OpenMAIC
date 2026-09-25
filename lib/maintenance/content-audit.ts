// Content-integrity findings share the placement validator's severity
// vocabulary ('error' | 'warn'); their `kind` is freer — the placement
// validator names 'overflow'/'occlusion', content audits name their own
// classes. The layout ledger consumes both by severity count only.

/**
 * Content-integrity audit — the deterministic tier-1 checks the placement
 * validator cannot see. Every finding here is byte-level decidable from the
 * scene envelope (canvas elements + actions + narration ids) — no LLM, no
 * judgment, no taste. Severity doctrine mirrors validateSlidePlacement:
 * error = always wrong (fix outright or surface red), warn = advisory only.
 *
 * Cross-scene checks (duplicate element ids ACROSS a split family, title-band
 * continuity) need sibling visibility, so callers pass the precomputed
 * duplicate-id set via `familyDuplicateIds` and the continuity check runs on
 * the whole family with `splitFamilyFindings`.
 */

/** Status shape shared with the placement validator findings. */
export type ContentFinding = {
  kind: string;
  severity: 'error' | 'warn';
  message: string;
  elementId?: string;
};

interface SlideSceneLike {
  id?: string;
  type?: string;
  order?: number;
  actions?: ReadonlyArray<{
    type?: string;
    elementId?: string;
    audioId?: string;
    [key: string]: unknown;
  }>;
  content?: {
    canvas?: {
      viewportSize?: number;
      viewportRatio?: number;
      elements?: ReadonlyArray<{
        id?: string;
        type?: string;
        top?: number;
        width?: number;
        content?: string;
        [key: string]: unknown;
      }>;
    };
    [key: string]: unknown;
  };
}

/** Split-part id suffix: the page numeration the scene splitter appends. */
const SPLIT_PART_SUFFIX = /__p\d+$/;

/** `[source N]` — the unresolved citation placeholder class. */
export const SOURCE_PROVENANCE_RE = /\[source\s*\d+\]/gi;

/** Family key: base id shared by a scene and its `__pN` split parts. */
export function sceneFamilyKey(sceneId: string): string {
  return sceneId.replace(SPLIT_PART_SUFFIX, '') || sceneId;
}

function textElements(scene: SlideSceneLike) {
  return (scene.content?.canvas?.elements ?? []).filter(
    (element): element is { id: string; top: number; width: number; content: string } =>
      element.type === 'text' &&
      typeof element.id === 'string' &&
      typeof element.content === 'string',
  );
}

/**
 * (1a) Intra-scene duplicate element ids — always wrong under the per-scene
 * identity model. Error.
 */
function duplicateIdFindings(scene: SlideSceneLike): ContentFinding[] {
  const ids = (scene.content?.canvas?.elements ?? [])
    .map((element) => element.id)
    .filter((id): id is string => typeof id === 'string');
  const seen = new Map<string, number>();
  for (const id of ids) seen.set(id, (seen.get(id) ?? 0) + 1);
  const findings: ContentFinding[] = [];
  for (const [id, count] of seen) {
    if (count > 1) {
      findings.push({
        kind: 'identity/duplicate-element-id',
        severity: 'error',
        message: `element id "${id}" appears ${count}× on the same canvas`,
        elementId: id,
      });
    }
  }
  return findings;
}

/**
 * (2) Dead action anchors — an action (spotlight) whose elementId is absent
 * from the canvas. Always broken: the runner highlights nothing or throws.
 * Error severity, deterministic.
 */
function deadActionFindings(scene: SlideSceneLike): ContentFinding[] {
  const known = new Set(
    (scene.content?.canvas?.elements ?? [])
      .map((element) => element.id)
      .filter((id): id is string => typeof id === 'string'),
  );
  if (known.size === 0) return [];
  const findings: ContentFinding[] = [];
  for (const [index, action] of (scene.actions ?? []).entries()) {
    if (typeof action.elementId !== 'string' || !action.elementId) continue;
    if (!known.has(action.elementId)) {
      findings.push({
        kind: 'action/dead-element-reference',
        severity: 'error',
        message: `action #${index} (${action.type ?? 'unknown'}) references missing element "${action.elementId}"`,
        elementId: action.elementId,
      });
    }
  }
  return findings;
}

/**
 * (3) Narration-anchor coverage: text elements no action ever touches while
 * the scene demonstrably uses spotlights elsewhere. Warn only — some rows
 * are legitimately ambient (sources, footers).
 */
function unanchoredFindings(scene: SlideSceneLike): ContentFinding[] {
  const actions = scene.actions ?? [];
  const anchoredIds = new Set(
    actions.map((action) => action.elementId).filter((id): id is string => typeof id === 'string'),
  );
  if (anchoredIds.size === 0) return [];
  const texts = textElements(scene);
  if (texts.length < 2) return [];
  const missing = texts.filter((text) => !anchoredIds.has(text.id));
  if (missing.length === 0 || missing.length === texts.length) return [];
  return [
    {
      kind: 'narration/elements-never-spotlighted',
      severity: 'warn',
      message: `text elements never referenced by any action: ${missing.map((text) => text.id).join(', ')}`,
    },
  ];
}

/**
 * Write-time guard rail (the generation-path fragment of the semantic tier):
 * drop scene actions whose elementId is absent from the canvas BEFORE the
 * scene commits to a document. Deterministic, zero tokens, zero FP — a
 * spotlight that references nothing either throws in the runner or silently
 * highlights air, and catching it at materialization means the maintenance
 * judge only ever reviews *semantics*, never broken identity. Returns the
 * number of actions dropped.
 */
export function stripDeadActionAnchors(scene: SlideSceneLike): number {
  const known = new Set(
    (scene.content?.canvas?.elements ?? [])
      .map((element) => element.id)
      .filter((id): id is string => typeof id === 'string'),
  );
  if (known.size === 0 || !Array.isArray(scene.actions)) return 0;
  const before = scene.actions.length;
  scene.actions = scene.actions.filter(
    (action) =>
      typeof action.elementId !== 'string' || !action.elementId || known.has(action.elementId),
  );
  return (
    before -
    (
      scene.actions as Array<{
        type?: string;
        elementId?: string;
        audioId?: string;
        [key: string]: unknown;
      }>
    ).length
  );
}

/**
 * (4) Stale narration-order stamps — audioIds carry the scene order they were
 * generated for (`tts_s226_...`); a re-ordered deck leaves them behind. Warn:
 * cosmetic identity debt, but it blinds any tooling that keys audio by order.
 */
function staleNarrationFindings(scene: SlideSceneLike): ContentFinding[] {
  const order = scene.order;
  if (typeof order !== 'number' || !Number.isFinite(order)) return [];
  const findings: ContentFinding[] = [];
  for (const action of scene.actions ?? []) {
    const audioId = action.audioId;
    if (typeof audioId !== 'string') continue;
    const match = /^tts_s(\d+)_/.exec(audioId);
    if (!match) continue;
    const stamped = Number.parseInt(match[1], 10);
    if (stamped !== order) {
      findings.push({
        kind: 'narration/stale-order-audio-id',
        severity: 'warn',
        message: `audioId "${audioId}" stamps order ${stamped}; scene order is ${order}`,
      });
      break; // one warn per scene is enough; the whole family shares the stamp
    }
  }
  return findings;
}

/** (5) Instrumental artifact count, per scene, without fixing anything. */
function hasProvenanceFindings(scene: SlideSceneLike): ContentFinding[] {
  const found = textElements(scene).some((text) => SOURCE_PROVENANCE_RE.test(text.content));
  SOURCE_PROVENANCE_RE.lastIndex = 0;
  return found
    ? [
        {
          kind: 'provenance/source-artifact',
          severity: 'error',
          message: 'display copy contains unresolved "[source N]" placeholder(s)',
        },
      ]
    : [];
}

/**
 * Title-band membership: a heading-like element sits in the top band and is
 * wide enough to be a heading (chips are narrow; every observed heading spans
 * most of the canvas width). Band threshold follows the slide frame contract:
 * headings start at the body margin (top ≤ 56) and span ≥600px.
 */
function isHeadingLike(element: { top?: number; width?: number }): boolean {
  return typeof element.top === 'number' && element.top <= 50 && (element.width ?? 0) >= 600;
}

/**
 * (6) Split-family title continuity: every page of a split part carries the
 * top band heading when at least one sibling does. Warns on the non-heading
 * parts — landing mid-sequence must not lose the page identity.
 */
export function splitFamilyFindings(
  family: SlideSceneLike[],
): Array<{ sceneId: string; finding: ContentFinding }> {
  const pages = family.filter((scene) => (scene.content?.canvas?.elements ?? []).length >= 0);
  if (pages.length < 2) return [];
  const withHeading = new Map(
    pages.map((page) => [
      page,
      (page.content?.canvas?.elements ?? []).some(
        (element) => element.type === 'text' && isHeadingLike(element),
      ),
    ]),
  );
  if (![...withHeading.values()].some(Boolean)) return [];
  const findings: Array<{ sceneId: string; finding: ContentFinding }> = [];
  for (const [page, hasHeading] of withHeading) {
    if (!hasHeading) {
      findings.push({
        sceneId: page.id as string,
        finding: {
          kind: 'frame/split-part-missing-title',
          severity: 'warn',
          message: 'split part lacks the shared title band (sibling pages carry it)',
        },
      });
    }
  }
  return findings;
}

/**
 * Cross-scene duplicate element ids within one split family — the "same shape
 * id carried onto every part page" drift. The per-scene scan cannot see it
 * (one duplicated id per canvas is a different, intra-scene class), so this
 * runs document-wide in O(total elements). Returns one entry per part page
 * carrying shared ids, with the id list attached.
 */
export function splitFamilyDuplicateFindings(doc: {
  scenes?: SlideSceneLike[];
}): Array<{ sceneId: string; sharedIds: string[]; finding: ContentFinding }> {
  const families = new Map<string, SlideSceneLike[]>();
  for (const scene of doc.scenes ?? []) {
    if (scene.type !== 'slide' || !scene.id) continue;
    const key = sceneFamilyKey(scene.id);
    const member = families.get(key) ?? [];
    member.push(scene);
    families.set(key, member);
  }
  const result: Array<{ sceneId: string; sharedIds: string[]; finding: ContentFinding }> = [];
  for (const members of families.values()) {
    if (members.length < 2) continue;
    const idOwners = new Map<string, Set<string>>();
    for (const scene of members) {
      for (const element of scene.content?.canvas?.elements ?? []) {
        if (typeof element.id !== 'string') continue;
        const owners = idOwners.get(element.id) ?? new Set<string>();
        owners.add(scene.id as string);
        idOwners.set(element.id, owners);
      }
    }
    const sharedIds = [...idOwners]
      .filter(([, owners]) => owners.size > 1)
      .map(([id]) => id)
      .filter((id) =>
        members.some((scene) =>
          (scene.content?.canvas?.elements ?? []).some(
            (element) => element.id === id && Number(element.height ?? 0) > 6,
          ),
        ),
      );
    if (sharedIds.length === 0) continue;
    for (const scene of members) {
      const carrying = sharedIds.filter((id) =>
        (scene.content?.canvas?.elements ?? []).some((element) => element.id === id),
      );
      if (carrying.length === 0) continue;
      result.push({
        sceneId: scene.id as string,
        sharedIds: carrying,
        finding: {
          kind: 'identity/cross-part-duplicate-element-id',
          severity: 'warn',
          message: `element ids shared across the split family: ${carrying.join(', ')}`,
        },
      });
    }
  }
  return result;
}

/**
 * The per-scene tier-1 residual audit. `familyDuplicateIds` — ids known to be
 * shared across this scene's split family — is caller-supplied so one
 * document-level index can serve every visit.
 */
export function sceneContentFindings(
  scene: SlideSceneLike,
  familyDuplicateIds?: Set<string>,
): ContentFinding[] {
  if (scene.type !== 'slide') return [];
  const findings: ContentFinding[] = [
    ...duplicateIdFindings(scene),
    ...deadActionFindings(scene),
    ...staleNarrationFindings(scene),
    ...unanchoredFindings(scene),
    ...hasProvenanceFindings(scene),
  ];
  if (familyDuplicateIds && familyDuplicateIds.size > 0) {
    findings.push({
      kind: 'identity/cross-part-duplicate-element-id',
      severity: 'warn',
      message: `element ids shared across the split family: ${[...familyDuplicateIds].join(', ')}`,
    });
  }
  return findings;
}

/**
 * Delete-only auto-fix: strip unresolved `[source N]` placeholders from text
 * elements. Byte-level, no tokens, idempotent; duplicates are collapsed, the
 * surrounding spacing normalized. Returns the number of elements changed.
 */
export function stripSourceProvenance(scene: SlideSceneLike): number {
  let changed = 0;
  for (const element of scene.content?.canvas?.elements ?? []) {
    if (element.type !== 'text' || typeof element.content !== 'string') continue;
    const next = element.content
      .replace(SOURCE_PROVENANCE_RE, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\s+([.,;])/g, '$1')
      .replace(/<p([^>]*)>\s+/g, '<p$1>')
      .replace(/\s+<\/p>/g, '</p>');
    SOURCE_PROVENANCE_RE.lastIndex = 0;
    if (next !== element.content) {
      element.content = next;
      changed += 1;
    }
  }
  return changed;
}

export function hasSourceProvenance(scene: SlideSceneLike): boolean {
  return sourceIdsOf(scene).size > 0;
}

/**
 * Ids of the text elements whose copy currently carries an unresolved
 * "[source N]" placeholder. The repair route snapshots this before its
 * deterministic passes so a post-strip re-check can name exactly which
 * elements were cured.
 */
export function sourceIdsOf(scene: SlideSceneLike): Set<string> {
  const ids = new Set(
    textElements(scene)
      .filter((text) => {
        const hit = SOURCE_PROVENANCE_RE.test(text.content);
        SOURCE_PROVENANCE_RE.lastIndex = 0;
        return hit;
      })
      .map((text) => text.id),
  );
  SOURCE_PROVENANCE_RE.lastIndex = 0;
  return ids;
}
