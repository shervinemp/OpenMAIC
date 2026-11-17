/**
 * Concept tags for generated assessment items.
 *
 * A tag names the idea an item measures, not its format. The learning loop
 * aggregates mastery by exact tag, so tags are canonicalized to lower case at
 * the producer boundary: "Recursion", "recursion", and "recursion." are one
 * concept, not three. A display layer can capitalize them again.
 *
 * This lives in the contract package because both the quiz generator and the
 * exam route persist tags onto their own question types. Keeping one
 * implementation means an imported classroom and a freshly generated quiz use
 * the same vocabulary rules.
 */

/** One item may name a handful of ideas; more than that measures nothing. */
export const MAX_CONCEPT_TAGS = 4;

/**
 * A tag is a short label, not a sentence. Long "tags" are almost always the
 * key point copied wholesale, which fragments mastery across paraphrase.
 */
export const MAX_CONCEPT_TAG_LENGTH = 64;

/**
 * Tags that describe the question format rather than the knowledge. Models
 * reach for these when a stem is generic; dropping them is better than letting
 * every multiple-choice item in a course share one meaningless concept.
 */
const FORMAT_ONLY_TAGS: ReadonlySet<string> = new Set([
  'answer',
  'assessment',
  'exercise',
  'fill in the blank',
  'general',
  'general knowledge',
  'multiple choice',
  'question',
  'questions',
  'quiz',
  'short answer',
  'single choice',
  'test',
  'true/false',
  'true or false',
  '选择题',
  '单选题',
  '多选题',
  '简答题',
  '题目',
  '测验',
]);

function cleanTag(value: string): string {
  let tag = value.normalize('NFKC').replace(/\s+/g, ' ').trim();
  // Models often copy list markers from the prompt: "1. recursion", "- base case".
  tag = tag.replace(/^(?:[-*•·]|\d+[.)])\s*/, '');
  tag = tag.replace(/[.,;:!?]+$/g, '').trim();
  tag = tag.replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, '').trim();
  tag = tag.replace(/[.,;:!?]+$/g, '').trim();
  return tag.toLowerCase();
}

/**
 * Normalize one tag, or return `null` when the value is not a usable concept.
 * Rejecting is deliberate: a malformed tag must not create a concept that no
 * other item can match.
 */
export function normalizeConceptTag(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const tag = cleanTag(value);
  if (tag.length < 2 || tag.length > MAX_CONCEPT_TAG_LENGTH) return null;
  if (FORMAT_ONLY_TAGS.has(tag)) return null;
  // A tag made only of digits and punctuation identifies nothing. Any
  // non-ASCII character counts as content so CJK tags survive.
  if (!/[a-z]/.test(tag) && !/[^\x00-\x7F]/.test(tag)) return null;
  return tag;
}

/**
 * Normalize a model-provided tag list.
 *
 * Returns `undefined` when nothing usable remains, so an untagged item stays
 * untagged instead of carrying an empty array. Duplicates collapse
 * case-insensitively, first spelling wins, and the list is capped.
 */
export function normalizeConceptTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const tag = normalizeConceptTag(entry);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= MAX_CONCEPT_TAGS) break;
  }
  return tags.length > 0 ? tags : undefined;
}
