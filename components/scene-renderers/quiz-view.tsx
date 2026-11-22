'use client';

import { memo, useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { answerIncludesOption } from '@/lib/quiz/grading';
import {
  PieChart,
  CheckCircle2,
  XCircle,
  RotateCcw,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Check,
  BookOpenText,
  Loader2,
  Sparkles,
  HelpCircle,
  Target,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useStageStore } from '@/lib/store';
import { getCurrentModelConfig, getStageRoutesHeaderValue } from '@/lib/utils/model-config';
import { getDecisionHeaders } from '@/lib/decision/client-settings';
import { createLogger } from '@/lib/logger';

const log = createLogger('QuizView');
import type { QuizQuestion } from '@/lib/types/stage';
import { recordQuizLearning } from '@/lib/learning/record-quiz';
import { SpeechButton } from '@/components/audio/speech-button';
import {
  gradeChoiceQuestions,
  isShortAnswer,
  quizQuestionPoints,
  ungradedResult,
  type QuestionResult,
} from '@/lib/quiz/grading';
import { renderQuizMathText } from '@/lib/quiz/math-text';
import { hasQuizAnswer, summarizePractice } from '@/lib/quiz/practice';
import { displayOrder } from '@/lib/quiz/shuffle';
import { writeDraftRecovery } from '@/lib/quiz/persistence';
import {
  createQuizAttemptWriter,
  loadQuizAttemptState,
  QuizRetryProgressedError,
  type QuizAttemptWriter,
} from '@/lib/quiz/runtime';
import {
  createQuizViewLifetime,
  isQuizRuntimeReady,
  persistQuizReview,
  persistQuizRetry,
  persistQuizSubmission,
  quizViewStateFromAttempt,
  runQuizPersistenceTransition,
  type QuizRuntimeGate,
  type QuizViewLifetime,
} from '@/lib/quiz/view-state';

// ─── Types ──────────────────────────────────────────────────────────────────

type Phase = 'not_started' | 'answering' | 'submitting' | 'grading' | 'reviewing';

interface QuizViewProps {
  readonly questions: QuizQuestion[];
  readonly sceneId: string;
  readonly stageId: string;
}

const QuizMathText = memo(function QuizMathText({
  text,
  className,
  allowDisplayMode = false,
}: {
  text: string;
  className?: string;
  allowDisplayMode?: boolean;
}) {
  const segments = useMemo(() => renderQuizMathText(text), [text]);
  if (segments.length === 1 && segments[0].type === 'text') {
    return <span className={className}>{segments[0].value}</span>;
  }

  return (
    <span className={className}>
      {segments.map((segment, index) => {
        if (segment.type === 'text') {
          return <span key={index}>{segment.value}</span>;
        }

        return (
          <span
            key={index}
            className={cn(
              allowDisplayMode && segment.displayMode
                ? 'block my-1 overflow-x-auto [&_.katex-display]:!my-0'
                : 'inline-block align-baseline [&_.katex-display]:!my-0',
            )}
            dangerouslySetInnerHTML={{ __html: segment.html }}
          />
        );
      })}
    </span>
  );
});

/** Call /api/quiz-grade for a single short-answer question. */
async function gradeShortAnswerQuestion(
  q: QuizQuestion,
  userAnswer: string,
  language: string,
): Promise<QuestionResult> {
  const pts = quizQuestionPoints(q.points);
  try {
    const modelConfig = getCurrentModelConfig();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-model': modelConfig.modelString,
      'x-api-key': modelConfig.apiKey,
    };
    if (modelConfig.baseUrl) headers['x-base-url'] = modelConfig.baseUrl;
    if (modelConfig.providerType) headers['x-provider-type'] = modelConfig.providerType;
    const stageRoutesHeader = getStageRoutesHeaderValue();
    if (stageRoutesHeader) headers['x-model-routes'] = stageRoutesHeader;
    Object.assign(headers, getDecisionHeaders());

    const res = await fetch('/api/quiz-grade', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        question: q.question,
        userAnswer,
        points: pts,
        commentPrompt: q.commentPrompt,
        language,
      }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { score: number; comment: string };
    const earned = Math.max(0, Math.min(pts, data.score));
    return {
      questionId: q.id,
      correct: earned >= pts * 0.8,
      status: earned >= pts * 0.8 ? 'correct' : 'incorrect',
      earned,
      aiComment: data.comment,
    };
  } catch (err) {
    log.error('[quiz-view] AI grading failed for', q.id, err);
    // No grade is better than an invented one: the question is marked
    // ungraded and excluded from the displayed total.
    return ungradedResult(q.id, language);
  }
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function QuizCover({
  questionCount,
  totalPoints,
  onStart,
  onPractice,
}: {
  questionCount: number;
  totalPoints: number;
  onStart: () => void;
  onPractice?: () => void;
}) {
  const { t } = useI18n();

  return (
    <div className="w-full h-full flex flex-col items-center justify-center gap-4 relative overflow-hidden">
      {/* Background decoration */}
      <div className="absolute top-0 right-0 p-6 opacity-[0.03]">
        <PieChart className="w-52 h-52 text-violet-500" />
      </div>
      <div className="absolute bottom-0 left-0 p-6 opacity-[0.02]">
        <BookOpenText className="w-40 h-40 text-violet-500 rotate-12" />
      </div>

      <motion.div
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 200, damping: 20 }}
        className="w-16 h-16 bg-gradient-to-br from-violet-100 to-purple-50 dark:from-violet-900/50 dark:to-purple-900/30 rounded-2xl flex items-center justify-center shadow-lg shadow-violet-100 dark:shadow-violet-900/30 ring-1 ring-violet-200/50 dark:ring-violet-700/50"
      >
        <PieChart className="w-8 h-8 text-violet-500" />
      </motion.div>

      <motion.div
        initial={{ y: 10, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.1 }}
        className="text-center z-10"
      >
        <h3 className="text-xl font-bold text-gray-800 dark:text-gray-100">{t('quiz.title')}</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('quiz.subtitle')}</p>
      </motion.div>

      <motion.div
        initial={{ y: 10, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.2 }}
        className="flex gap-5 text-sm z-10"
      >
        <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
          <div className="w-7 h-7 rounded-lg bg-violet-50 dark:bg-violet-900/30 flex items-center justify-center">
            <BookOpenText className="w-3.5 h-3.5 text-violet-500" />
          </div>
          <span>
            {questionCount} {t('quiz.questionsCount')}
          </span>
        </div>
        <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
          <div className="w-7 h-7 rounded-lg bg-violet-50 dark:bg-violet-900/30 flex items-center justify-center">
            <PieChart className="w-3.5 h-3.5 text-violet-500" />
          </div>
          <span>
            {t('quiz.totalPrefix')} {totalPoints} {t('quiz.pointsSuffix')}
          </span>
        </div>
      </motion.div>

      <motion.button
        initial={{ y: 10, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.3 }}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={onStart}
        className="mt-1 px-8 py-2.5 bg-gradient-to-r from-violet-500 to-purple-500 text-white rounded-full font-medium shadow-lg shadow-violet-200/50 dark:shadow-violet-900/50 hover:shadow-violet-300/50 transition-shadow z-10 flex items-center gap-2"
      >
        {t('quiz.startQuiz')}
        <ChevronRight className="w-4 h-4" />
      </motion.button>

      {onPractice && (
        <motion.button
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.35 }}
          whileTap={{ scale: 0.96 }}
          onClick={onPractice}
          className="flex items-center gap-1.5 text-sm font-medium text-violet-600 dark:text-violet-400 hover:text-violet-700 dark:hover:text-violet-300 transition-colors z-10"
        >
          <Target className="w-4 h-4" />
          {t('quiz.practice')}
        </motion.button>
      )}
    </div>
  );
}

