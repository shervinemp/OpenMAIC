import type { callLLM } from '@/lib/ai/llm';

/**
 * Semantic review — the human-confirmed tier of the maintenance doctrine.
 * READ-ONLY: every finding lands in a report the owner reviews; nothing is
 * auto-repaired. One LLM call per candidate scene (candidates are narrowed by
 * the token-free prefilters first) so the pass stays dollar-cheap.
 */

interface SemanticVerdict {
  spotlightMismatches: Array<{
    speechIndex: number;
    highlightedElementId: string;
    betterElementId?: string;
    reason: string;
    confidence: number;
  }>;
  conceptBeforeSubject: Array<{ elementId: string; reason: string }>;
  duplicateLessonNeighbor?: string | null;
  figureGap: { expected?: string };
}

interface SemanticOutput extends SemanticVerdict {
  pairVerdicts?: Array<{
    proxyIndex: number;
    matched: boolean;
    reason?: string;
    betterElementId?: string;
    confidence?: number;
  }>;
}

const stripHtml = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

const SYSTEM_PROMPT = [
  'You review ONE narrated course slide: a list of visible elements (id + text) and the action sequence (speeches and spotlights, in order).',
  'The sequence plays top-down; the cheap proxy narrows suspicious spotlight pairs (`proxySuspects`, indexes into `actions`).',
  'For EVERY index in proxySuspects: judge it explicitly. The proxy only measures word overlap — it CANNOT see intent; confirm or clear each with a reason.',
  'Report exactly these semantic defects, else empty arrays:',
  '1. spotlightMismatches: the narration names a DIFFERENT concrete subject than the text body of the highlighted element (e.g. the speech teaches "dim_customer: CustomerKey plus effective-date columns" while the highlighted row text reads "dim_date: DateKey, Year, Quarter…" — that IS a mismatch; set betterElementId to the row whose text matches the narration, if one exists on this slide). A spotlight is NOT a mismatch when the narration is about the slide as a whole (title framing, introductory or recap sentences) or the narration visibly deep-dives the highlighted element\'s own text.',
  'Judge the matching speech, then the highlighted element. A pair is mismatched when the narration names a concrete subject that the highlighted element does not depict, per the dim_customer/dim_date example above.',
  'For every proxySuspect index you MUST emit a pairVerdict — clearance is an explicit judgment ({"matched":true,"reason":"…"}), never silence: coverage over tolerance.',
  "A mismatch is ANY case where the narrative subject differs from the highlighted element's topic: e.g. narration discusses dim_customer while the highlight text names dim_date",
  '2. conceptBeforeSubject: the narration TEACHES a named subject that only appears (visibly) on a LATER page of the same lesson — only if the caller supplies sibling pages.',
  '3. duplicateLessonNeighbor: this page-body substantially duplicates the neighbor lesson passed in (deliberate "recap" wording is NOT a duplicate). Omit when none.',
  '4. figureGap: true ONLY if the title promises a shape/diagram/anatomy (star schema, architecture, anatomy, comparison layout) and the canvas has no graphical/structural element (tables, boxes, spokes) — pure scattered text chips do not count.',
  'Return STRICT JSON with pairVerdicts FIRST — one entry per proxySuspects index: {"pairVerdicts":[{"proxyIndex":0,"matched":false,"reason":"…","betterElementId":"text_…","confidence":0.8}],"spotlightMismatches":[],"conceptBeforeSubject":[],"duplicateLessonNeighbor":"","figureGap":{}}. Every key must be present (empty arrays/objects when clean).',
].join('\n');

