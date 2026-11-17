/**
 * Pure, side-effect-free editing operations for the quiz content surface.
 *
 * Two layers live here:
 *   1. A snapshot-based undo/redo history primitive (`QuizEditHistory`),
 *      mirroring the slide surface's `slide-ops` history shape so the
 *      quiz-edit-session store can reuse the same idiom.
 *   2. Structured mutations over `QuizContent` — every helper takes a
 *      `QuizContent` and returns a NEW `QuizContent` (referential change is
 *      the "real edit" signal the EditShell's `surfaceStateEqual` compares).
 *
 * **Option model.** A `QuizOption.value` doubles as the option's displayed
 * badge letter (QuizView renders `opt.value` as the A/B/C chip) AND the key
 * stored in `QuizQuestion.answer`. To keep the displayed letters sequential
 * regardless of insert / delete / reorder while never corrupting `answer`,
 * choice-option mutations round-trip through a position-independent
 * intermediate (`OptionRow { label, correct }`): edits act on rows, then
 * `fromRows` re-derives `value = LETTERS[index]` and rebuilds `answer` from
 * the per-row `correct` flag. Reordering options therefore never needs an
 * explicit answer remap — correctness travels with the row.
 *
 * Ordering questions reuse the same rows with the row order itself as the key,
 * and matching questions carry a second label per row (`OptionRow.match`) that
 * `fromRows` rebuilds into the aligned `matches` column. Neither stores a
 * separate answer key, so a pair or sequence can never desynchronize.
 */

import type { QuizContent, QuizQuestion, QuizQuestionType } from '@/lib/types/stage';
import { answerIncludesOption } from '@/lib/quiz/grading';
import { createElementId } from '@/lib/edit/element-id';

// ---------------------------------------------------------------------------
// History primitive (snapshot-based, mirrors slide-ops shape)
// ---------------------------------------------------------------------------

export interface QuizEditHistory {
  past: QuizContent[];
  present: QuizContent;
  future: QuizContent[];
}

export function createQuizEditHistory(present: QuizContent): QuizEditHistory {
  return { past: [], present, future: [] };
}

/**
 * Fold a new content snapshot in as a fresh undo step. A no-op (identical
 * reference) is dropped so callers can commit unconditionally without
 * polluting the undo stack. Committing clears the redo branch.
 */
export function commitQuizContent(history: QuizEditHistory, next: QuizContent): QuizEditHistory {
  if (next === history.present) return history;
  return { past: [...history.past, history.present], present: next, future: [] };
}