function SingleChoiceQuestion({
  question,
  index,
  value,
  onChange,
  disabled,
  result,
}: {
  question: QuizQuestion;
  index: number;
  value?: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  result?: QuestionResult;
}) {
  const { t } = useI18n();
  const isReview = !!result;

  return (
    <QuestionCard question={question} index={index} result={result}>
      <div className="grid gap-2">
        {question.options?.map((opt) => {
          const selected = value === opt.value;
          const isCorrectOpt = isReview && answerIncludesOption(question, opt.value);
          const isWrong = isReview && selected && result?.status === 'incorrect';

          return (
            <button
              key={opt.value}
              disabled={disabled}
              onClick={() => !disabled && onChange(opt.value)}
              className={cn(
                'flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-all text-sm',
                // Default state
                !isReview &&
                  !selected &&
                  'border-gray-200 dark:border-gray-600 hover:border-violet-200 dark:hover:border-violet-700 hover:bg-violet-50/50 dark:hover:bg-violet-900/30',
                !isReview &&
                  selected &&
                  'border-violet-400 bg-violet-50 dark:bg-violet-900/30 ring-1 ring-violet-200 dark:ring-violet-700',
                // Review states
                isReview &&
                  isCorrectOpt &&
                  'border-emerald-400 bg-emerald-50 dark:bg-emerald-900/30',
                isReview &&
                  isWrong &&
                  !isCorrectOpt &&
                  'border-red-300 bg-red-50 dark:bg-red-900/30',
                isReview &&
                  !isCorrectOpt &&
                  !selected &&
                  'border-gray-100 dark:border-gray-700 opacity-60',
                disabled && !isReview && 'cursor-default',
              )}
            >
              <span
                className={cn(
                  'w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 transition-colors',
                  !isReview &&
                    !selected &&
                    'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400',
                  !isReview && selected && 'bg-violet-500 text-white',
                  isReview && isCorrectOpt && 'bg-emerald-500 text-white',
                  isReview && isWrong && !isCorrectOpt && 'bg-red-400 text-white',
                  isReview &&
                    !isCorrectOpt &&
                    !selected &&
                    'bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500',
                )}
              >
                {opt.value}
              </span>
              <span
                className={cn(
                  'flex-1',
                  isReview && !isCorrectOpt && !selected && 'text-gray-400 dark:text-gray-500',
                )}
              >
                <QuizMathText text={opt.label} />
                {isReview && opt.rationale && (
                  <span className="mt-1 block text-xs font-normal leading-relaxed text-gray-500 dark:text-gray-400">
                    <QuizMathText text={opt.rationale} />
                  </span>
                )}
                {isReview && isWrong && opt.misconception && (
                  <span className="mt-1 block text-xs font-normal leading-relaxed text-red-600 dark:text-red-400">
                    {t('quiz.misconception')}: {opt.misconception}
                  </span>
                )}
              </span>
              {isReview && isCorrectOpt && (
                <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
              )}
              {isReview && isWrong && !isCorrectOpt && (
                <XCircle className="w-5 h-5 text-red-400 shrink-0" />
              )}
            </button>
          );
        })}
      </div>
    </QuestionCard>
  );
}

function MultipleChoiceQuestion({
  question,
  index,
  value,
  onChange,
  disabled,
  result,
}: {
  question: QuizQuestion;
  index: number;
  value?: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
  result?: QuestionResult;
}) {
  const isReview = !!result;
  const selected = value ?? [];

  const toggle = (optValue: string) => {
    if (disabled) return;
    if (selected.includes(optValue)) {
      onChange(selected.filter((v) => v !== optValue));
    } else {
      onChange([...selected, optValue]);
    }
  };

  const { t } = useI18n();

  return (
    <QuestionCard question={question} index={index} result={result}>
      {!isReview && (
        <p className="text-xs text-gray-400 dark:text-gray-500 mb-2">
          {t('quiz.multipleChoiceHint')}
        </p>
      )}
      <div className="grid gap-2">
        {question.options?.map((opt) => {
          const isSelected = selected.includes(opt.value);
          const isCorrectOpt = isReview && answerIncludesOption(question, opt.value);
          const isWrong = isReview && isSelected && !isCorrectOpt;

          return (
            <button
              key={opt.value}
              disabled={disabled}
              onClick={() => toggle(opt.value)}
              className={cn(
                'flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-all text-sm',
                !isReview &&
                  !isSelected &&
                  'border-gray-200 dark:border-gray-600 hover:border-violet-200 dark:hover:border-violet-700 hover:bg-violet-50/50 dark:hover:bg-violet-900/30',
                !isReview &&
                  isSelected &&
                  'border-violet-400 bg-violet-50 dark:bg-violet-900/30 ring-1 ring-violet-200 dark:ring-violet-700',
                isReview &&
                  isCorrectOpt &&
                  'border-emerald-400 bg-emerald-50 dark:bg-emerald-900/30',
                isReview && isWrong && 'border-red-300 bg-red-50 dark:bg-red-900/30',
                isReview &&
                  !isCorrectOpt &&
                  !isSelected &&
                  'border-gray-100 dark:border-gray-700 opacity-60',
                disabled && !isReview && 'cursor-default',
              )}
            >
              <span
                className={cn(
                  'w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 transition-colors',
                  !isReview &&
                    !isSelected &&
                    'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400',
                  !isReview && isSelected && 'bg-violet-500 text-white',
                  isReview && isCorrectOpt && 'bg-emerald-500 text-white',
                  isReview && isWrong && 'bg-red-400 text-white',
                  isReview &&
                    !isCorrectOpt &&
                    !isSelected &&
                    'bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500',
                )}
              >
                {!isReview && isSelected ? <Check className="w-3.5 h-3.5" /> : opt.value}
              </span>
              <span
                className={cn(
                  'flex-1',
                  isReview && !isCorrectOpt && !isSelected && 'text-gray-400 dark:text-gray-500',
                )}
              >
                <QuizMathText text={opt.label} />
                {isReview && opt.rationale && (
                  <span className="mt-1 block text-xs font-normal leading-relaxed text-gray-500 dark:text-gray-400">
                    <QuizMathText text={opt.rationale} />
                  </span>
                )}
                {isReview && isWrong && opt.misconception && (
                  <span className="mt-1 block text-xs font-normal leading-relaxed text-red-600 dark:text-red-400">
                    {t('quiz.misconception')}: {opt.misconception}
                  </span>
                )}
              </span>
              {isReview && isCorrectOpt && (
                <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
              )}
              {isReview && isWrong && <XCircle className="w-5 h-5 text-red-400 shrink-0" />}
            </button>
          );
        })}
      </div>
    </QuestionCard>
  );
}

