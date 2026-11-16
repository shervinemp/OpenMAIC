/**
 * Token-free doorman for the per-lesson outline review gate.
 *
 * The gate's LLM judge is the expensive half of the check: it runs on every
 * lesson attempt, and a rejection buys a whole lesson regeneration. Most decks
 * satisfy the judge's rubric in ways a deterministic pass can establish from
 * the outlines themselves, so this prefilter clears those decks without a
 * model call. Everything it cannot clear goes to the judge exactly as before.
 *
 * The decision is ACCEPT-ONLY. There is deliberately no `reject`: a false
 * negative costs the judge call we were already paying, while a false positive
 * would ship an unreviewed deck. So each check mirrors one of the judge's own
 * criteria and is written to fail closed:
 *
 *  - Coverage  - every objective has one scene carrying its content terms
 *                (all of them for a short objective; all but one for longer
 *                ones) - not just the lesson as a whole.
 *  - Depth     - every scene has a substantive description and two key points.
 *  - Sequencing - objectives are first carried in the order they are listed.
 *  - Redundancy - no repeated scene titles or identical key-point sets.
 *  - Fidelity  - the deck mentions the lesson title's distinctive terms.
 *
 * Text matching is script-aware through the shared tokenizer: space-delimited
 * words are stemmed, CJK runs contribute character bigrams, and pedagogical
 * verbs ("explain", "compare", ...) are dropped so coverage measures subject
 * matter rather than the Bloom verb.
 */
import { tokenize } from '@/lib/maintenance/narration-align';
import type { SceneOutline } from '@/lib/types/generation';

/** An objective is carried when a scene has all its terms, or all but one. */
function requiredCoverage(objectiveTokenCount: number): number {
  // A short objective must be carried whole; longer ones may miss one term
  // (a scene saying "virtual memory" still carries "how virtual memory works").
  return objectiveTokenCount <= 2 ? 1 : (objectiveTokenCount - 1) / objectiveTokenCount;
}

/** A description thinner than this is a placeholder, not a teaching plan. */
const MIN_DESCRIPTION_TOKENS = 3;

/** The judge's depth bar: concrete points, not a title restated. */
const MIN_KEY_POINTS = 2;

/**
 * Bloom-style verbs name the teaching action, not the subject. Dropping them
 * keeps "Compare threads and processes" about threads/processes instead of
 * rewarding a deck that only says "compare".
 */
const REVIEW_ACTION_WORDS = new Set([
  'analyse',
  'analyze',
  'apply',
  'calculate',
  'compare',
  'compute',
  'define',
  'demonstrate',
  'describe',
  'discuss',
  'evaluate',
  'explain',
  'identify',
  'illustrate',
  'introduce',
  'learn',
  'outline',
  'recognize',
  'summarize',
  'understand',
]);

/**
 * CJK objectives carry their Bloom verb as a leading bigram. Without dropping
 * it, a deck that teaches the subject still looks like it misses the verb.
 */
const CJK_ACTION_BIGRAMS = new Set([
  '了解',
  '分析',
  '分类',
  '判断',
  '掌握',
  '描述',
  '比较',
  '评价',
  '识别',
  '说明',
  '理解',
  '解释',
  '定义',
  '应用',
]);

/**
 * Function characters glue CJK words together. Bigrams containing one are
 * grammar, not subject matter, so they must not dilute coverage.
 */
const CJK_FUNCTION_CHARS = new Set([
  '的',
  '了',
  '和',
  '与',
  '及',
  '或',
  '在',
  '是',
  '为',
  '对',
  '从',
  '把',
  '被',
  '将',
  '中',
  '上',
  '下',
  '之',
  '其',
  '以',
  '于',
  '而',
  '就',
  '都',
  '也',
  '还',
  'の',
  'は',
  'が',
  'を',
  'に',
  'で',
  'と',
  'も',
  'へ',
  'や',
  'か',
]);

const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Title words that carry no subject; a title made only of these is skipped. */
const GENERIC_TITLE_WORDS = new Set([
  'basic',
  'chapter',
  'concept',
  'conclusion',
  'foundation',
  'introduction',
  'lesson',
  'overview',
  'part',
  'principle',
  'recap',
  'review',
  'summary',
  'topic',
  'unit',
]);

const VAGUE_DESCRIPTION_PREFIX =
  /^(introduce|introduces|discuss|discusses|cover|covers|explore|explores|present|presents|teach|teaches|overview of|learn about)\b/i;

export interface OutlineReviewPrefilterDeck {
  readonly title: string;
  readonly objectives: readonly string[];
}

export interface OutlineReviewPrefilterResult {
  /** True only when every free check passed. */
  readonly accept: boolean;
  /** Why the judge is still needed. Empty when accepted. */
  readonly reasons: readonly string[];
}

/** Light plural/tense folding so "scheduled" matches "scheduling". */
function stem(token: string): string {
  if (!/^[a-z0-9]+$/.test(token) || token.length < 5) return token;
  if (token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.endsWith('ing')) return token.slice(0, -3);
  if (token.endsWith('ed')) return token.slice(0, -2);
  if (/(?:ses|xes|zes|ches|shes)$/.test(token)) return token.slice(0, -2);
  if (token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

function contentTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const token of tokenize(text)) {
    if (REVIEW_ACTION_WORDS.has(token) || CJK_ACTION_BIGRAMS.has(token)) continue;
    if (CJK_CHAR.test(token) && [...token].some((char) => CJK_FUNCTION_CHARS.has(char))) {
      continue;
    }
    tokens.add(stem(token));
  }
  return tokens;
}

