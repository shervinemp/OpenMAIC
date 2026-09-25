/**
 * Scene Content Generation API
 *
 * Generates scene content (slides/quiz/interactive/pbl) from an outline.
 * This is the first half of the two-step scene generation pipeline.
 * Does NOT generate actions — use /api/generate/scene-actions for that.
 */

import { NextRequest } from 'next/server';
import { callLLM } from '@/lib/ai/llm';
import {
  applyOutlineFallbacks,
  generateSceneContent,
  buildVisionUserContent,
  partitionImagesForVision,
  type AgentInfo,
} from '@openmaic/generation';
import type {
  SceneOutline,
  PdfImage,
  ImageMapping,
  UserRequirements,
  } from '@/lib/types/generation';
import type { ThinkingConfig } from '@/lib/types/provider';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { llmApiError } from '@/lib/server/llm-error-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import { resolveVocationalActive } from '@/lib/config/feature-flags';
import { MAX_VISION_IMAGES } from '@/lib/constants/generation';
import { sortDocumentImagesForVision } from '@/lib/document/bundle';
import {
  resolveVisionImagesForPrompt,
  type VisionPromptImage,
} from '@/lib/persistence/resolve-vision-images';
import { takeSceneDepthReport, takeSceneDepthSummary } from '@/lib/generation/content-depth';
import { buildUnitContext } from '@/lib/generation/unit-context';
import {
  describeSceneFailure,
  recordSceneFailure,
  takeSceneFailure,
} from '@/lib/server/scene-failure-ledger';

const log = createLogger('Scene Content API');

export const maxDuration = 300;

/**
 * Hard ceiling on OUTPUT tokens for one scene-content call. Valid scene JSON is
 * small (a successful generation in the wild lands in ~3.5–11.5k output tokens
 * regardless of kind); a run far past this is a reasoning loop burning budget
 * without finishing — clipping clobbers no real output and turns a minutes-long
 * 500 into a fast, retryable failure. `budgetTokens` remains the SOFT lever
 * (OPENMAIC_THINKING_PRESET / MODEL_ROUTES); this cap only bounds the worst
 * pathological case while keeping a ~2x margin over any observed success.
 *
 * Providers count reasoning inside the output budget, so a thinking-enabled
 * judgment stage (interactive/derivation/exercise/freeResponse) would otherwise
 * crowd its own JSON payload out of the same 16k envelope. When the resolved
 * ThinkingConfig carries an EXPLICIT reasoning budget, that budget is added as
 * headroom above the base cap — the tripwire still catches unbounded reasoning
 * loops, but anticipated reasoning can never starve the payload. Mindful of the
 * same failure anatomy, an `enabled` config with NO explicit budget keeps the
 * base cap: unbounded provider-default reasoning is exactly the pathological
 * case this cap exists to fail fast on.
 */
const SCENE_CONTENT_OUTPUT_CAP = 16_000;

/** Explicit reasoning budget to shield from the output cap, if any. */
function sceneReasoningHeadroom(thinking: ThinkingConfig | undefined): number {
  if (!thinking || thinking.enabled === false) return 0;
  const budget = thinking.budgetTokens;
  return typeof budget === 'number' && Number.isFinite(budget) && budget > 0 ? budget : 0;
}

/** Never exceed the model's real output window; use the cap when it is smaller. */
function clampSceneContentOutputBudget(
  outputWindow: number | undefined,
  thinking?: ThinkingConfig,
): number | undefined {
  const headroom = sceneReasoningHeadroom(thinking);
  if (typeof outputWindow !== 'number' || !Number.isFinite(outputWindow) || outputWindow <= 0) {
    return SCENE_CONTENT_OUTPUT_CAP + headroom;
  }
  return Math.min(outputWindow, SCENE_CONTENT_OUTPUT_CAP + headroom);
}

/**
 * Aggregate budget for the WHOLE resolve-with-refill phase, reused from the
 * shared 15 s ingest-drain constant (the same constant the extraction cache's
 * probe phase reuses). Each probe is an unbounded server-side store round trip
 * (no statement timeout), so an all-fail phase must not churn every candidate
 * sequentially: when the budget expires the phase STOPS and generation
 * proceeds with whatever resolved so far (degrade, never fail).
 */
const VISION_RESOLUTION_BUDGET_MS = 15_000;