function buildRequest(
  scene: {
    id: string;
    title: string;
    order?: number;
    actions?: ReadonlyArray<{ type?: string; elementId?: string; text?: string }>;
    content?: { canvas?: { elements?: ReadonlyArray<Record<string, unknown>> } };
  },
  proxyCandidates: number[] = [],
): string {
  const elements = (scene.content?.canvas?.elements ?? []).map((el) => ({
    id: (el as { id?: string }).id,
    type: (el as { type?: string }).type,
    text: stripHtml(String((el as { content?: string }).content ?? '')).slice(0, 200),
  }));
  const actions = (scene.actions ?? []).map((a, i) => ({
    i,
    type: a.type,
    elementId: a.elementId,
    ...(typeof a.text === 'string' ? { text: a.text.slice(0, 240) } : {}),
  }));
  return JSON.stringify(
    {
      sceneId: scene.id,
      title: scene.title,
      order: scene.order,
      elements,
      actions,
      // Proxy-flagged spotlight indexes: adjudicate EACH of these explicitly
      // (verdict per pair) — the cheap overlap filter narrows the room to the
      // pairs that must be judged; also inspect any others you judge suspect.
      proxySuspects: proxyCandidates,
    },
    null,
    0,
  );
}

export interface SemanticReviewBudget {
  used: number;
  limit: number;
}

export function budgetCrossed(budget: SemanticReviewBudget): boolean {
  return budget.used >= budget.limit;
}

export function isReviewCandidate(scene: {
  actions?: ReadonlyArray<{ type?: string; elementId?: string; text?: string }>;
}): boolean {
  // Only scenes with narration + at least one anchored highlight promote: a
  // semantic judge call over a static page has no spotlight to be wrong with.
  const actions = scene.actions ?? [];
  return actions.some((a) => a.type === 'speech') && actions.some((a) => Boolean(a.elementId));
}

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'of',
  'to',
  'in',
  'is',
  'and',
  'or',
  'it',
  'you',
  'your',
  'we',
  'this',
  'that',
  'on',
  'for',
  'with',
  'as',
  'are',
  'be',
  'by',
  'from',
  'at',
  'so',
  'not',
  'have',
  'has',
  'was',
  'what',
  'when',
  'which',
  'their',
  'they',
  'then',
  'than',
  'into',
  'its',
]);

const stripHtmlPlain = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/**
 * Token-free proxy (the judge's doorman): a spotlight pair is suspicious when
 * the narration shares NO content word (length > 4) with the highlighted row's
 * text at all. Cheap and noisy by design — the judge turns candidates into
 * verdicts; this only decides WHICH spotlight the judge must examine. Returns
 * the suspicious spotlight indexes.
 */
export function spotlightProxyCandidates(scene: {
  actions?: ReadonlyArray<{ type?: string; elementId?: string; text?: string }>;
  content?: { canvas?: { elements?: ReadonlyArray<Record<string, unknown>> } };
}): number[] {
  const actions = scene.actions ?? [];
  const bodies = new Map<string, string>();
  for (const el of scene.content?.canvas?.elements ?? []) {
    const id = (el as { id?: string }).id;
    if (typeof id === 'string')
      bodies.set(id, stripHtmlPlain(String((el as { content?: string }).content ?? '')));
  }
  const flagged: number[] = [];
  for (let i = 0; i < actions.length; i += 1) {
    const action = actions[i];
    if (action.type !== 'spotlight' || typeof action.elementId !== 'string') continue;
    let speech: string | undefined;
    for (let j = i - 1; j >= 0; j -= 1) {
      if (actions[j]?.type === 'speech') {
        speech = actions[j]?.text;
        break;
      }
    }
    if (!speech) continue;
    const target = (bodies.get(action.elementId) ?? '')
      .split(/\s+/)
      .filter((word) => word.length > 4 && !STOP_WORDS.has(word));
    const speechWords = new Set(stripHtmlPlain(speech).split(/\s+/));
    if (target.length > 0 && !target.some((word) => speechWords.has(word))) {
      // Only flag when the pair's row is textual: a chart/image with no
      // narration word overlap is the proxy's known FP corner.
      const highlightedType = (scene.content?.canvas?.elements ?? []).find(
        (el) => (el as { id?: string }).id === action.elementId,
      ) as { type?: string } | undefined;
      if (highlightedType && highlightedType.type !== 'text') continue;
      flagged.push(i);
    }
  }
  return flagged;
}

export interface JudgeOutcome {
  verdict: SemanticVerdict | null;
  /** Diagnosis for a null verdict (provider empty / unparsable / outage). */
  error?: string;
}