function normalizedSignature(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The fields the judge is shown; anything else would be invisible evidence. */
function sceneReviewText(outline: SceneOutline): string {
  return [outline.title, outline.description, ...(outline.keyPoints ?? []).slice(0, 5)].join(' ');
}

function overlapRatio(objective: Set<string>, scene: Set<string>): number {
  if (objective.size === 0) return 0;
  let hits = 0;
  for (const token of objective) {
    if (scene.has(token)) hits += 1;
  }
  return hits / objective.size;
}

function unionOfScenes(scenes: readonly Set<string>[]): Set<string> {
  const union = new Set<string>();
  for (const scene of scenes) {
    for (const token of scene) union.add(token);
  }
  return union;
}

export function prefilterOutlineReview(
  deck: OutlineReviewPrefilterDeck,
  outlines: readonly SceneOutline[],
): OutlineReviewPrefilterResult {
  const reasons: string[] = [];

  if (outlines.length === 0) {
    return { accept: false, reasons: ['deck has no scenes'] };
  }

  const seenTitles = new Set<string>();
  const seenKeyPointSets = new Set<string>();
  const sceneTokens: Set<string>[] = [];
  const subjectTokens = new Set<string>([
    ...contentTokens(deck.title ?? ''),
    ...deck.objectives.flatMap((objective) => [...contentTokens(objective)]),
  ]);

  outlines.forEach((outline, index) => {
    const label = `scene ${index + 1}`;
    const description = (outline.description ?? '').trim();
    const descriptionText = description.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

    if (
      contentTokens(description).size < MIN_DESCRIPTION_TOKENS ||
      (VAGUE_DESCRIPTION_PREFIX.test(descriptionText) && contentTokens(descriptionText).size < 8)
    ) {
      reasons.push(`${label} has a placeholder description`);
    }

    const keyPoints = (outline.keyPoints ?? []).filter((point) => point?.trim());
    if (keyPoints.length < MIN_KEY_POINTS) {
      reasons.push(`${label} has fewer than ${MIN_KEY_POINTS} key points`);
    }

    const titleKey = normalizedSignature(outline.title ?? '');
    if (titleKey) {
      if (seenTitles.has(titleKey)) reasons.push(`${label} repeats an earlier scene title`);
      seenTitles.add(titleKey);
    }

    if (keyPoints.length >= MIN_KEY_POINTS) {
      const keyPointSet = keyPoints.map(normalizedSignature).sort().join('|');
      if (keyPointSet) {
        if (seenKeyPointSets.has(keyPointSet)) {
          reasons.push(`${label} repeats an earlier scene's key points`);
        }
        seenKeyPointSets.add(keyPointSet);
      }
    }

    sceneTokens.push(contentTokens(sceneReviewText(outline)));
  });

  // Every scene must carry at least one subject term. Without this, one
  // on-topic scene surrounded by off-topic filler would clear the coverage
  // check while the judge's fidelity criterion still fails it.
  if (subjectTokens.size > 0) {
    sceneTokens.forEach((tokens, index) => {
      let onTopic = false;
      for (const token of subjectTokens) {
        if (tokens.has(token)) {
          onTopic = true;
          break;
        }
      }
      if (!onTopic) reasons.push(`scene ${index + 1} is off-topic for the lesson`);
    });
  }

  const objectives = deck.objectives.map((objective) => objective.trim()).filter(Boolean);
  let lastCoveringScene = -1;

  objectives.forEach((objective, index) => {
    const label = `objective ${index + 1}`;
    const tokens = contentTokens(objective);
    if (tokens.size === 0) {
      reasons.push(`${label} has no checkable subject matter`);
      return;
    }

    let bestRatio = 0;
    let bestScene = -1;
    sceneTokens.forEach((scene, sceneIndex) => {
      const ratio = overlapRatio(tokens, scene);
      if (ratio > bestRatio) {
        bestRatio = ratio;
        bestScene = sceneIndex;
      }
    });

    const required = requiredCoverage(tokens.size);
    if (bestRatio < required) {
      reasons.push(`${label} is not carried by any single scene`);
      return;
    }
    // Objectives are listed simple -> complex. If a later objective is first
    // carried by an earlier scene, prerequisites are likely out of order.
    if (bestScene < lastCoveringScene) {
      reasons.push(`${label} is carried before the objective that precedes it`);
      return;
    }
    lastCoveringScene = bestScene;
  });

  const titleTokens = new Set(
    [...contentTokens(deck.title ?? '')].filter((token) => !GENERIC_TITLE_WORDS.has(token)),
  );
  if (titleTokens.size >= 2) {
    const deckTokens = unionOfScenes(sceneTokens);
    let hits = 0;
    for (const token of titleTokens) {
      if (deckTokens.has(token)) hits += 1;
    }
    if (hits === 0) reasons.push('deck does not mention the lesson title');
  }

  return { accept: reasons.length === 0, reasons };
}
