'use client';

import {
  ArrowLeftRight,
  Calculator,
  CircleDot,
  ListChecks,
  ListOrdered,
  PencilLine,
  type LucideIcon,
} from 'lucide-react';
import { PopoverClose } from '@/components/ui/popover';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { QuizQuestionType } from '@/lib/types/stage';
import { addQuizQuestion } from './use-quiz-surface';

const TYPES: { type: QuizQuestionType; labelKey: string; Icon: LucideIcon; tint: string }[] = [
  {
    type: 'single',
    labelKey: 'edit.quiz.type.single',
    Icon: CircleDot,
    tint: 'bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300',
  },
  {
    type: 'multiple',
    labelKey: 'edit.quiz.type.multiple',
    Icon: ListChecks,
    tint: 'bg-indigo-100 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300',
  },
  {
    type: 'short_answer',
    labelKey: 'edit.quiz.type.short_answer',
    Icon: PencilLine,
    tint: 'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300',
  },
  {
    type: 'numeric',
    labelKey: 'edit.quiz.type.numeric',
    Icon: Calculator,
    tint: 'bg-cyan-100 text-cyan-600 dark:bg-cyan-500/15 dark:text-cyan-300',
  },
  {
    type: 'ordering',
    labelKey: 'edit.quiz.type.ordering',
    Icon: ListOrdered,
    tint: 'bg-teal-100 text-teal-600 dark:bg-teal-500/15 dark:text-teal-300',
  },
  {
    type: 'matching',
    labelKey: 'edit.quiz.type.matching',
    Icon: ArrowLeftRight,
    tint: 'bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300',
  },
];

/**
 * Popover body for the inline "Add question" button — a small menu of the
 * question types, each with its accent colour. Each entry appends a blank
 * question of that type (one undo step) and closes the popover via Radix's
 * PopoverClose.
 */
export function AddQuestionMenu() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-0.5">
      <p className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
        {t('edit.quiz.addQuestion')}
      </p>
      {TYPES.map(({ type, labelKey, Icon, tint }) => (
        <PopoverClose asChild key={type}>
          <button
            type="button"
            onClick={() => addQuizQuestion(type)}
            className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 text-left text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            <span
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${tint}`}
            >
              <Icon className="h-4 w-4" strokeWidth={2} />
            </span>
            <span>{t(labelKey)}</span>
          </button>
        </PopoverClose>
      ))}
    </div>
  );
}