/**
 * Judge one scene. Structural failures (provider outage, malformed JSON)
 * resolve to `verdict: null` with a diagnostic — the review is best-effort and
 * never blocks a pass.
 */
export async function judgeScene(params: {
  scene: Parameters<typeof buildRequest>[0];
  callLLMImpl: typeof callLLM;
  model: Parameters<typeof callLLM>[0] extends { model: infer M } ? M : string;
  thinkingConfig?: unknown;
}): Promise<JudgeOutcome> {
  const { scene, callLLMImpl, model, thinkingConfig } = params;
  try {
    const result = await callLLMImpl(
      {
        model,
        system: SYSTEM_PROMPT,
        prompt: buildRequest(scene, spotlightProxyCandidates(scene)),
        maxOutputTokens: 4096,
        maxRetries: 0,
      } as never,
      'scene-verify',
      undefined,
      thinkingConfig ?? undefined,
    );
    const text = result.text ?? '';
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart < 0 || jsonEnd <= jsonStart) {
      return {
        verdict: null,
        error: `unparsable response (finishReason: ${
          (result as { finishReason?: string }).finishReason
        }, len ${text.length})`,
      };
    }
    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as Partial<SemanticOutput>;
    const spotlightMismatchesFromModel = Array.isArray(parsed.spotlightMismatches)
      ? parsed.spotlightMismatches.filter(
          (m) => typeof m?.highlightedElementId === 'string' && typeof m?.reason === 'string',
        )
      : [];
    // Forced pair verdicts: the judge must adjudicate every proxy suspect.
    // A cleared pair needs an explicit {matched: true}; missing entries and
    // `matched: false` become mismatches — silence is not clearance.
    // Forced pair verdicts: the judge must adjudicate every proxy suspect
    // with an explicit `{matched: true}` to clear it. Missing verdicts and
    // `matched: false` entries become mismatches — silence is not clearance.
    const actions = scene.actions ?? [];
    const pairVerdicts = Array.isArray(parsed.pairVerdicts) ? parsed.pairVerdicts : [];
    for (const proxyIndex of spotlightProxyCandidates(scene)) {
      const entry = pairVerdicts.find((candidate) => Number(candidate?.proxyIndex) === proxyIndex);
      if (entry?.matched === true) continue;
      const spotlight = actions[proxyIndex] as { elementId?: string } | undefined;
      const elementId = typeof spotlight?.elementId === 'string' ? spotlight.elementId : 'unknown';
      if (spotlightMismatchesFromModel.some((m) => m.highlightedElementId === elementId)) continue;
      let speechIndex = -1;
      for (let j = proxyIndex - 1; j >= 0; j -= 1) {
        if (actions[j]?.type === 'speech') {
          speechIndex = j;
          break;
        }
      }
      spotlightMismatchesFromModel.push({
        speechIndex,
        highlightedElementId: elementId,
        ...(typeof entry?.betterElementId === 'string'
          ? { betterElementId: entry.betterElementId }
          : {}),
        reason:
          typeof entry?.reason === 'string' && entry.reason
            ? entry.reason
            : 'judge did not return an explicit verdict for this flagged pair',
        confidence: typeof entry?.confidence === 'number' ? entry.confidence : 1,
      });
    }
    return {
      verdict: {
        spotlightMismatches: spotlightMismatchesFromModel,
        conceptBeforeSubject: Array.isArray(parsed.conceptBeforeSubject)
          ? parsed.conceptBeforeSubject.filter((c) => typeof c?.elementId === 'string')
          : [],
        duplicateLessonNeighbor:
          typeof parsed.duplicateLessonNeighbor === 'string'
            ? parsed.duplicateLessonNeighbor
            : undefined,
        figureGap: parsed.figureGap && typeof parsed.figureGap === 'object' ? parsed.figureGap : {},
      },
    };
  } catch (error) {
    return { verdict: null, error: (error as Error)?.message?.slice(0, 200) ?? String(error) };
  }
}

export { SYSTEM_PROMPT as SEMANTIC_REVIEW_PROMPT, buildRequest as buildSemanticReviewRequest };
export type { SemanticVerdict };