/**
 * Consecutive-failure fuse for the resolve-with-refill loop: after this many
 * unresolvable/errored candidates IN A ROW the store is evidently down, so
 * probing stops instead of churning the remaining candidates (one summary warn
 * names the fuse). A resolved candidate resets the streak.
 */
const MAX_CONSECUTIVE_UNRESOLVABLE_VISION_IMAGES = 3;

export async function POST(req: NextRequest) {
  let outlineTitle: string | undefined;
  let resolvedModelString: string | undefined;
  try {
    const body = await req.json();
    const {
      outline: rawOutline,
      allOutlines,
      pdfImages,
      imageMapping,
      stageInfo: _stageInfo,
      stageId,
      agents,
      languageDirective,
      requirements,
    } = body as {
      outline: SceneOutline;
      allOutlines: SceneOutline[];
      pdfImages?: PdfImage[];
      imageMapping?: ImageMapping;
      stageInfo: {
        name: string;
        description?: string;
        style?: string;
      };
      stageId: string;
      agents?: AgentInfo[];
      languageDirective?: string;
      requirements?: UserRequirements;
    };

    // Validate required fields
    if (!rawOutline) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'outline is required');
    }
    if (!allOutlines || allOutlines.length === 0) {
      return apiError(
        'MISSING_REQUIRED_FIELD',
        400,
        'allOutlines is required and must not be empty',
      );
    }
    if (!stageId) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'stageId is required');
    }

    const outline: SceneOutline = { ...rawOutline };

    // ── Model resolution from request headers/body ──
    // Route per scene-content type (e.g. `scene-content:quiz`); getStageModel
    // falls back to the base `scene-content` route when the type is unrouted.
    const stage = outline.type ? (`scene-content:${outline.type}` as const) : 'scene-content';
    const {
      model: languageModel,
      modelInfo,
      modelString,
      thinkingConfig,
    } = await resolveModelFromRequest(req, body, stage);
    outlineTitle = rawOutline?.title;
    resolvedModelString = modelString;

    // One precomputed output budget for every scene-content call below: the
    // 16k tripwire plus any explicit reasoning headroom (see the cap comment).
    const sceneOutputBudget = clampSceneContentOutputBudget(
      modelInfo?.outputWindow,
      thinkingConfig,
    );

    // ── Reasoning-collapse handling (Options A + C) ──
    // deepseek-style reasoners do not honor `budgetTokens`: when a judgment
    // stage's scratchpad overshoots, the whole output allowance can be consumed
    // by reasoning with zero answer left (`output 24000 (reasoning 24000)` in
    // the wild) — the downstream JSON parse then fails after a ~2min burn that
    // NO client retry can rescue, because every retry re-derives reasoning.
    // (a) Option C, prompt-side: a small convergence nudge appended to the
    // system prompt only when thinking is active; soft, but measurably nudges
    // scratchpad loops to converge earlier.
    // (b) Option A, call-side: when a thinking call comes back with (near-)
    // empty completions while thinking was enabled, IMMEDIATELY re-issue the
    // same call with thinking hard-disabled at the base cap. Deepseek cannot
    // be budgeted, so `enabled:false` is the only reliable lever; input tokens
    // are mostly cache-read hits (observed ~8–10k cached), so the salvage
    // retry is cheap. A non-thinking failure stays untouched — it is some
    // other validation/depth problem, not one thinking can be blamed for.
    const thinkingIsEnabled = !!thinkingConfig && thinkingConfig.enabled !== false;
    const REASONING_COLLAPSE_TRIGGER_CHARS = 40;
    const CONVERGENCE_NUDGE =
      ' Reasoning-budget note: your scratchpad shares a finite output budget with the final JSON. ' +
      'Keep reasoning brief, converge quickly, and ALWAYS finish with the complete JSON answer.';

    /** A result so short it carries no usable scene JSON. */
    function isReasoningCollapse(text: string | undefined): boolean {
      return (text ?? '').trim().length < REASONING_COLLAPSE_TRIGGER_CHARS;
    }

    const callWithoutThinking = async (
      buildParams: (maxTokens?: number) => Parameters<typeof callLLM>[0],
    ): Promise<string> => {
      const disabledThinking = { ...thinkingConfig, enabled: false } as ThinkingConfig;
      log.warn(
        `Reasoning-collapse detected (near-empty payload with thinking on) for "${outlineTitle ?? 'unknown'}"; one salvage retry with thinking disabled at the base cap.`,
      );
      const result = await callLLM(
        buildParams(clampSceneContentOutputBudget(modelInfo?.outputWindow, disabledThinking)),
        'scene-content',
        undefined,
        disabledThinking,
      );
      return result.text;
    };

    // Detect vision capability
    const hasVision = !!modelInfo?.capabilities?.vision;

    // Vision-aware AI call function. On a server-backed transport the
    // `imageMapping` values are allocated asset ids; the N3 pre-resolution
    // below has already resolved the vision slice's ids to bytes and stripped
    // every unresolvable id from the mapping, so the srcs this closure sees
    // are concrete data URLs and this resolution is a DEFENSIVE NO-OP — it
    // passes concrete srcs through untouched (RFC #1153 part 2 B) and would
    // only drop an id that still carried an allocated id, which the
    // pre-resolution makes impossible. Kept so a package consumer that
    // generates without pre-resolving still degrades cleanly.
    const aiCall = async (
      systemPrompt: string,
      userPrompt: string,
      images?: Array<{ id: string; src: string }>,
    ): Promise<string> => {
      const effectiveSystem = thinkingIsEnabled ? systemPrompt + CONVERGENCE_NUDGE : systemPrompt;

      let result: string;
      if (images?.length && hasVision) {
        // Server-backed transport: `imageMapping` values are allocated asset
        // ids, so the image srcs reach here as ids. Resolve them to the same
        // bytes the base64 path would send BEFORE prompt assembly, keeping the
        // vision prompt byte-identical in both modes (RFC #1153 part 2 B).
        const resolvedImages = await resolveVisionImagesForPrompt(images, req.headers);
        const callParams = (maxTokens: number | undefined) => ({
          model: languageModel,
          system: effectiveSystem,
          messages: [
            {
              role: 'user' as const,
              content: buildVisionUserContent(userPrompt, resolvedImages),
            },
          ],
          maxOutputTokens: maxTokens ?? sceneOutputBudget,
          maxRetries: 0,
        } as Parameters<typeof callLLM>[0]);
        const first = await callLLM(
          callParams(sceneOutputBudget),
          'scene-content',
          undefined,
          thinkingConfig,
        );
        result = isReasoningCollapse(first.text) && thinkingIsEnabled
          ? await callWithoutThinking((maxTokens) => callParams(maxTokens as number))
          : first.text;
      } else {
        const callParams = (maxTokens: number | undefined) => ({
          model: languageModel,
          system: effectiveSystem,
          prompt: userPrompt,
          maxOutputTokens: maxTokens ?? sceneOutputBudget,
          maxRetries: 0,
        } as Parameters<typeof callLLM>[0]);
        const first = await callLLM(
          callParams(sceneOutputBudget),
          'scene-content',
          undefined,
          thinkingConfig,
        );
        result = isReasoningCollapse(first.text) && thinkingIsEnabled
          ? await callWithoutThinking(callParams)
          : first.text;
      }
      return result;
    };

    // ── Apply fallbacks ──
    const vocationalActive = resolveVocationalActive(requirements);
    const effectiveOutline = applyOutlineFallbacks(outline, !!languageModel, {
      allowProceduralSkill: vocationalActive,
    });

    // ── Filter images assigned to this outline ──
    let assignedImages: PdfImage[] | undefined;
    if (
      pdfImages &&
      pdfImages.length > 0 &&
      effectiveOutline.suggestedImageIds &&
      effectiveOutline.suggestedImageIds.length > 0
    ) {
      const suggestedIds = new Set(effectiveOutline.suggestedImageIds);
      assignedImages = sortDocumentImagesForVision(
        pdfImages.filter((img) => suggestedIds.has(img.id)),
      );
    }

    // ── N3: resolve-then-slice the vision candidates BEFORE prompt assembly ──
    // The prompt text and the multimodal attachments must be built from the
    // SAME resolved set: an image the server cannot resolve (a reclaimed
    // asset, a store failure) is dropped from BOTH — its `[see attached]`
    // text mention and its attachment — instead of leaving a dangling promise
    // in the prompt. The candidates are computed in the generator's OWN order
    // (the shared `partitionImagesForVision` helper, so the route and the
    // generator cannot drift) and resolved IN ORDER with refill until the cap
    // is met or the candidates are exhausted: a drop admits the next image
    // WITH its resolution, so the generator's re-slice (same helper, same
    // cap) can never admit an image this route has not resolved (review P2).
    // Every id the resolution drops is STRIPPED from the `imageMapping` (and
    // `assignedImages`) passed onward, so a model-hallucinated reference to a
    // dropped id takes the existing clean "no mapping → remove element" path
    // in `resolveImageIds` instead of writing a dangling allocated id into
    // `src` (review P3). The resolved slice is passed to the generator so
    // `aiCall` does not re-resolve (its resolution is a defensive no-op).
    let visionImageMapping: ImageMapping | undefined = imageMapping;
    let resolvedVisionImages: VisionPromptImage[] | undefined;
    if (assignedImages && assignedImages.length > 0 && hasVision && imageMapping) {
      const { withSrc } = partitionImagesForVision(assignedImages, imageMapping, MAX_VISION_IMAGES);
      // Bound the resolve-with-refill loop (review P2, round 3): the store may
      // be down, and each probe is an unbounded server-side round trip, so an
      // all-fail phase must not churn every candidate (and emit a warn per
      // candidate) until the route's 300 s platform cap. Two stops, both
      // degrading to "whatever resolved so far" — never failing the request:
      // (a) an aggregate budget for the WHOLE phase (the shared 15 s ingest
      // constant, raced against each probe so even ONE hanging probe cannot
      // outlive it) and (b) a consecutive-failure fuse (3 unresolvable/errored
      // candidates in a row → stop). When a stop fires, every candidate that
      // did not resolve — unresolvable OR unprobed — is STRIPPED from the
      // mapping, so the generator can never hand an unresolved allocated id to
      // the defensive aiCall resolution (which would re-open the unbounded
      // probe the stop just closed); ONE summary warn names the stop.
      let phaseTimer: ReturnType<typeof setTimeout> | undefined;
      const phaseBudget = new Promise<'__vision-resolution-budget-expired__'>((resolve) => {
        phaseTimer = setTimeout(
          () => resolve('__vision-resolution-budget-expired__'),
          VISION_RESOLUTION_BUDGET_MS,
        );
      });
      const resolvedById = new Map<string, VisionPromptImage>();
      let consecutiveUnresolvable = 0;
      let stopReason: 'fuse' | 'budget' | null = null;
      for (const candidate of withSrc) {
        if (resolvedById.size >= MAX_VISION_IMAGES) break;
        if (consecutiveUnresolvable >= MAX_CONSECUTIVE_UNRESOLVABLE_VISION_IMAGES) {
          stopReason = 'fuse';
          break;
        }
        let attempted: VisionPromptImage[] | '__vision-resolution-budget-expired__';
        try {
          attempted = await Promise.race([
            resolveVisionImagesForPrompt(
              [
                {
                  id: candidate.id,
                  src: imageMapping[candidate.id],
                  ...(candidate.width !== undefined ? { width: candidate.width } : {}),
                  ...(candidate.height !== undefined ? { height: candidate.height } : {}),
                },
              ],
              req.headers,
            ),
            phaseBudget,
          ]);
        } catch (error) {
          // A throwing probe counts as an unresolvable candidate (an errored
          // store must degrade, never fail the request).
          log.error(
            `Vision image resolution probe for "${candidate.id}" failed; treating it as unresolvable:`,
            error,
          );
          attempted = [];
        }
        if (attempted === '__vision-resolution-budget-expired__') {
          stopReason = 'budget';
          break;
        }
        if (attempted.length === 1) {
          resolvedById.set(attempted[0]!.id, attempted[0]!);
          consecutiveUnresolvable = 0;
        } else {
          consecutiveUnresolvable += 1;
        }
      }
      if (phaseTimer !== undefined) clearTimeout(phaseTimer);
      resolvedVisionImages = [...resolvedById.values()];
      // Every candidate that did not resolve — an unresolvable probe, OR an
      // unprobed one when the fuse/budget stopped the phase — is stripped from
      // the mapping and the assigned set, so the generator's re-slice (same
      // helper, same cap) can never admit an image this route has not resolved
      // (possibly all of them = text-only generation).
      const droppedIds = new Set(
        withSrc
          .filter((candidate) => !resolvedById.has(candidate.id))
          .map((candidate) => candidate.id),
      );
      if (droppedIds.size > 0) {
        assignedImages = assignedImages.filter((img) => !droppedIds.has(img.id));
        visionImageMapping = Object.fromEntries(
          Object.entries(imageMapping).filter(([id]) => !droppedIds.has(id)),
        );
      }
      if (stopReason !== null) {
        log.warn(
          `Stopped probing vision image candidates early: the ${
            stopReason === 'fuse'
              ? `consecutive-failure fuse (${MAX_CONSECUTIVE_UNRESOLVABLE_VISION_IMAGES} unresolvable in a row)`
              : `${VISION_RESOLUTION_BUDGET_MS}ms aggregate resolution budget`
          } fired; proceeding to generation with ${resolvedById.size} resolved image(s) and the rest dropped to text-only (degrade, not fail).`,
        );
      }
    }

    // ── Media generation is handled client-side in parallel (media-orchestrator.ts) ──
    // The content generator receives placeholder IDs (gen_img_1, gen_vid_1) as-is.
    // resolveImageIds() in generation-pipeline.ts will keep these placeholders in elements.
    const generatedMediaMapping: ImageMapping = {};

    // ── Generate content ──
    log.info(
      `Generating content: "${effectiveOutline.title}" (${effectiveOutline.type}) [model=${modelString}]`,
    );

    const userLocale = req.headers?.get('x-user-locale') ?? '';

    const content = await generateSceneContent(effectiveOutline, aiCall, {
      assignedImages,
      imageMapping: visionImageMapping,
      languageModel: effectiveOutline.type === 'pbl' ? languageModel : undefined,
      visionEnabled: hasVision,
      generatedMediaMapping,
      resolvedVisionImages,
      agents,
      languageDirective,
      thinkingConfig,
      targetLanguage: userLocale || undefined,
      userRequirements: requirements,
      allowProceduralSkill: vocationalActive,
      retrievalContext: effectiveOutline.retrievalContext,
      // Phase 2 §15.5: prerequisite coherence — thread what the unit has
      // already taught so this scene builds on it instead of repeating it.
      unitContext: buildUnitContext(effectiveOutline, allOutlines),
      onFailure: (failure) => {
        recordSceneFailure({
          ...failure,
          outlineId: effectiveOutline.id,
          outlineTitle: effectiveOutline.title,
          sceneType: effectiveOutline.type,
          model: modelString,
          at: Date.now(),
        });
      },
    });

    if (!content) {
      log.error(`Failed to generate content for: "${effectiveOutline.title}"`);

      // Failure ledger: surface the concrete cause (failure code raised by the
      // scene type + depth findings from corrective-loop exhaustion) instead
      // of a black box, on both the log line and the client's retry card.
      const failureRecord = takeSceneFailure(effectiveOutline.id);
      const depthReport = takeSceneDepthReport(effectiveOutline.id);
      if (failureRecord) {
        failureRecord.findings ??= depthReport?.findings;
      }
      const failureDetail = describeSceneFailure(failureRecord);
      const depthDetail = depthReport
        ? ` — depth contract: ${depthReport.findings.join('; ')}`
        : '';
      const detail = failureDetail ?? (depthDetail ? `depth contract rejected${depthDetail}` : '');

      log.error(
        `Failed to generate content for: "${effectiveOutline.title}" — reason: ${
          detail || 'none recorded (no onFailure raise, no depth report; pipeline returned null silently)'
        } [model=${modelString ?? 'unknown'}, sceneType=${effectiveOutline.type}]`,
      );

      return apiError(
        'GENERATION_FAILED',
        500,
        `Failed to generate content: ${effectiveOutline.title}${
          detail ? ` (${detail}${depthReport ? '' : depthDetail})` : ''
        }`,
      );
    }

    log.info(`Content generated successfully: "${effectiveOutline.title}"`);

    // Depth affordance: tell the client when the accepted content needed
    // corrective re-prompting (or record a first-try pass for completeness).
    const depthSummary =
      takeSceneDepthSummary(effectiveOutline.id) ??
      (content
        ? { reworked: false, attempts: 1, findings: [] }
        : undefined);

    return apiSuccess({ content, effectiveOutline, depth: depthSummary });
  } catch (error) {
    log.error(
      `Scene content generation failed [scene="${outlineTitle ?? 'unknown'}", model=${resolvedModelString ?? 'unknown'}]:`,
      error,
    );
    return llmApiError(error);
  }
}