function OrderingQuestion({
  question,
  index,
  value,
  onChange,
  disabled,
  result,
}: {
  question: QuizQuestion;
  index: number;
  value?: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
  result?: QuestionResult;
}) {
  const { t } = useI18n();
  const isReview = !!result;
  const items = useMemo(() => question.options ?? [], [question.options]);
  const values = useMemo(() => items.map((item) => item.value), [items]);
  const labels = useMemo(() => new Map(items.map((item) => [item.value, item.label])), [items]);
  // The stored order is the answer key, so the learner sees a seeded shuffle.
  const display = useMemo(
    () => displayOrder(question.id, values.length),
    [question.id, values.length],
  );

  // An ordering question always holds a complete arrangement: until the learner
  // moves anything, the scrambled display order is their answer. Seed it once
  // so the "answered" count and submit readiness are honest.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || isReview || values.length === 0) return;
    if (value && value.length === values.length) return;
    seeded.current = true;
    onChange(display.map((position) => values[position]));
  }, [display, isReview, onChange, value, values]);

  const order =
    value && value.length === values.length ? value : display.map((position) => values[position]);

  const move = (from: number, to: number) => {
    if (disabled || isReview || to < 0 || to >= order.length) return;
    const next = order.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(next);
  };

  if (isReview) {
    return (
      <QuestionCard question={question} index={index} result={result}>
        <div className="space-y-3">
          <div className="grid gap-2">
            {order.map((itemValue, position) => {
              const atCorrectSpot = position < values.length && values[position] === itemValue;
              return (
                <div
                  key={itemValue}
                  className={cn(
                    'flex items-center gap-3 rounded-xl border px-3 py-2.5 text-sm',
                    atCorrectSpot
                      ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-900/30'
                      : 'border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-900/30',
                  )}
                >
                  <span
                    className={cn(
                      'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg font-mono text-xs font-bold',
                      atCorrectSpot
                        ? 'bg-emerald-500 text-white'
                        : 'bg-red-400 text-white dark:bg-red-500',
                    )}
                  >
                    {position + 1}
                  </span>
                  <span className="flex-1 text-gray-700 dark:text-gray-200">
                    <QuizMathText text={labels.get(itemValue) ?? itemValue} />
                  </span>
                  {atCorrectSpot ? (
                    <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500" />
                  ) : (
                    <XCircle className="h-5 w-5 shrink-0 text-red-400" />
                  )}
                </div>
              );
            })}
          </div>
          {result.status === 'incorrect' &&
            values.length >= 2 &&
            new Set(values).size === values.length && (
              <div className="rounded-xl border border-emerald-100 bg-emerald-50/70 p-3 dark:border-emerald-800 dark:bg-emerald-900/20">
                <p className="mb-1 text-xs text-emerald-600/80 dark:text-emerald-400/80">
                  {t('quiz.correctOrder')}
                </p>
                <ol className="list-decimal space-y-0.5 pl-5 text-sm text-emerald-700 dark:text-emerald-300">
                  {values.map((itemValue) => (
                    <li key={itemValue}>
                      <QuizMathText text={labels.get(itemValue) ?? itemValue} />
                    </li>
                  ))}
                </ol>
              </div>
            )}
        </div>
      </QuestionCard>
    );
  }

  return (
    <QuestionCard question={question} index={index}>
      <p className="mb-2 text-xs text-gray-400 dark:text-gray-500">{t('quiz.orderingHint')}</p>
      <ol className="grid gap-2">
        {order.map((itemValue, position) => (
          <li
            key={itemValue}
            className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm dark:border-gray-600 dark:bg-gray-800/50"
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gray-100 font-mono text-xs font-bold text-gray-500 dark:bg-gray-700 dark:text-gray-400">
              {position + 1}
            </span>
            <span className="flex-1 text-gray-700 dark:text-gray-200">
              <QuizMathText text={labels.get(itemValue) ?? itemValue} />
            </span>
            <span className="flex shrink-0 items-center">
              <button
                type="button"
                aria-label={t('quiz.moveUp')}
                disabled={disabled || position === 0}
                onClick={() => move(position, position - 1)}
                className="rounded-lg p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 disabled:pointer-events-none disabled:opacity-30 dark:hover:bg-gray-700 dark:hover:text-gray-200"
              >
                <ChevronUp className="h-4 w-4" />
              </button>
              <button
                type="button"
                aria-label={t('quiz.moveDown')}
                disabled={disabled || position === order.length - 1}
                onClick={() => move(position, position + 1)}
                className="rounded-lg p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 disabled:pointer-events-none disabled:opacity-30 dark:hover:bg-gray-700 dark:hover:text-gray-200"
              >
                <ChevronDown className="h-4 w-4" />
              </button>
            </span>
          </li>
        ))}
      </ol>
    </QuestionCard>
  );
}

