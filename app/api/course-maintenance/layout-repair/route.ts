import { NextRequest } from 'next/server';
import { createCourseDocumentStore } from '@/lib/persistence/course-document-store';
import { singleFlight } from '@/lib/server/single-flight';
import {
  applyLayoutLedger,
  coerceElementGeometry,
  demoteCoveredDecoratives,
  hasNonFiniteGeometry,
  hasOrphanDecoratives,
  isLayoutEvidenceFresh,
  LAYOUT_EVIDENCE_MAX_AGE_MS,
  CONTENT_AUDIT_EPOCH_MS,
  nudgeOffHairlines,
  explodeWallRows,
  normalizeFullBleedRows,
  stripOrphanDecoratives,
  applyRelayoutMoves,
  computeRelayoutPlan,
  layoutLedgerOf,
  residualFindings,
  sanitizeSceneCanvas,
  type RelayoutPlan,
} from '@/lib/maintenance/layout-relayout';
import { callLLM } from '@/lib/ai/llm';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import { apiError, apiSuccess, type ApiErrorCode } from '@/lib/server/api-response';
import { applyLayoutPatch } from '@/lib/slides/slide-layout-verify';
import { applyEmptyPartPrune, findEmptyPartPrune } from '@/lib/maintenance/prune-empty-parts';
import {
  sceneContentFindings,
  hasSourceProvenance,
  sourceIdsOf,
  splitFamilyDuplicateFindings,
  splitFamilyFindings,
  stripDeadActionAnchors,
  stripSourceProvenance,
  type ContentFinding,
} from '@/lib/maintenance/content-audit';

const MERGE_CALL_LIMIT = 40;

interface RequestBody {
  courseId: string;
  dryRun?: boolean;
  sceneIds?: string[];
  actionSourceStamps?: boolean;
  /**
   * Explicitly opt in to the LLM delete-only merge pass for overflow rows.
   * Default OFF for the MANUAL path (any explicit call stays token-free
   * unless the caller asks); the ON-LOAD pipeline passes it true — bounded
   * LLM (40 calls) is acceptable where it materially cures unsplittable
   * embraces of content redundancy. Red-card content is never rewritten
   * silently — the pass deletes only clearly redundant rows.
   */
  allowMerge?: boolean;
}

const MERGE_SYSTEM_PROMPT = [
  'You receive the visible content rows of an over-stacked course slide (each row is a small HTML block).',
  'The rows no longer fit the slide after deterministic re-packing. Decide which rows are REDUNDANT and may be deleted to make the slide readable.',
  'Be conservative: delete a row ONLY when its material is clearly repeated or obviously dominated by a better row.',
  'Return STRICT JSON only: {"deleteIds":["elementId", ...]} — no prose, no other keys.',
].join('\n');

function mergeBudgetCrossed(checkpoint: { used: number }): boolean {
  return checkpoint.used >= MERGE_CALL_LIMIT;
}

export async function POST(req: NextRequest) {
  const unauthorized = await isUnauthorized(req);
  if (unauthorized) {
    return apiError('UNAUTHENTICATED', 401, 'maintenance route requires the dev persistence token');
  }
  const fileDir = process.env.PERSISTENCE_DIR;
  if (!fileDir) {
    return apiError('INVALID_REQUEST', 503, 'this route requires the file-backed persistence backend (PERSISTENCE_DIR)');
  }
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return apiError('INVALID_REQUEST', 400, 'body must be JSON');
  }
  const courseId = body.courseId?.trim();
  if (!courseId) return apiError('INVALID_REQUEST', 400, 'courseId is required');

  // Single-flight: the on-load pipeline fires this pass once per classroom
  // mount, so two tabs (or a reload racing the previous load) would otherwise
  // run two minutes-long sweeps against the same document concurrently —
  // duplicated bounded-LLM spend, EPERM rename storms, and writer races. The
  // second identical request now awaits the first run's result. Keyed by the
  // WORK: a targeted refresh (`sceneIds`) or a dry run never coalesces with a
  // full apply pass. The flight returns a plain payload — a shared
  // `NextResponse` would hand two requests one single-use body stream.
  const requestedKey = body.sceneIds?.length ? [...body.sceneIds].sort().join(',') : 'full';
  const jobKey = `layout-repair:${courseId}:${body.dryRun === true ? 'dry' : 'apply'}:${body.allowMerge === true ? 'merge' : 'plain'}:${requestedKey}`;
  const outcome = await singleFlight(jobKey, () => runLayoutRepair(req, body, courseId, fileDir));
  return outcome.ok
    ? apiSuccess(outcome.payload)
    : apiError(outcome.code, outcome.status, outcome.message);
}

