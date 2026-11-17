/**
 * Normalizers for the prose attached to a choice option.
 *
 * A rationale or misconception is learner-facing text: it is read after
 * grading and, for a misconception, quoted back when the learner picks that
 * option. Models occasionally answer with a paragraph or a stray list marker,
 * so the boundary trims and bounds the note rather than trusting it.
 */

export const MAX_OPTION_NOTE_LENGTH = 280;

export function normalizeOptionNote(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let note = value.normalize('NFKC').replace(/\s+/g, ' ').trim();
  note = note.replace(/^(?:[-*•·]|\d+[.)])\s+/, '');
  note = note.replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, '').trim();
  if (note.length < 2) return undefined;
  return note.length > MAX_OPTION_NOTE_LENGTH
    ? note.slice(0, MAX_OPTION_NOTE_LENGTH).trimEnd()
    : note;
}