export function undoQuiz(history: QuizEditHistory): QuizEditHistory {
  if (history.past.length === 0) return history;
  const previous = history.past[history.past.length - 1];
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redoQuiz(history: QuizEditHistory): QuizEditHistory {
  if (history.future.length === 0) return history;
  const next = history.future[0];
  return {
    past: [...history.past, history.present],
    present: next,
    future: history.future.slice(1),
  };
}

// ---------------------------------------------------------------------------
// Option-row intermediate
// ---------------------------------------------------------------------------

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Max options a choice question may hold (A–Z). */
export const MAX_OPTIONS = LETTERS.length;

export interface OptionRow {
  label: string;
  correct: boolean;
  /** Right-hand label of the same pair. `matching` rows only. */
  match?: string;
}

export function optionLetter(index: number): string {
  return LETTERS[index] ?? `#${index + 1}`;
}

function blankOptions(count: number): { label: string; value: string }[] {
  return Array.from({ length: count }, (_, index) => ({ label: '', value: optionLetter(index) }));
}

export function toRows(q: QuizQuestion): OptionRow[] {
  return (q.options ?? []).map((o, index) => ({
    label: o.label,
    // The same resolved projection the review UI and the grader use: a key
    // stored as an option label must read as correct here too. Raw value
    // equality would report every row as incorrect, and the next mutation
    // would rebuild `answer` from those rows and silently drop the key.
    correct: answerIncludesOption(q, o.value),
    match: q.matches?.[index]?.label,
  }));
}

/** Re-derive the option columns (value = positional letter) from rows.
 * Choice rows rebuild `answer` from the per-row `correct` flag, ordering rows
 * use the row order as the key, and matching rows rebuild both aligned
 * columns with no separate key. */
export function fromRows(
  rows: OptionRow[],
  mode: 'choice' | 'ordering' | 'matching' = 'choice',
): Pick<QuizQuestion, 'options' | 'answer' | 'matches'> {
  const options = rows.map((r, i) => ({ label: r.label, value: optionLetter(i) }));
  if (mode === 'ordering') return { options, answer: undefined };
  if (mode === 'matching') {
    return {
      options,
      matches: rows.map((r, i) => ({ label: r.match ?? '', value: optionLetter(i) })),
      answer: undefined,
    };
  }
  const answer = rows
    .map((r, i) => ({ correct: r.correct, value: optionLetter(i) }))
    .filter((r) => r.correct)
    .map((r) => r.value);
  return { options, answer };
}

// ---------------------------------------------------------------------------
// Question factories
// ---------------------------------------------------------------------------

export function isChoice(type: QuizQuestionType): boolean {
  return type === 'single' || type === 'multiple';
}

/** Whether the type stores an explicit sequence in `options`. */
export function isOrdered(type: QuizQuestionType): boolean {
  return type === 'ordering';
}

/** Whether the type pairs one left item with one right item. */
export function isMatching(type: QuizQuestionType): boolean {
  return type === 'matching';
}

/** Whether the type's option rows are editable at all. */
export function hasOptionRows(type: QuizQuestionType): boolean {
  return isChoice(type) || isOrdered(type) || isMatching(type);
}

/** A new blank question of the given type with sensible defaults. */
export function createBlankQuestion(
  type: QuizQuestionType,
  id = createElementId('q'),
): QuizQuestion {
  if (isChoice(type)) {
    return {
      id,
      type,
      question: '',
      options: [
        { label: '', value: 'A' },
        { label: '', value: 'B' },
      ],
      answer: [],
      points: 1,
    };
  }
  if (type === 'ordering') {
    return {
      id,
      type,
      question: '',
      options: blankOptions(3),
      points: 1,
      hasAnswer: true,
    };
  }
  if (type === 'matching') {
    return {
      id,
      type,
      question: '',
      options: blankOptions(3),
      matches: blankOptions(3),
      points: 1,
      hasAnswer: true,
    };
  }
  if (type === 'numeric') {
    return {
      id,
      type,
      question: '',
      answer: [''],
      tolerance: 0,
      unit: '',
      points: 1,
      hasAnswer: true,
    };
  }
  return {
    id,
    type: 'short_answer',
    question: '',
    points: 1,
    hasAnswer: false,
  };
}

// ---------------------------------------------------------------------------
// Question-list mutations
// ---------------------------------------------------------------------------

function mapQuestion(
  content: QuizContent,
  id: string,
  fn: (q: QuizQuestion) => QuizQuestion,
): QuizContent {
  return {
    ...content,
    questions: content.questions.map((q) => (q.id === id ? fn(q) : q)),
  };
}

export function addQuestion(
  content: QuizContent,
  type: QuizQuestionType,
  id?: string,
): QuizContent {
  return { ...content, questions: [...content.questions, createBlankQuestion(type, id)] };
}

export function deleteQuestion(content: QuizContent, id: string): QuizContent {
  return { ...content, questions: content.questions.filter((q) => q.id !== id) };
}

/** Reorder questions to match the given id order. Unknown / missing ids are ignored. */
export function reorderQuestions(content: QuizContent, orderedIds: readonly string[]): QuizContent {
  const byId = new Map(content.questions.map((q) => [q.id, q]));
  const next: QuizQuestion[] = [];
  for (const id of orderedIds) {
    const q = byId.get(id);
    if (q) {
      next.push(q);
      byId.delete(id);
    }
  }
  // Preserve any questions not named in orderedIds (defensive), in original order.
  for (const q of content.questions) if (byId.has(q.id)) next.push(q);
  return { ...content, questions: next };
}

/** Patch scalar question fields (question text, analysis, commentPrompt, points, hasAnswer). */
export function updateQuestion(
  content: QuizContent,
  id: string,
  patch: Partial<
    Pick<
      QuizQuestion,
      | 'question'
      | 'analysis'
      | 'commentPrompt'
      | 'points'
      | 'hasAnswer'
      | 'answer'
      | 'tolerance'
      | 'unit'
    >
  >,
): QuizContent {
  return mapQuestion(content, id, (q) => ({ ...q, ...patch }));
}

/**
 * Switch a question's type, applying the structural transition:
 *   any → short_answer    : drop options, matches and answer keys.
 *   any → numeric         : drop the option columns, seed one numeric slot.
 *   any → ordering        : keep choice/matching left items, seed three blank
 *                           items otherwise; the row order becomes the key.
 *   any → matching        : keep left items, seed blank right items; the two
 *                           columns stay aligned and no separate key is stored.
 *   any → choice          : keep left items, drop matching columns; the author
 *                           must mark the correct answer(s).
 *   single ↔ multiple     : keep options; single keeps at most one correct.
 */
export function setQuestionType(
  content: QuizContent,
  id: string,
  type: QuizQuestionType,
): QuizContent {
  return mapQuestion(content, id, (q) => {
    if (q.type === type) return q;

    const { commentPrompt: _c, answer, tolerance, unit, matches, hasAnswer: _h, ...base } = q;
    const keepLeft = hasOptionRows(q.type) && (q.options?.length ?? 0) >= 2;

    if (type === 'short_answer') {
      const { options: _o, ...rest } = base;
      return { ...rest, type, hasAnswer: false };
    }

    if (type === 'numeric') {
      const { options: _o, ...rest } = base;
      return {
        ...rest,
        type,
        answer: [answer?.[0] ?? ''],
        tolerance: tolerance ?? 0,
        unit: unit ?? '',
        hasAnswer: true,
      };
    }

    if (type === 'ordering') {
      return {
        ...base,
        type,
        options: keepLeft ? (q.options ?? []) : blankOptions(3),
        answer: undefined,
        hasAnswer: true,
      };
    }

    if (type === 'matching') {
      const left = keepLeft ? (q.options ?? []) : blankOptions(3);
      return {
        ...base,
        type,
        options: left,
        matches: left.map((_, index) => ({
          label: q.type === 'matching' ? (matches?.[index]?.label ?? '') : '',
          value: optionLetter(index),
        })),
        answer: undefined,
        hasAnswer: true,
      };
    }

    // Target is a choice type. A matching/ordering column becomes plain
    // options, but correctness must be re-marked by the author.
    const keptAnswer = isChoice(q.type) ? (answer ?? []) : [];
    return {
      ...base,
      type,
      options: keepLeft ? (q.options ?? []) : blankOptions(2),
      answer: type === 'single' ? keptAnswer.slice(0, 1) : keptAnswer,
    };
  });
}

// ---------------------------------------------------------------------------
// Option mutations (choice, ordering and matching; no-op elsewhere)
// ---------------------------------------------------------------------------

function rowsMode(type: QuizQuestionType): 'choice' | 'ordering' | 'matching' {
  if (isOrdered(type)) return 'ordering';
  if (isMatching(type)) return 'matching';
  return 'choice';
}

function mapRows(
  content: QuizContent,
  id: string,
  fn: (rows: OptionRow[]) => OptionRow[],
): QuizContent {
  return mapQuestion(content, id, (q) => {
    if (!hasOptionRows(q.type)) return q;
    return { ...q, ...fromRows(fn(toRows(q)), rowsMode(q.type)) };
  });
}

export function addOption(content: QuizContent, id: string): QuizContent {
  return mapRows(content, id, (rows) =>
    rows.length >= MAX_OPTIONS ? rows : [...rows, { label: '', correct: false }],
  );
}

export function deleteOption(content: QuizContent, id: string, index: number): QuizContent {
  return mapRows(content, id, (rows) => rows.filter((_, i) => i !== index));
}

export function updateOptionLabel(
  content: QuizContent,
  id: string,
  index: number,
  label: string,
): QuizContent {
  return mapRows(content, id, (rows) => rows.map((r, i) => (i === index ? { ...r, label } : r)));
}

/** Rename the right-hand item of one matching pair (no-op on other types). */
export function updateMatchLabel(
  content: QuizContent,
  id: string,
  index: number,
  label: string,
): QuizContent {
  return mapRows(content, id, (rows) =>
    rows.map((row, i) => (i === index ? { ...row, match: label } : row)),
  );
}

export function reorderOptions(
  content: QuizContent,
  id: string,
  fromIndex: number,
  toIndex: number,
): QuizContent {
  return mapRows(content, id, (rows) => {
    if (fromIndex === toIndex) return rows;
    if (fromIndex < 0 || fromIndex >= rows.length) return rows;
    if (toIndex < 0 || toIndex >= rows.length) return rows;
    const next = rows.slice();
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    return next;
  });
}

/**
 * Toggle an option's correctness. For `single`, selecting an option makes it
 * the sole correct answer (radio semantics). For `multiple`, it flips that
 * option independently (checkbox semantics).
 */
export function toggleCorrect(content: QuizContent, id: string, index: number): QuizContent {
  return mapQuestion(content, id, (q) => {
    if (!isChoice(q.type)) return q;
    const rows = toRows(q);
    if (index < 0 || index >= rows.length) return q;
    const next =
      q.type === 'single'
        ? rows.map((r, i) => ({ ...r, correct: i === index }))
        : rows.map((r, i) => (i === index ? { ...r, correct: !r.correct } : r));
    return { ...q, ...fromRows(next) };
  });
}