type LayoutRepairOutcome =
  | {
      ok: true;
      payload: {
        courseId: string;
        dryRun: boolean;
        scenesScanned: number;
        scenesPlanned: number;
        pruned: number;
        skippedFresh: number;
        reports: Array<
          RelayoutPlan & {
            applied: boolean;
            residualErrors: number;
            residualWarnings?: number;
            mergedDeleted: string[];
            /** Tier-1 content-integrity residuals for this scene (delta vs geometry-only ledger). */
            contentFindings?: ContentFinding[];
            /** Elements whose unresolved "[source N]" placeholders were stripped this visit. */
            provenanceStripped?: string[];
          }
        >;
      };
    }
  | { ok: false; code: ApiErrorCode; status: number; message: string };

async function runLayoutRepair(
  req: NextRequest,
  body: RequestBody,
  courseId: string,
  fileDir: string,
): Promise<LayoutRepairOutcome> {
  const documentStore = createCourseDocumentStore(fileDir);

  let document;
  try {
    document = await documentStore.loadDocument(courseId);
  } catch (error) {
    console.error('[layout-relayout] load failed', error);
    return { ok: false, code: 'UPSTREAM_ERROR', status: 500, message: 'course load failed' };
  }
  if (!document) {
    return { ok: false, code: 'INVALID_REQUEST', status: 404, message: 'course document not found' };
  }

  const requestedIds = body.sceneIds?.length ? body.sceneIds : null;
  // DELETE-ONLY remediation for the empty-split-leftover class (the old
  // splitter could leave its first chunk empty while every row went to the
  // later parts; an empty canvas has no validator errors, so patch and split
  // both no-op and the part parks hidden forever). Proven-redundant empty
  // slide parts — a same-base sibling holds the content — are removed with
  // their outline references and job envelopes. Full passes only: a targeted
  // refresh must not mutate scenes outside its subset. Persisted with ONE
  // saveDocument BEFORE the per-scene loop: putScene re-adds unknown ids, so a
  // loop-write before the prune would resurrect what we removed.
  const prunePlan =
    requestedIds === null
      ? findEmptyPartPrune(document as never)
      : { sceneIds: [] as string[], outlineIds: [] as string[] };
  let pruned = 0;
  if (!body.dryRun && prunePlan.sceneIds.length > 0) {
    const applied = applyEmptyPartPrune(document as never, prunePlan);
    try {
      await documentStore.saveDocument(document as never);
      pruned = applied.removedSceneIds.length;
    } catch (error) {
      console.error(
        '[layout-relayout] empty-part prune save failed (non-fatal)',
        (error as Error).message.slice(0, 140),
      );
    }
  }
  const prunedIds = new Set(prunePlan.sceneIds);
  // Tier-1 content-integrity indexes: cross-split-family duplicate element
  // ids and split-title continuity are FAMILY-level properties (one id
  // carried onto every part page; one page missing the shared heading), so
  // both are precomputed once per request and consulted per scene. Purely
  // deterministic; zero tokens.
  const splitFamilyDupIndex = new Map<string, Set<string>>();
  for (const entry of splitFamilyDuplicateFindings(document as never)) {
    splitFamilyDupIndex.set(entry.sceneId, new Set(entry.sharedIds));
  }
  const splitTitleContinuity = new Map<string, ContentFinding[]>();
  {
    const families = new Map<string, Array<Record<string, unknown>>>();
    for (const scene of document.scenes as unknown as Array<Record<string, unknown>>) {
      if (scene.type !== 'slide' || typeof scene.id !== 'string') continue;
      const key = scene.id.replace(/__p\d+$/, '') || scene.id;
      const member = families.get(key) ?? [];
      member.push(scene);
      families.set(key, member);
    }
    for (const members of families.values()) {
      for (const entry of splitFamilyFindings(members as never)) {
        splitTitleContinuity.set(entry.sceneId, [entry.finding]);
      }
    }
  }
  // AppScene and the audit's structural scene shape diverge in declared
  // types only (same runtime envelope the rest of this route casts freely
  // over, e.g. `document as never`); the audit reads a strict structural
  // subset.
  const auditScene = (s: unknown, dup?: Set<string>): ContentFinding[] =>
    sceneContentFindings(s as never, dup);
  const stripScene = (s: unknown): number => stripSourceProvenance(s as never);
  const sourceIds = (s: unknown): Set<string> => sourceIdsOf(s as never);
  const sceneHasSources = (s: unknown): boolean => hasSourceProvenance(s as never);
  const sceneTitleFindings = (s: unknown): ContentFinding[] =>
    splitTitleContinuity.get((s as { id?: string }).id ?? '') ?? [];
  // Incremental sweep: a full pass skips scenes whose green ledger evidence is
  // newer than their last change (and within the age cap). Without this, every
  // classroom open re-ran the full deterministic sweep over ~1,600 scenes
  // (~30 min of CPU). A targeted request always visits exactly its ids; debt
  // scenes are never fresh, so healing still converges every pass.
  let skippedFresh = 0;
  const targets = document.scenes.filter((scene) => {
    if (scene.type !== 'slide' || prunedIds.has(scene.id)) return false;
    if (requestedIds) return requestedIds.includes(scene.id);
    if (isLayoutEvidenceFresh(scene)) {
      skippedFresh += 1;
      return false;
    }
    return true;
  });

  const reports: Array<
    RelayoutPlan & {
      applied: boolean;
      residualErrors: number;
      residualWarnings?: number;
      mergedDeleted: string[];
      contentFindings?: ContentFinding[];
      provenanceStripped?: string[];
    }
  > = [];
  const mergeCheckpoint = { used: 0 };
  const allowMerge = body.allowMerge === true;
  // Job-envelope phase writes coalesce into ONE incremental outline write at
  // the end: the route mutates document.outline in memory only, so without
  // an explicit phase write every stamp silently evaporates at the request
  // boundary (putScene persists a scene, not the outline).
  const phaseWrites: Array<{ outlineId: string; phase: string; status: string; attempts: number; updatedAt: number; error?: string }> = [];

  for (const scene of targets) {
    // Skip gate uses a CHEAP pre-plan on raw geometry: the honest plan is
    // computed only AFTER the deterministic passes, because the passes
    // change the geometry the plan packs. (Computing once up-front and
    // applying after the passes is the stale-plan bug: the moves overwrite
    // the passes' own fixes — and with NaN-poisoned legacy rects, NaN
    // cursors that serialize to null tops on disk.)
    const prePlan = computeRelayoutPlan(scene);
    // A slide whose envelope never got a `layout` phase entry (parts born
    // before layout became the fifth phase) must still be visited once: the
    // apply branch stamps the phase truthfully and the lesson list's serving
    // rule — which keys on that phase — then has a real answer for it.
    const outlineId = (scene as { outlineId?: string }).outlineId;
    const needsPhaseStamp = !outlineId ? false : !(document as {
      outline?: { lessonGroups?: Array<{ jobs?: Array<{ outlineId: string; phases?: Record<string, unknown> }> }> };
    }).outline?.lessonGroups?.flatMap?.((jobGroup) => jobGroup.jobs ?? [])
      .some((job) => job.outlineId === outlineId && job.phases?.layout);
    // Orphaned decorative shapes (split ghosts) are geometry-legal — the
    // validator sees nothing and the plan is empty — so they are detected
    // explicitly and pull their scene into the apply branch, where the
    // delete-only strip heals them.
    const hasGhosts = hasOrphanDecoratives(scene);
    // Non-finite rects (null tops, undefined heights on legacy elements)
    // pull their scene in even when the validator is silent: the coercion
    // pass that fixes them only runs inside the apply branch.
    const hasBadGeometry = hasNonFiniteGeometry(scene);
    // Tier-1 content-integrity audit (deterministic, zero tokens): duplicate
    // element ids, dead action references, unresolved "[source N]"
    // placeholders, stale narration-order stamps, split-title continuity.
    // Must be computed BEFORE the geometry passes: a content audit after
    // them would see the strip's own output and report a phantom.
    const dupIds = splitFamilyDupIndex.get((scene as { id?: string }).id ?? '');
    const preContent = [...auditScene(scene, dupIds), ...sceneTitleFindings(scene)];
    const preContentErrors = preContent.filter((finding) => finding.severity === 'error').length;
    const needsProvenanceStrip = sceneHasSources(scene);
    if (
      !prePlan &&
      !layoutLedgerOf(scene) &&
      !needsPhaseStamp &&
      !hasGhosts &&
      !hasBadGeometry &&
      preContentErrors === 0 &&
      !needsProvenanceStrip
    ) {
      // Clean scene with no debt marker. Persist a ledger ONCE so the
      // incremental sweep can skip it on future passes: freshness must be
      // stored evidence (in-memory stamping dies at the request boundary),
      // and without this write-off the cleanest scenes were re-visited on
      // every pass forever. Warn-level content findings (shared ids across a
      // split family, never-spotlighted rows, stale narration stamps, missing
      // split titles) ride the ledger count — advisory, never blocking — and
      // expiry re-checks them on the standard evidence cycle.
      if (!body.dryRun) {
        const stamp = Date.now();
        applyLayoutLedger(scene, preContent, stamp);
        (scene as { updatedAt?: number }).updatedAt = stamp;
        try {
          await documentStore.putScene(courseId, scene as never);
        } catch (error) {
          console.error('[layout-relayout] ledger write-off failed', scene.id, error);
        }
      }
      continue;
    }
    let applied = false;
    const mergedDeleted: string[] = [];
    // Ids of elements carrying unresolved "[source N]" placeholders BEFORE the
    // deterministic passes run — the strip re-derives success from this set.
    const preArtifactElements = sourceIds(scene);

    if (!body.dryRun) {
      // Geometry coercion FIRST: non-finite rects poison every sum the plan
      // math touches (NaN cursor → NaN writes → null tops on disk). Then the
      // deterministic truth passes, in dependency order.
      const coerced = coerceElementGeometry(scene);
      // Z-order truth pass runs BEFORE planning: a decorative shape on top of
      // the rows it underlies is layering debt the mover cannot cure — the
      // demote pass is deterministic and touches stacking only. The orphan
      // strip precedes it: an interior decorative shape no row overlaps is a
      // split ghost (text left the room, the shape stayed and got repeated)
      // — geometry-legal, invisible to the validator, delete-only to heal.
      demoteCoveredDecoratives(scene);
      // The wall unwrapper runs FIRST, so the fresh rows the wall breaks into
      // are what the hairline/full-bleed normalizers see (deterministic row
      // shaping on the same words, no LLM, no content rewrite).
      const exploded = explodeWallRows(scene);
      const stripped = stripOrphanDecoratives(scene);
      const scrubbed = stripScene(scene);
      // Dead action anchors (spotlight of an element the canvas does not
      // carry): same deterministic zero-FP class as the provenance strip —
      // the runner either throws or highlights air. Delete-only heal.
      const deadAnchorStrips = stripDeadActionAnchors(scene as never);
      const nudged = nudgeOffHairlines(scene);
      const normalized = normalizeFullBleedRows(scene);
      // Element ids whose "[source N]" placeholders were removed this visit
      // (re-derived after the strip so the report cannot overclaim an id).
      const provenanceStripped =
        scrubbed > 0
          ? [...preArtifactElements].filter((id) => !sourceIds(scene).has(id))
          : [];
      // Presentation-pass mutations (z-order, ghosts, hairline grazes,
      // full-bleed walls, wall unwrapping, geometry coercion, provenance
      // strip) are real changes even when the validator's error count stays
      // flat: they must reach the store or the pass heals nothing and
      // reports a phantom fix.
      const passChanged = coerced + exploded + stripped + nudged + normalized + scrubbed + deadAnchorStrips > 0;
      // The HONEST plan — computed on the post-pass geometry it will move.
      const plan = computeRelayoutPlan(scene);
      if (plan) {
        applyRelayoutMoves(scene, plan);
        sanitizeSceneCanvas(scene);
      }

      if (
        allowMerge &&
        plan &&
        plan.overflowRows.length > 0 &&
        !mergeBudgetCrossed(mergeCheckpoint)
      ) {
        const { model, thinkingConfig } = await resolveModelFromRequest(req, body as never, 'scene-verify');
        const slideCanvas = (scene.content as { canvas?: { elements?: Array<{ id: string; content?: string }> } } | undefined)?.canvas;
        const rows = slideCanvas?.elements ?? [];
        const rowSummaries = plan.overflowRows.map((id) => {
          const row = rows.find((entry) => entry.id === id);
          const text = String(row?.content ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 400);
          return `${id}: ${text}`;
        });
        mergeCheckpoint.used += 1;
        try {
          const result = await callLLM(
            {
              model,
              system: MERGE_SYSTEM_PROMPT,
              prompt: `Rows (top order, slide budget exceeded):\n${rowSummaries.join('\n')}`,
              maxOutputTokens: 800,
              maxRetries: 0,
            } as never,
            'scene-verify',
            undefined,
            thinkingConfig ?? undefined,
          );
          const text = result.text ?? '';
          const parsed = JSON.parse(text.slice(Math.max(0, text.indexOf('{')), Math.max(0, text.lastIndexOf('}')) + 1)) as { deleteIds?: unknown };
          if (Array.isArray(parsed.deleteIds)) {
            const canvas = (scene.content as { canvas?: { elements?: Array<{ id: string }> } } | undefined)?.canvas;
            if (canvas && Array.isArray(canvas.elements)) {
              const deleteIds = new Set(
                parsed.deleteIds.filter((id): id is string => typeof id === 'string' && plan.overflowRows.includes(id)),
              );
              if (deleteIds.size > 0) {
                canvas.elements = canvas.elements.filter((element) => !deleteIds.has(element.id));
                mergedDeleted.push(...deleteIds);
              }
            }
          }
        } catch (error) {
          console.warn(`[layout-relayout] merge pass failed for scene ${scene.id}`, error);
        }
        sanitizeSceneCanvas(scene);
        if (mergedDeleted.length > 0) {
          const secondPass = computeRelayoutPlan(scene);
          if (secondPass && secondPass.moved.length > 0) {
            applyRelayoutMoves(scene, secondPass);
            sanitizeSceneCanvas(scene);
          }
        }
      }

      // TIER 2.b (bounded patch): a scene the mover cannot close AND the
      // splitter declines (fits one chunk but rows still collide) is the
      // exact case the ±20%-bounded layout patch heals. One silent retry on
      // an empty provider response — provider flakiness must not strand a
      // scene geometry could evidently cure.
      let residual = residualFindings(scene);
      if (allowMerge && !mergeBudgetCrossed(mergeCheckpoint)) {
        mergeCheckpoint.used += 1;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const { LAYOUT_REPAIR_PROMPT, buildLayoutRepairRequest } = await import('@/app/api/generate/scene-verify/route');
            const { model, thinkingConfig } = await resolveModelFromRequest(req, body as never, 'scene-verify');
            const result = await callLLM(
              {
                model,
                system: LAYOUT_REPAIR_PROMPT,
                prompt: buildLayoutRepairRequest((scene.content as unknown as { canvas: { viewportSize: number; viewportRatio: number; elements: Array<Record<string, unknown>> } }).canvas, residual),
                maxOutputTokens: 4096,
                maxRetries: 0,
              } as never,
              'scene-verify',
              undefined,
              thinkingConfig ?? undefined,
            );
            const text = result.text ?? '';
            if (text.length === 0) {
              console.warn('[layout-relayout] patch tier attempt returned empty text (one retry)', JSON.stringify({
                model,
                finishReason: (result as { finishReason?: string }).finishReason,
              }));
              continue;
            }
            const jsonStart = Math.max(0, text.indexOf('{'));
            const jsonEnd = text.lastIndexOf('}');
            if (jsonEnd > jsonStart) {
              // Same contract as the browser train: strict "{elements:[...]}"
              // silhouette, exact-id, ±20% — enforced by the shared helper.
              // Strictness addition learned the hard way: an element citing
              // null geometry (no numeric left/top/width/height) is not a
              // patch, it is a request to corrupt a canvas — reject the whole
              // element list before the shared helper sees it.
              const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as { elements?: Array<Record<string, unknown>> };
              const elements = parsed.elements;
              const geometryless = Array.isArray(elements)
                ? elements.some((el) => {
                    const rect = el as { left?: unknown; top?: unknown; width?: unknown; height?: unknown };
                    return ![rect.left, rect.top, rect.width, rect.height].every(
                      (value) => typeof value === 'number' && Number.isFinite(value),
                    );
                  })
                : false;
              if (!Array.isArray(elements) || geometryless) {
                console.warn('[layout-relayout] patch tier rejected (missing element list or null geometry)');
                break;
              }
              const canvas = (scene.content as unknown as { canvas: { elements: Array<Record<string, unknown>> } }).canvas;
              const patched = applyLayoutPatch(canvas as never, elements as never);
              if (patched) sanitizeSceneCanvas(scene);
            }
            break;
          } catch (error) {
            console.warn('[layout-relayout] bounded patch failed (non-fatal)', (error as Error).message.slice(0, 120));
            break;
          }
        }
        residual = residualFindings(scene);
      }
      // Tier-1 content-integrity residual joins the geometry residual in ONE
      // ledger: the route's post-pass re-audit names what the strip/clean
      // passes could not cure (dead element references, family-duplicated
      // ids, stale narration stamps, never-spotlighted rows, missing split
      // titles). Errors flow into the same red/green gate as geometry. The
      // post-pass re-audit already reflects any strip this visit performed.
      const contentResidual = [
        ...auditScene(scene, splitFamilyDupIndex.get((scene as { id?: string }).id ?? '')),
        ...sceneTitleFindings(scene),
      ];
      const residualAll = [...residual, ...contentResidual];
      const errorCount = residualAll.filter((f) => f.severity === 'error').length;
      const warnCount = residualAll.filter((f) => f.severity === 'warn').length;
      // UNIFIED STATE: the layout phase lives in the job envelope (a fifth
      // phase beside content/actions/tts/media) — the single red/green source
      // for the generation panel and the lesson-list serving rule. Attempts
      // ratchet only on STATUS TRANSITIONS: a status-only re-check per
      // session updates the timestamp, not the history.
      const outlineId = (scene as { outlineId?: string }).outlineId;
      if (outlineId) {
        const outlineDoc = document as unknown as {
          outline?: { lessonGroups?: Array<{ jobs?: Array<{ outlineId: string; phases?: Record<string, { status?: string; attempts?: number; updatedAt?: number }> }> }> };
        };
        const group = outlineDoc.outline?.lessonGroups?.find((jobGroup) =>
          (jobGroup.jobs ?? []).some((job) => job.outlineId === outlineId),
        );
        if (group) {
          const job = group.jobs?.find((entry) => entry.outlineId === outlineId);
          if (job) {
            const now = Date.now();
            const previous = job.phases?.layout as { status?: 'pending' | 'running' | 'done' | 'failed'; attempts?: number } | undefined;
            // Materialization truth joins collision truth: a zero-element
            // slide canvas is an unmaterialized page (the old splitter could
            // leave its first chunk empty). Rendering "empty" with a green
            // phase would be a lie on the lesson list — the serving rule
            // hides failed layouts, which is exactly right for a blank part.
            const elementCount = (scene.content as { canvas?: { elements?: unknown[] } } | undefined)?.canvas?.elements?.length ?? 0;
            const nextStatus = errorCount > 0 || elementCount === 0 ? 'failed' : 'done';
            const nextError = elementCount === 0 && errorCount === 0 ? 'empty canvas — unmaterialized part' : undefined;
            const transitioned = previous?.status !== undefined && previous.status !== nextStatus;
            const entry = {
              status: nextStatus,
              attempts: (previous?.attempts ?? 0) + (transitioned ? 1 : 0),
              updatedAt: now,
              ...(nextError ? { error: nextError } : {}),
            };
            job.phases = {
              ...(job.phases ?? {}),
              layout: entry,
            };
            phaseWrites.push({
              outlineId,
              phase: 'layout',
              ...entry,
            });
            // Legacy-course self-heal for the SIXTH phase: the semantics
            // section's missing phase entry is what constitutes unfinished
            // generation the sweep must close — one visit stamps deterministic
            // content-integrity truth beside the geometry truth. Attempts
            // ratchet on status transitions like the layout entry above.
            const prevSemantics = job.phases?.semantics as { status?: string; attempts?: number } | undefined;
            const semanticErrors = (contentResidual ?? []).filter(
              (finding) => finding.severity === 'error',
            );
            const nextSemantics =
              semanticErrors.length > 0
                ? {
                    status: 'failed',
                    error: semanticErrors.map((finding) => finding.message).join(' | ').slice(0, 200),
                  }
                : { status: 'done' };
            const semTransitioned =
              prevSemantics?.status !== undefined && prevSemantics.status !== nextSemantics.status;
            const semEntry = {
              status: nextSemantics.status,
              attempts:
                (prevSemantics?.attempts ?? 0) + (semTransitioned || !prevSemantics?.status ? 1 : 0),
              updatedAt: now,
              ...('error' in nextSemantics ? { error: String(nextSemantics.error) } : {}),
            } as { status: string; attempts: number; updatedAt: number; error?: string };
            job.phases = {
              ...(job.phases ?? {}),
              semantics: semEntry,
            };
            phaseWrites.push({
              outlineId,
              phase: 'semantics',
              ...semEntry,
            });
          }
        }
      }
      const beforeLedger = layoutLedgerOf(scene);
      // The visit stamp is the single clock for this scene's revision AND its
      // evidence: `checkedAt === updatedAt` is what lets the incremental
      // predicate skip the scene on future passes. A ledger-only write
      // refreshes evidence past the age cap; a content write doubles as the
      // revision for the store's stale-scene fence.
      const visitStamp = Date.now();
      const ledger = applyLayoutLedger(scene, residualAll, visitStamp);
      const evidenceExpired =
        !!beforeLedger && visitStamp - beforeLedger.checkedAt >= LAYOUT_EVIDENCE_MAX_AGE_MS;
      const ledgerChanged =
        !beforeLedger ||
        evidenceExpired ||
        beforeLedger.errors !== ledger.errors ||
        beforeLedger.warnings !== ledger.warnings;
      // Convergence fix for the audit epoch: a scene whose existing evidence
      // predates the content audit is geometry-only coverage — the visit must
      // re-stamp even when nothing else changed, or the scene is re-visited
      // on every pass forever (never fresh, findings never recorded).
      const epochExpired =
        !!beforeLedger && beforeLedger.checkedAt < CONTENT_AUDIT_EPOCH_MS;
      const needsWrite = plan !== null || passChanged || ledgerChanged || epochExpired;
      if (needsWrite) {
        try {
          (scene as { updatedAt?: number }).updatedAt = visitStamp;
          await documentStore.putScene(courseId, scene as never);
          applied = true;
        } catch (error) {
          console.error('[layout-relayout] putScene failed', scene.id, error);
          continue;
        }
      }
      reports.push({
        ...(plan ?? {
          sceneId: scene.id,
          sceneTitle: scene.title ?? '',
          moved: [],
          keptPinned: [],
          overflowRows: [],
          fitsWithoutMerge: true,
          findingsBefore: [],
          findingsAfter: [],
        }),
        applied,
        residualErrors: errorCount,
        residualWarnings: warnCount,
        mergedDeleted,
        ...(deadAnchorStrips > 0 ? { deadAnchorsStripped: deadAnchorStrips } : {}),
        ...(contentResidual.length > 0 ? { contentFindings: contentResidual } : {}),
        ...(provenanceStripped.length > 0 ? { provenanceStripped } : {}),
      });
    } else {
      // Dry run reports the pre-pass plan: no mutation, so no honest
      // post-pass plan exists — prePlan is exactly what a real run would see
      // on entry. The tier-1 content audit rides the pre-pass side too.
      const before = residualFindings(scene);
      const beforeContent = [
        ...auditScene(scene, splitFamilyDupIndex.get((scene as { id?: string }).id ?? '')),
        ...sceneTitleFindings(scene),
      ];
      const residualBefore = [...before, ...beforeContent];
      const beforeErrors = residualBefore.filter((f) => f.severity === 'error').length;
      reports.push({
        ...(prePlan ?? {
          sceneId: scene.id,
          sceneTitle: scene.title ?? '',
          moved: [],
          keptPinned: [],
          overflowRows: [],
          fitsWithoutMerge: true,
          findingsBefore: [],
          findingsAfter: [],
        }),
        applied,
        residualErrors: beforeErrors,
        residualWarnings: beforeContent.length,
        mergedDeleted,
        ...(beforeContent.length > 0 ? { contentFindings: beforeContent } : {}),
      });
    }
  }

  // One coalesced write for every phase stamp this run produced — the
  // envelope is the single red/green source for the lesson list, so the
  // stamps must survive the request boundary.
  if (!body.dryRun && phaseWrites.length > 0) {
    await documentStore.putPhaseStates(courseId, phaseWrites as never).catch((error) => {
      console.warn('[layout-relayout] phase write failed (non-fatal)', (error as Error).message.slice(0, 140));
    });
  }

  return {
    ok: true,
    payload: {
      courseId,
      dryRun: body.dryRun === true,
      scenesScanned: targets.length,
      scenesPlanned: reports.length,
      pruned,
      skippedFresh,
      reports,
    },
  };
}

async function isUnauthorized(request: NextRequest): Promise<boolean> {
  const token = process.env.PERSISTENCE_DEV_TOKEN;
  const authorization = request.headers.get('authorization');
  if (!token) return true;
  return !authorization || authorization !== `Bearer ${token}`;
}