function MatchingQuestion({
  question,
  index,
  value,
  onChange,
  disabled,
  result,
}: {
  question: QuizQuestion;
  index: number;
  value?: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
  result?: QuestionResult;
}) {
  const { t } = useI18n();
  const isReview = !!result;
  const left = useMemo(() => question.options ?? [], [question.options]);
  const right = useMemo(() => question.matches ?? [], [question.matches]);
  const rightByValue = useMemo(() => new Map(right.map((item) => [item.value, item])), [right]);
  // The right column is stored aligned with the left, so rendering it as-is
  // would reveal every pair. Shuffle it with the same deterministic helper as
  // ordering.
  const rightDisplay = useMemo(
    () => displayOrder(`${question.id}:match`, right.length),
    [question.id, right.length],
  );
  const picks = useMemo(
    () => (value && value.length === left.length ? value : left.map(() => '')),
    [left, value],
  );

  const choose = (leftIndex: number, rightValue: string) => {
    if (disabled || isReview) return;
    const next = picks.slice();
    next[leftIndex] = rightValue;
    onChange(next);
  };

  return (
    <QuestionCard question={question} index={index} result={result}>
      {!isReview && (
        <p className="mb-2 text-xs text-gray-400 dark:text-gray-500">{t('quiz.matchingHint')}</p>
      )}
      <div className="grid gap-2">
        {left.map((item, position) => {
          const chosen = picks[position] ?? '';
          const correct = right[position];
          const isRight = !!chosen && chosen === correct?.value;
          const ungraded = result?.status === 'ungraded';

          return (
            <div
              key={item.value}
              className={cn(
                'flex flex-col gap-2 rounded-xl border px-3 py-2.5 text-sm',
                !isReview && 'border-gray-200 dark:border-gray-600',
                isReview &&
                  (ungraded
                    ? 'border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/20'
                    : isRight
                      ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-900/30'
                      : 'border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-900/30'),
              )}
            >
              <div className="flex items-start gap-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gray-100 font-mono text-xs font-bold text-gray-500 dark:bg-gray-700 dark:text-gray-400">
                  {position + 1}
                </span>
                <span className="flex-1 text-gray-700 dark:text-gray-200">
                  <QuizMathText text={item.label} />
                </span>
                {isReview ? (
                  ungraded ? (
                    <HelpCircle className="h-5 w-5 shrink-0 text-amber-500" />
                  ) : isRight ? (
                    <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500" />
                  ) : (
                    <XCircle className="h-5 w-5 shrink-0 text-red-400" />
                  )
                ) : (
                  <select
                    aria-label={`${t('quiz.matchingChoose')}: ${item.label}`}
                    value={chosen}
                    disabled={disabled}
                    onChange={(event) => choose(position, event.target.value)}
                    className="max-w-[45%] shrink-0 rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700 focus:border-violet-300 focus:outline-none focus:ring-2 focus:ring-violet-100 disabled:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:focus:border-violet-600 dark:focus:ring-violet-900/50"
                  >
                    <option value="">{t('quiz.matchingChoose')}</option>
                    {rightDisplay.map((rightIndex) => {
                      const option = right[rightIndex];
                      if (!option) return null;
                      return (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      );
                    })}
                  </select>
                )}
              </div>
              {isReview && (
                <div className="flex flex-wrap items-center gap-2 pl-10 text-xs">
                  <span className="text-gray-500 dark:text-gray-400">{t('quiz.yourAnswer')}</span>
                  <span
                    className={cn(
                      'rounded-md px-2 py-0.5',
                      ungraded
                        ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                        : isRight
                          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                          : 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
                    )}
                  >
                    {chosen ? (rightByValue.get(chosen)?.label ?? chosen) : t('quiz.notAnswered')}
                  </span>
                  {!ungraded && !isRight && correct && (
                    <>
                      <span className="text-gray-500 dark:text-gray-400">
                        {t('quiz.correctMatch')}
                      </span>
                      <span className="rounded-md bg-emerald-100 px-2 py-0.5 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                        {correct.label}
                      </span>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </QuestionCard>
  );
}

function ShortAnswerQuestion({
  question,
  index,
  value,
  onChange,
  disabled,
  result,
}: {
  question: QuizQuestion;
  index: number;
  value?: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  result?: QuestionResult;
}) {
  const isReview = !!result;
  const { t } = useI18n();
  // Ref to track latest value for voice transcription append
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  return (
    <QuestionCard question={question} index={index} result={result}>
      {!isReview ? (
        <div className="relative">
          <textarea
            value={value ?? ''}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            placeholder={t('quiz.inputPlaceholder')}
            className="w-full min-h-[100px] p-3 pb-10 rounded-xl border border-gray-200 dark:border-gray-600 text-sm resize-none focus:outline-none focus:border-violet-300 dark:focus:border-violet-600 focus:ring-2 focus:ring-violet-100 dark:focus:ring-violet-900/50 transition-all disabled:bg-gray-50 dark:disabled:bg-gray-800 disabled:text-gray-500 dark:bg-gray-800/50 dark:text-gray-200 dark:placeholder:text-gray-500"
          />
          <SpeechButton
            size="sm"
            disabled={disabled}
            className="absolute bottom-3 left-3"
            onTranscription={(text) => {
              const cur = valueRef.current ?? '';
              onChange(cur + (cur ? ' ' : '') + text);
            }}
          />
          <span className="absolute bottom-3 right-3 text-xs text-gray-300 dark:text-gray-600">
            {(value ?? '').length} {t('quiz.charCount')}
          </span>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="p-3 rounded-xl bg-gray-50 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-700 text-sm text-gray-700 dark:text-gray-300">
            <p className="text-xs text-gray-400 dark:text-gray-500 mb-1">{t('quiz.yourAnswer')}</p>
            {value ? (
              <QuizMathText text={value} />
            ) : (
              <span className="text-gray-400 dark:text-gray-500 italic">
                {t('quiz.notAnswered')}
              </span>
            )}
          </div>
          {result.aiComment && (
            <div
              className={cn(
                'flex items-start gap-2 px-3 py-2 rounded-lg border',
                result.status === 'ungraded'
                  ? 'bg-amber-50 dark:bg-amber-900/30 border-amber-100 dark:border-amber-800'
                  : 'bg-violet-50 dark:bg-violet-900/30 border-violet-100 dark:border-violet-800',
              )}
            >
              {result.status === 'ungraded' ? (
                <HelpCircle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
              ) : (
                <Sparkles className="w-4 h-4 text-violet-500 shrink-0 mt-0.5" />
              )}
              <div>
                <p
                  className={cn(
                    'text-xs font-medium mb-0.5',
                    result.status === 'ungraded'
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-violet-600 dark:text-violet-400',
                  )}
                >
                  {result.status === 'ungraded' ? t('quiz.ungraded') : t('quiz.aiComment')}
                </p>
                <p
                  className={cn(
                    'text-xs',
                    result.status === 'ungraded'
                      ? 'text-amber-600/80 dark:text-amber-400/80'
                      : 'text-violet-600/80 dark:text-violet-400/80',
                  )}
                >
                  <QuizMathText text={result.aiComment} />
                </p>
              </div>
              <span
                className={cn(
                  'ml-auto text-xs font-bold shrink-0',
                  result.status === 'ungraded'
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-violet-600 dark:text-violet-400',
                )}
              >
                {result.status === 'ungraded' ? (
                  t('quiz.ungraded')
                ) : (
                  <>
                    {result.earned}/{quizQuestionPoints(question.points)}
                    {t('quiz.pointsSuffix')}
                  </>
                )}
              </span>
            </div>
          )}
        </div>
      )}
    </QuestionCard>
  );
}

function NumericQuestion({
  question,
  index,
  value,
  onChange,
  disabled,
  result,
}: {
  question: QuizQuestion;
  index: number;
  value?: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  result?: QuestionResult;
}) {
  const { t } = useI18n();
  const isReview = !!result;
  const unit = question.unit?.trim();
  const expected = question.answer?.[0];
  const tolerance = Number(question.tolerance);

  return (
    <QuestionCard question={question} index={index} result={result}>
      {!isReview ? (
        <div className="flex items-center gap-2">
          <input
            type="text"
            inputMode="decimal"
            value={value ?? ''}
            onChange={(event) => onChange(event.target.value)}
            disabled={disabled}
            placeholder={t('quiz.numericPlaceholder')}
            className="w-full rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800/50 p-3 text-sm text-gray-700 dark:text-gray-200 focus:outline-none focus:border-violet-300 dark:focus:border-violet-600 focus:ring-2 focus:ring-violet-100 dark:focus:ring-violet-900/50 transition-all disabled:bg-gray-50 dark:disabled:bg-gray-800 disabled:text-gray-500"
          />
          {unit && (
            <span className="shrink-0 text-sm font-medium text-gray-500 dark:text-gray-400">
              {unit}
            </span>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="p-3 rounded-xl bg-gray-50 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-700 text-sm text-gray-700 dark:text-gray-300">
            <p className="text-xs text-gray-400 dark:text-gray-500 mb-1">{t('quiz.yourAnswer')}</p>
            {value ? (
              <span className="font-mono">
                {value}
                {unit ? ` ${unit}` : ''}
              </span>
            ) : (
              <span className="text-gray-400 dark:text-gray-500 italic">
                {t('quiz.notAnswered')}
              </span>
            )}
          </div>
          <div className="p-3 rounded-xl bg-emerald-50/70 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-800 text-sm text-emerald-700 dark:text-emerald-300">
            <p className="text-xs text-emerald-600/70 dark:text-emerald-400/70 mb-1">
              {t('quiz.expectedAnswer')}
            </p>
            <span className="font-mono">
              {expected === undefined ? '—' : expected}
              {expected !== undefined && unit ? ` ${unit}` : ''}
            </span>
            {expected !== undefined && Number.isFinite(tolerance) && tolerance > 0 && (
              <span className="ml-2 text-xs text-emerald-600/70 dark:text-emerald-400/70">
                ± {tolerance}
                {unit ? ` ${unit}` : ''}
              </span>
            )}
          </div>
        </div>
      )}
    </QuestionCard>
  );
}

function QuestionCard({
  question,
  index,
  result,
  children,
}: {
  question: QuizQuestion;
  index: number;
  result?: QuestionResult;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const isReview = !!result;
  const pts = quizQuestionPoints(question.points);
  const scenes = useStageStore((state) => state.scenes);
  const setCurrentSceneId = useStageStore((state) => state.setCurrentSceneId);
  const remediationScene =
    isReview && question.remediationOutlineId
      ? scenes.find((scene) => scene.outlineId === question.remediationOutlineId)
      : undefined;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05 }}
      className={cn(
        'bg-white dark:bg-gray-800 rounded-2xl border p-5 relative overflow-hidden',
        !isReview && 'border-gray-200 dark:border-gray-700 shadow-sm',
        isReview &&
          result.status === 'correct' &&
          'border-emerald-200 dark:border-emerald-800 shadow-sm shadow-emerald-50 dark:shadow-emerald-900/20',
        isReview &&
          result.status === 'incorrect' &&
          'border-red-200 dark:border-red-800 shadow-sm shadow-red-50 dark:shadow-red-900/20',
        isReview &&
          result.status === 'ungraded' &&
          'border-amber-200 dark:border-amber-800 shadow-sm shadow-amber-50 dark:shadow-amber-900/20',
      )}
    >
      {/* Left accent */}
      <div
        className={cn(
          'absolute left-0 top-0 bottom-0 w-1 rounded-l-2xl',
          !isReview && 'bg-violet-400',
          isReview && result.status === 'correct' && 'bg-emerald-400',
          isReview && result.status === 'incorrect' && 'bg-red-400',
          isReview && result.status === 'ungraded' && 'bg-amber-400',
        )}
      />

      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-start gap-3">
          <span
            className={cn(
              'w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold shrink-0',
              !isReview &&
                'bg-violet-100 dark:bg-violet-900/50 text-violet-600 dark:text-violet-400',
              isReview &&
                result.status === 'correct' &&
                'bg-emerald-100 dark:bg-emerald-900/50 text-emerald-600 dark:text-emerald-400',
              isReview &&
                result.status === 'incorrect' &&
                'bg-red-100 dark:bg-red-900/50 text-red-600 dark:text-red-400',
              isReview &&
                result.status === 'ungraded' &&
                'bg-amber-100 dark:bg-amber-900/50 text-amber-600 dark:text-amber-400',
            )}
          >
            {index + 1}
          </span>
          <div>
            <div className="text-sm font-medium text-gray-800 dark:text-gray-100 leading-relaxed">
              <QuizMathText text={question.question} allowDisplayMode />
            </div>
            <p className="text-xs text-gray-400 mt-0.5">
              {question.type === 'single'
                ? t('quiz.singleChoice')
                : question.type === 'multiple'
                  ? t('quiz.multipleChoice')
                  : question.type === 'numeric'
                    ? t('quiz.numeric')
                    : question.type === 'ordering'
                      ? t('quiz.ordering')
                      : question.type === 'matching'
                        ? t('quiz.matching')
                        : t('quiz.shortAnswer')}
              {' · '}
              {pts} {t('quiz.pointsSuffix')}
            </p>
          </div>
        </div>
        {isReview && (
          <div className="shrink-0 ml-2">
            {result.status === 'correct' && <CheckCircle2 className="w-6 h-6 text-emerald-500" />}
            {result.status === 'incorrect' && <XCircle className="w-6 h-6 text-red-400" />}
            {result.status === 'ungraded' && <HelpCircle className="w-6 h-6 text-amber-500" />}
          </div>
        )}
      </div>

      {/* Body */}
      {children}

      {/* Analysis (review only) */}
      {isReview && question.analysis && (
        <div className="mt-3 p-3 rounded-lg bg-blue-50/70 dark:bg-blue-900/30 border border-blue-100 dark:border-blue-800 text-xs text-blue-700 dark:text-blue-300 leading-relaxed">
          <span className="font-medium">{t('quiz.analysis')}</span>
          <QuizMathText text={question.analysis} allowDisplayMode />
        </div>
      )}

      {remediationScene && (
        <button
          type="button"
          onClick={() => setCurrentSceneId(remediationScene.id)}
          className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-violet-200 px-3 py-1 text-xs font-medium text-violet-700 transition-colors hover:bg-violet-50 dark:border-violet-800 dark:text-violet-300 dark:hover:bg-violet-950/40"
        >
          <BookOpenText className="h-3.5 w-3.5" />
          {t('quiz.reviewLesson')}: {remediationScene.title}
        </button>
      )}
    </motion.div>
  );
}

function ScoreBanner({
  score,
  total,
  results,
}: {
  score: number;
  total: number;
  results: QuestionResult[];
}) {
  const { t } = useI18n();
  // total excludes ungraded questions; zero means nothing could be graded.
  const allUngraded = total <= 0;
  const pct = total > 0 ? Math.round((score / total) * 100) : 0;
  const correctCount = results.filter((r) => r.status === 'correct').length;
  const incorrectCount = results.filter((r) => r.status === 'incorrect').length;
  const ungradedCount = results.filter((r) => r.status === 'ungraded').length;

  const color = allUngraded ? 'slate' : pct >= 80 ? 'emerald' : pct >= 60 ? 'amber' : 'red';
  const colorMap = {
    emerald: {
      bg: 'from-emerald-500 to-teal-500',
      shadow: 'shadow-emerald-200/50 dark:shadow-emerald-900/50',
      ring: 'bg-emerald-400/30',
      text: t('quiz.excellent'),
    },
    amber: {
      bg: 'from-amber-500 to-yellow-500',
      shadow: 'shadow-amber-200/50 dark:shadow-amber-900/50',
      ring: 'bg-amber-400/30',
      text: t('quiz.keepGoing'),
    },
    red: {
      bg: 'from-red-500 to-rose-500',
      shadow: 'shadow-red-200/50 dark:shadow-red-900/50',
      ring: 'bg-red-400/30',
      text: t('quiz.needsReview'),
    },
    slate: {
      bg: 'from-slate-500 to-slate-600',
      shadow: 'shadow-slate-200/50 dark:shadow-slate-800/50',
      ring: 'bg-slate-400/30',
      text: t('quiz.ungraded'),
    },
  };
  const c = colorMap[color];

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className={cn('rounded-2xl p-6 bg-gradient-to-r text-white shadow-lg', c.bg, c.shadow)}
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="text-white/80 text-sm font-medium">{c.text}</p>
          <div className="flex items-baseline gap-1 mt-1">
            {allUngraded ? (
              <span className="text-4xl font-black">—</span>
            ) : (
              <>
                <span className="text-4xl font-black">{score}</span>
                <span className="text-white/60 text-lg">/ {total}</span>
              </>
            )}
          </div>
          <div className="flex flex-wrap gap-3 mt-3 text-xs">
            <span className="flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5" /> {correctCount} {t('quiz.correct')}
            </span>
            <span className="flex items-center gap-1">
              <XCircle className="w-3.5 h-3.5" /> {incorrectCount} {t('quiz.incorrect')}
            </span>
            {ungradedCount > 0 && (
              <span className="flex items-center gap-1">
                <HelpCircle className="w-3.5 h-3.5" /> {ungradedCount} {t('quiz.ungraded')}
              </span>
            )}
          </div>
        </div>

        {/* Percentage ring (hidden when nothing could be graded) */}
        {!allUngraded && (
          <div className="relative w-20 h-20">
            <svg className="w-20 h-20 -rotate-90" viewBox="0 0 80 80">
              <circle
                cx="40"
                cy="40"
                r="34"
                fill="none"
                stroke="rgba(255,255,255,0.2)"
                strokeWidth="6"
              />
              <motion.circle
                cx="40"
                cy="40"
                r="34"
                fill="none"
                stroke="white"
                strokeWidth="6"
                strokeLinecap="round"
                strokeDasharray={`${2 * Math.PI * 34}`}
                initial={{ strokeDashoffset: 2 * Math.PI * 34 }}
                animate={{ strokeDashoffset: 2 * Math.PI * 34 * (1 - pct / 100) }}
                transition={{ duration: 1, ease: 'easeOut', delay: 0.3 }}
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-lg font-black">{pct}%</span>
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

/**
 * Ephemeral practice run: one question at a time with instant feedback and a
 * missed-question retry. Deliberately independent of the graded attempt
 * runtime - practice answers never enter the persisted quiz result, so a
 * learner can drill without touching their score.
 */
export function QuizPractice({
  questions,
  locale,
  initialIds,
  onExit,
}: {
  questions: QuizQuestion[];
  locale: string;
  initialIds?: string[];
  onExit: () => void;
}) {
  const { t } = useI18n();
  const byId = useMemo(
    () => new Map(questions.map((question) => [question.id, question])),
    [questions],
  );
  const pointsByQuestion = useMemo(
    () =>
      Object.fromEntries(
        questions.map((question) => [question.id, quizQuestionPoints(question.points)]),
      ),
    [questions],
  );
  const allIds = useMemo(() => questions.map((question) => question.id), [questions]);
  const [ids, setIds] = useState<string[]>(() => {
    const requested = (initialIds ?? []).filter((id) => byId.has(id));
    return requested.length > 0 ? requested : allIds;
  });
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [results, setResults] = useState<QuestionResult[]>([]);
  const [currentResult, setCurrentResult] = useState<QuestionResult | null>(null);
  const [checking, setChecking] = useState(false);

  const finished = index >= ids.length;
  const question = finished ? undefined : byId.get(ids[index]);
  const answer = question ? answers[question.id] : undefined;
  const answered = question ? hasQuizAnswer(question, answer) : false;

  const start = useCallback(
    (nextIds: string[]) => {
      setIds(nextIds.length > 0 ? nextIds : allIds);
      setIndex(0);
      setAnswers({});
      setResults([]);
      setCurrentResult(null);
      setChecking(false);
    },
    [allIds],
  );

  const check = useCallback(async () => {
    if (!question || !answered || checking || currentResult) return;
    setChecking(true);
    try {
      const result =
        question.type === 'short_answer'
          ? await gradeShortAnswerQuestion(question, String(answer ?? ''), locale)
          : gradeChoiceQuestions([question], answers)[0];
      if (!result) return;
      setResults((previous) => [
        ...previous.filter((entry) => entry.questionId !== question.id),
        result,
      ]);
      setCurrentResult(result);
    } finally {
      setChecking(false);
    }
  }, [answer, answers, answered, checking, currentResult, locale, question]);

  const next = useCallback(() => {
    setCurrentResult(null);
    setIndex((value) => value + 1);
  }, []);

  const header = (right: React.ReactNode) => (
    <div className="flex items-center justify-between px-6 py-3 border-b border-gray-100 dark:border-gray-700 bg-white/80 dark:bg-gray-900/80 backdrop-blur shrink-0">
      <div className="flex items-center gap-2">
        <Target className="w-4 h-4 text-violet-500" />
        <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">
          {t('quiz.practice')}
        </span>
        {!finished && (
          <span className="text-xs text-gray-400 ml-1">
            {index + 1} / {ids.length}
          </span>
        )}
      </div>
      {right}
    </div>
  );

  if (finished) {
    const summary = summarizePractice(results, pointsByQuestion);
    const exitButton = () => (
      <button
        type="button"
        onClick={onExit}
        className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 hover:text-violet-600 dark:hover:text-violet-400 transition-colors"
      >
        {t('quiz.backToQuiz')}
      </button>
    );

    return (
      <div className="w-full h-full bg-gradient-to-b from-gray-50 to-white dark:from-gray-900 dark:to-gray-900 overflow-hidden flex flex-col">
        {header(exitButton())}
        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-5">
          <div className="text-center">
            <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto mb-2" />
            <h2 className="text-lg font-bold text-gray-800 dark:text-gray-100">
              {t('quiz.practiceComplete')}
            </h2>
          </div>

          <ScoreBanner score={summary.earned} total={summary.gradedTotal} results={results} />

          <div className="flex flex-wrap justify-center gap-3">
            {summary.missed.length > 0 && (
              <button
                type="button"
                onClick={() => start(summary.missed)}
                className="flex items-center gap-2 rounded-full bg-gradient-to-r from-violet-500 to-purple-500 px-5 py-2 text-sm font-medium text-white shadow-sm hover:shadow-md transition-shadow"
              >
                <RotateCcw className="w-4 h-4" />
                {t('quiz.practiceMissed')} ({summary.missed.length})
              </button>
            )}
            <button
              type="button"
              onClick={() => start(allIds)}
              className="flex items-center gap-2 rounded-full border border-gray-200 dark:border-gray-700 px-5 py-2 text-sm font-medium text-gray-600 dark:text-gray-300 hover:border-violet-300 hover:text-violet-600 dark:hover:border-violet-700 dark:hover:text-violet-400 transition-colors"
            >
              {t('quiz.practiceAgain')}
            </button>
            {exitButton()}
          </div>
        </div>
      </div>
    );
  }

  const nextButton = currentResult ? (
    <button
      type="button"
      onClick={next}
      className="flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-violet-500 to-purple-500 px-4 py-1.5 text-xs font-medium text-white shadow-sm hover:shadow-md transition-shadow"
    >
      {t('quiz.next')}
      <ChevronRight className="w-3.5 h-3.5" />
    </button>
  ) : (
    <button
      type="button"
      onClick={() => void check()}
      disabled={!answered || checking}
      className={cn(
        'flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-xs font-medium transition-all',
        answered && !checking
          ? 'bg-gradient-to-r from-violet-500 to-purple-500 text-white shadow-sm hover:shadow-md active:scale-[0.97]'
          : 'bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed',
      )}
    >
      {checking && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
      {t('quiz.check')}
    </button>
  );

  return (
    <div className="w-full h-full bg-gradient-to-b from-gray-50 to-white dark:from-gray-900 dark:to-gray-900 overflow-hidden flex flex-col">
      {header(
        <button
          type="button"
          onClick={onExit}
          className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 hover:text-violet-600 dark:hover:text-violet-400 transition-colors"
        >
          {t('quiz.backToQuiz')}
        </button>,
      )}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {question?.type === 'single' && (
          <SingleChoiceQuestion
            question={question}
            index={index}
            value={answer as string | undefined}
            onChange={(value) => setAnswers((previous) => ({ ...previous, [question.id]: value }))}
            disabled={!!currentResult}
            result={currentResult ?? undefined}
          />
        )}
        {question?.type === 'multiple' && (
          <MultipleChoiceQuestion
            question={question}
            index={index}
            value={answer as string[] | undefined}
            onChange={(value) => setAnswers((previous) => ({ ...previous, [question.id]: value }))}
            disabled={!!currentResult}
            result={currentResult ?? undefined}
          />
        )}
        {question?.type === 'ordering' && (
          <OrderingQuestion
            question={question}
            index={index}
            value={answer as string[] | undefined}
            onChange={(value) => setAnswers((previous) => ({ ...previous, [question.id]: value }))}
            disabled={!!currentResult}
            result={currentResult ?? undefined}
          />
        )}
        {question?.type === 'matching' && (
          <MatchingQuestion
            question={question}
            index={index}
            value={answer as string[] | undefined}
            onChange={(value) => setAnswers((previous) => ({ ...previous, [question.id]: value }))}
            disabled={!!currentResult}
            result={currentResult ?? undefined}
          />
        )}
        {question?.type === 'numeric' && (
          <NumericQuestion
            question={question}
            index={index}
            value={answer as string | undefined}
            onChange={(value) => setAnswers((previous) => ({ ...previous, [question.id]: value }))}
            disabled={!!currentResult}
            result={currentResult ?? undefined}
          />
        )}
        {question?.type === 'short_answer' && (
          <ShortAnswerQuestion
            question={question}
            index={index}
            value={answer as string | undefined}
            onChange={(value) => setAnswers((previous) => ({ ...previous, [question.id]: value }))}
            disabled={!!currentResult}
            result={currentResult ?? undefined}
          />
        )}

        <div className="mt-4 flex items-center justify-between gap-3">
          <p className="text-xs text-gray-400 dark:text-gray-500">{t('quiz.practiceNote')}</p>
          {nextButton}
        </div>
      </div>
    </div>
  );
}

export function QuizView({ questions, sceneId, stageId }: QuizViewProps) {
  const { t, locale } = useI18n();

  const [phase, setPhase] = useState<Phase>('not_started');
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [results, setResults] = useState<QuestionResult[]>([]);
  const [runtimeGate, setRuntimeGate] = useState<QuizRuntimeGate>({ status: 'loading' });
  const [hydrationVersion, setHydrationVersion] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [practiceRun, setPracticeRun] = useState<{ ids?: string[] } | null>(null);
  const viewLifetimeRef = useRef<QuizViewLifetime | null>(null);
  viewLifetimeRef.current ??= createQuizViewLifetime();
  const viewLifetime = viewLifetimeRef.current;
  const runtimeWriterRef = useRef<QuizAttemptWriter | null>(null);
  runtimeWriterRef.current ??= createQuizAttemptWriter({
    onError: (error) => log.warn('Failed to persist quiz runtime:', error),
  });
  const runtimeWriter = runtimeWriterRef.current;

  useEffect(() => {
    return () => {
      void runtimeWriter.flushDraft();
    };
  }, [runtimeWriter]);

  useEffect(() => {
    let cancelled = false;
    setRuntimeGate({ status: 'loading' });
    setRetrying(false);
    void loadQuizAttemptState({ stageId, sceneId })
      .then(({ attemptId: nextAttemptId, state }) => {
        if (cancelled) return;
        const next = quizViewStateFromAttempt(state);
        setPhase(next.phase);
        setAnswers(next.answers);
        setResults(next.results);
        setRuntimeGate({ status: 'ready', attemptId: nextAttemptId });
      })
      .catch((error) => {
        log.warn('Failed to hydrate quiz runtime:', error);
        if (!cancelled) setRuntimeGate({ status: 'error' });
      });
    return () => {
      cancelled = true;
      viewLifetime.invalidate();
      void runtimeWriter.flushDraft();
    };
  }, [hydrationVersion, runtimeWriter, sceneId, stageId, viewLifetime]);

  const attemptId = isQuizRuntimeReady(runtimeGate) ? runtimeGate.attemptId : null;

  const totalPoints = useMemo(
    () => questions.reduce((sum, q) => sum + quizQuestionPoints(q.points), 0),
    [questions],
  );

  const allAnswered = useMemo(() => {
    return questions.every((q) => hasQuizAnswer(q, answers[q.id]));
  }, [questions, answers]);

  const handleSetAnswer = useCallback(
    (questionId: string, value: string | string[]) => {
      setAnswers((prev) => {
        const next = { ...prev, [questionId]: value };
        if (attemptId) {
          writeDraftRecovery(sceneId, attemptId, next);
          runtimeWriter.scheduleDraft({
            stageId,
            sceneId,
            attemptId,
            answers: next,
          });
        }
        return next;
      });
    },
    [attemptId, runtimeWriter, sceneId, stageId],
  );

  const handleSubmit = useCallback(async () => {
    if (!attemptId) return;
    setPhase('submitting');
    await runQuizPersistenceTransition(
      () => persistQuizSubmission({ stageId, sceneId, attemptId, answers }, runtimeWriter),
      viewLifetime,
      () => setPhase('grading'),
      (error) => {
        log.warn('Failed to persist quiz submission:', error);
        setRuntimeGate({ status: 'error' });
      },
    );
  }, [attemptId, answers, runtimeWriter, sceneId, stageId, viewLifetime]);

  // When entering grading phase, grade choice questions locally + call API for short-answer
  useEffect(() => {
    if (phase !== 'grading') return;
    let cancelled = false;

    (async () => {
      // 1. Grade choice questions locally (instant)
      const choiceResults = gradeChoiceQuestions(questions, answers);

      // 2. Grade short-answer questions via AI API (parallel)
      const shortAnswerQs = questions.filter(isShortAnswer);
      const aiResults = await Promise.all(
        shortAnswerQs.map((q) =>
          gradeShortAnswerQuestion(q, (answers[q.id] as string) ?? '', locale),
        ),
      );

      if (cancelled) return;

      // 3. Merge results in original question order
      const allResultsMap = new Map<string, QuestionResult>();
      for (const r of [...choiceResults, ...aiResults]) {
        allResultsMap.set(r.questionId, r);
      }
      const ordered = questions.map((q) => allResultsMap.get(q.id)!).filter(Boolean);

      if (!attemptId) {
        setRuntimeGate({ status: 'error' });
        return;
      }
      try {
        await persistQuizReview(
          { stageId, sceneId, attemptId, answers, results: ordered },
          runtimeWriter,
        );
      } catch (error) {
        log.warn('Failed to persist quiz review:', error);
        if (!cancelled) setRuntimeGate({ status: 'error' });
        return;
      }
      if (cancelled) return;
      setResults(ordered);
      setPhase('reviewing');
    })();

    return () => {
      cancelled = true;
    };
  }, [phase, questions, answers, locale, sceneId, stageId, attemptId, runtimeWriter]);

  // A reviewed attempt is reachable after a reload as well as immediately after
  // grading, so the learning write lives on the phase rather than inside the
  // grading transition. Evidence ids are idempotent; a second run is harmless.
  useEffect(() => {
    if (phase !== 'reviewing' || !attemptId || results.length === 0) return;
    void recordQuizLearning({
      stageId,
      sceneId,
      attemptId,
      questions,
      results,
    }).catch((error) => {
      log.warn('Failed to record quiz learning evidence:', error);
    });
  }, [phase, results, attemptId, questions, sceneId, stageId]);

  const handleRetry = useCallback(async () => {
    if (!attemptId || retrying) return;
    setRetrying(true);
    runtimeWriter.cancelDraft();
    await runQuizPersistenceTransition(
      () => persistQuizRetry({ stageId, sceneId, attemptId }, runtimeWriter),
      viewLifetime,
      () => {
        setPhase('not_started');
        setAnswers({});
        setResults([]);
        setRetrying(false);
      },
      (error) => {
        log.warn('Failed to persist quiz retry:', error);
        setRetrying(false);
        if (error instanceof QuizRetryProgressedError) {
          setHydrationVersion((version) => version + 1);
          return;
        }
        setRuntimeGate({ status: 'error' });
      },
    );
  }, [attemptId, retrying, runtimeWriter, sceneId, stageId, viewLifetime]);

  const earnedScore = useMemo(() => results.reduce((sum, r) => sum + r.earned, 0), [results]);

  const resultMap = useMemo(() => {
    const map: Record<string, QuestionResult> = {};
    results.forEach((r) => {
      map[r.questionId] = r;
    });
    return map;
  }, [results]);

  // Ungraded questions are excluded from the displayed total: a learner should
  // not lose points because the grading service had an outage.
  const gradedTotal = useMemo(
    () =>
      questions.reduce((sum, q) => {
        const result = resultMap[q.id];
        return sum + (result?.status === 'ungraded' ? 0 : quizQuestionPoints(q.points));
      }, 0),
    [questions, resultMap],
  );

  const missedIds = useMemo(
    () =>
      results.filter((result) => result.status !== 'correct').map((result) => result.questionId),
    [results],
  );

  if (runtimeGate.status === 'error') {
    return (
      <div className="flex h-full w-full items-center justify-center bg-gray-50 dark:bg-gray-900">
        <button
          type="button"
          onClick={() => setHydrationVersion((version) => version + 1)}
          className="flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-700"
        >
          <RotateCcw className="h-4 w-4" />
          {t('quiz.retry')}
        </button>
      </div>
    );
  }

  if (!isQuizRuntimeReady(runtimeGate)) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-gray-50 dark:bg-gray-900">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    );
  }

  if (practiceRun) {
    return (
      <QuizPractice
        questions={questions}
        locale={locale}
        initialIds={practiceRun.ids}
        onExit={() => setPracticeRun(null)}
      />
    );
  }

  return (
    <div className="w-full h-full bg-gradient-to-b from-gray-50 to-white dark:from-gray-900 dark:to-gray-900 overflow-hidden flex flex-col">
      <AnimatePresence mode="wait">
        {phase === 'not_started' && (
          <motion.div
            key="cover"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, x: -20 }}
            className="flex-1"
          >
            <QuizCover
              questionCount={questions.length}
              totalPoints={totalPoints}
              onStart={() => setPhase('answering')}
              onPractice={questions.length > 0 ? () => setPracticeRun({}) : undefined}
            />
          </motion.div>
        )}

        {phase === 'answering' && (
          <motion.div
            key="answering"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="flex-1 flex flex-col min-h-0"
          >
            {/* Header bar */}
            <div className="flex items-center justify-between px-6 py-3 border-b border-gray-100 dark:border-gray-700 bg-white/80 dark:bg-gray-900/80 backdrop-blur shrink-0">
              <div className="flex items-center gap-2">
                <PieChart className="w-4 h-4 text-violet-500" />
                <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                  {t('quiz.answering')}
                </span>
                <span className="text-xs text-gray-400 ml-1">
                  {questions.filter((q) => hasQuizAnswer(q, answers[q.id])).length} /{' '}
                  {questions.length}
                </span>
              </div>
              <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={!allAnswered}
                className={cn(
                  'px-4 py-1.5 rounded-lg text-xs font-medium transition-all',
                  allAnswered
                    ? 'bg-gradient-to-r from-violet-500 to-purple-500 text-white shadow-sm hover:shadow-md hover:shadow-violet-200/50 dark:hover:shadow-violet-900/50 active:scale-[0.97]'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed',
                )}
              >
                {t('quiz.submitAnswers')}
              </button>
            </div>

            {/* Questions */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              {questions.map((q, i) => {
                if (q.type === 'single') {
                  return (
                    <SingleChoiceQuestion
                      key={q.id}
                      question={q}
                      index={i}
                      value={answers[q.id] as string | undefined}
                      onChange={(v) => handleSetAnswer(q.id, v)}
                    />
                  );
                }
                if (q.type === 'multiple') {
                  return (
                    <MultipleChoiceQuestion
                      key={q.id}
                      question={q}
                      index={i}
                      value={answers[q.id] as string[] | undefined}
                      onChange={(v) => handleSetAnswer(q.id, v)}
                    />
                  );
                }
                if (q.type === 'ordering') {
                  return (
                    <OrderingQuestion
                      key={q.id}
                      question={q}
                      index={i}
                      value={answers[q.id] as string[] | undefined}
                      onChange={(v) => handleSetAnswer(q.id, v)}
                    />
                  );
                }
                if (q.type === 'matching') {
                  return (
                    <MatchingQuestion
                      key={q.id}
                      question={q}
                      index={i}
                      value={answers[q.id] as string[] | undefined}
                      onChange={(v) => handleSetAnswer(q.id, v)}
                    />
                  );
                }
                if (q.type === 'numeric') {
                  return (
                    <NumericQuestion
                      key={q.id}
                      question={q}
                      index={i}
                      value={answers[q.id] as string | undefined}
                      onChange={(v) => handleSetAnswer(q.id, v)}
                    />
                  );
                }
                return (
                  <ShortAnswerQuestion
                    key={q.id}
                    question={q}
                    index={i}
                    value={answers[q.id] as string | undefined}
                    onChange={(v) => handleSetAnswer(q.id, v)}
                  />
                );
              })}
            </div>
          </motion.div>
        )}

        {(phase === 'submitting' || phase === 'grading') && (
          <motion.div
            key="grading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex-1 flex flex-col items-center justify-center gap-5"
          >
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ repeat: Infinity, duration: 1.5, ease: 'linear' }}
            >
              <Loader2 className="w-10 h-10 text-violet-500" />
            </motion.div>
            <div className="text-center">
              <p className="text-base font-semibold text-gray-700 dark:text-gray-200">
                {t('quiz.aiGrading')}
              </p>
              <p className="text-sm text-gray-400 mt-1">{t('quiz.aiGradingWait')}</p>
            </div>
            <div className="flex gap-1 mt-2">
              {[0, 1, 2].map((i) => (
                <motion.div
                  key={i}
                  className="w-2 h-2 rounded-full bg-violet-400"
                  animate={{ opacity: [0.3, 1, 0.3] }}
                  transition={{
                    repeat: Infinity,
                    duration: 1.2,
                    delay: i * 0.2,
                  }}
                />
              ))}
            </div>
          </motion.div>
        )}

        {phase === 'reviewing' && (
          <motion.div
            key="reviewing"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            className="flex-1 flex flex-col min-h-0"
          >
            {/* Header bar */}
            <div className="flex items-center justify-between px-6 py-3 border-b border-gray-100 dark:border-gray-700 bg-white/80 dark:bg-gray-900/80 backdrop-blur shrink-0">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                  {t('quiz.quizReport')}
                </span>
              </div>
              <div className="flex items-center gap-3">
                {missedIds.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setPracticeRun({ ids: missedIds })}
                    className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 hover:text-violet-600 dark:hover:text-violet-400 transition-colors"
                  >
                    <Target className="w-3.5 h-3.5" />
                    {t('quiz.practiceMissed')}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void handleRetry()}
                  disabled={retrying}
                  className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 hover:text-violet-600 dark:hover:text-violet-400 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  {t('quiz.retry')}
                </button>
              </div>
            </div>

            {/* Results */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              <ScoreBanner score={earnedScore} total={gradedTotal} results={results} />

              {questions.map((q, i) => {
                const r = resultMap[q.id];
                if (q.type === 'single') {
                  return (
                    <SingleChoiceQuestion
                      key={q.id}
                      question={q}
                      index={i}
                      value={answers[q.id] as string | undefined}
                      onChange={() => {}}
                      disabled
                      result={r}
                    />
                  );
                }
                if (q.type === 'multiple') {
                  return (
                    <MultipleChoiceQuestion
                      key={q.id}
                      question={q}
                      index={i}
                      value={answers[q.id] as string[] | undefined}
                      onChange={() => {}}
                      disabled
                      result={r}
                    />
                  );
                }
                if (q.type === 'ordering') {
                  return (
                    <OrderingQuestion
                      key={q.id}
                      question={q}
                      index={i}
                      value={answers[q.id] as string[] | undefined}
                      onChange={() => {}}
                      disabled
                      result={r}
                    />
                  );
                }
                if (q.type === 'matching') {
                  return (
                    <MatchingQuestion
                      key={q.id}
                      question={q}
                      index={i}
                      value={answers[q.id] as string[] | undefined}
                      onChange={() => {}}
                      disabled
                      result={r}
                    />
                  );
                }
                if (q.type === 'numeric') {
                  return (
                    <NumericQuestion
                      key={q.id}
                      question={q}
                      index={i}
                      value={answers[q.id] as string | undefined}
                      onChange={() => {}}
                      disabled
                      result={r}
                    />
                  );
                }
                return (
                  <ShortAnswerQuestion
                    key={q.id}
                    question={q}
                    index={i}
                    value={answers[q.id] as string | undefined}
                    onChange={() => {}}
                    disabled
                    result={r}
                  />
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
