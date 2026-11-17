'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  ChevronRight,
  GraduationCap,
  Loader2,
  RotateCcw,
  Sparkles,
  BookOpenText,
} from 'lucide-react';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useStageStore } from '@/lib/store';
import { masteryByConcept, masteryConfidence, masteryScore } from '@/lib/learning/mastery';
import { quizAnswerSummary, cardLocation } from '@/lib/learning/review-presentation';
import { dueReviewCards, reviewSummary } from '@/lib/learning/review';
import { loadLearningState, recordReviewRating } from '@/lib/learning/store';
import type { LearningState } from '@/lib/learning/store-payload';
import type { ReviewCard, ReviewRating } from '@/lib/learning/types';
import type { QuizQuestion } from '@/lib/types/stage';
import { cn } from '@/lib/utils';

interface LearningOverlayProps {
  stageId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function itemKey(sceneId: string | undefined, itemId: string | undefined): string | null {
  return sceneId && itemId ? `${sceneId}\u0000${itemId}` : null;
}

function formatDue(value: number, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(
      new Date(value),
    );
  } catch {
    return new Date(value).toLocaleDateString();
  }
}

function mintReviewId(cardId: string): string {
  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${cardId}:${uuid}`;
}

const RATING_STYLES: Record<ReviewRating, string> = {
  again:
    'border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300',
  hard: 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300',
  good: 'border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-100 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-300',
  easy: 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300',
};

function ConceptChips({ conceptIds }: { conceptIds: readonly string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {conceptIds.map((conceptId) => (
        <span
          key={conceptId}
          className="rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-medium capitalize text-violet-700 dark:bg-violet-950/50 dark:text-violet-300"
        >
          {conceptId}
        </span>
      ))}
    </div>
  );
}

function DueCard({
  card,
  question,
  lessonTitle,
  revealed,
  saving,
  onReveal,
  onRate,
  onOpenLesson,
}: {
  card: ReviewCard;
  question: QuizQuestion;
  lessonTitle?: string;
  revealed: boolean;
  saving: boolean;
  onReveal: () => void;
  onRate: (rating: ReviewRating) => void;
  onOpenLesson?: () => void;
}) {
  const { t } = useI18n();
  const showOptions = question.type === 'single' || question.type === 'multiple';
  const answer = revealed ? quizAnswerSummary(question) : '';
  const ratings: ReviewRating[] = ['again', 'hard', 'good', 'easy'];

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900">
      <ConceptChips conceptIds={card.conceptIds} />
      <p className="mt-3 text-sm font-medium leading-relaxed text-gray-900 dark:text-gray-100">
        {question.question}
      </p>

      {showOptions && question.options && question.options.length > 0 && (
        <ul className="mt-3 grid gap-1.5">
          {question.options.map((option) => {
            const correct = revealed && (question.answer ?? []).includes(option.value);
            return (
              <li
                key={option.value}
                className={cn(
                  'flex items-start gap-2 rounded-lg border px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300',
                  correct
                    ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-900/60 dark:bg-emerald-950/30'
                    : 'border-gray-100 dark:border-gray-800',
                )}
              >
                <span className="font-mono text-xs text-gray-400">{option.value}</span>
                <span className="flex-1">{option.label}</span>
                {correct && <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />}
              </li>
            );
          })}
        </ul>
      )}

      {!revealed ? (
        <button
          type="button"
          onClick={onReveal}
          className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-gray-900 px-4 py-1.5 text-xs font-medium text-white hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-300"
        >
          {t('learning.showAnswer')}
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      ) : (
        <div className="mt-4 space-y-3">
          {answer && (
            <div className="rounded-lg bg-emerald-50/70 p-3 text-sm text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300">
              <p className="mb-0.5 text-[11px] font-medium uppercase tracking-wide opacity-70">
                {t('quiz.expectedAnswer')}
              </p>
              <p>{answer}</p>
            </div>
          )}
          {question.analysis && (
            <div className="rounded-lg bg-blue-50/70 p-3 text-sm text-blue-800 dark:bg-blue-950/30 dark:text-blue-300">
              <p className="mb-0.5 text-[11px] font-medium uppercase tracking-wide opacity-70">
                {t('quiz.analysis')}
              </p>
              <p>{question.analysis}</p>
            </div>
          )}

          <div>
            <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
              {t('learning.ratePrompt')}
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {ratings.map((rating) => (
                <button
                  key={rating}
                  type="button"
                  disabled={saving}
                  onClick={() => onRate(rating)}
                  className={cn(
                    'rounded-lg border px-3 py-2 text-xs font-medium transition-colors disabled:cursor-wait disabled:opacity-50',
                    RATING_STYLES[rating],
                  )}
                >
                  {t(`learning.${rating}`)}
                </button>
              ))}
            </div>
          </div>

          {lessonTitle && onOpenLesson && (
            <button
              type="button"
              onClick={onOpenLesson}
              className="inline-flex items-center gap-1.5 rounded-full border border-violet-200 px-3 py-1 text-xs font-medium text-violet-700 transition-colors hover:bg-violet-50 dark:border-violet-800 dark:text-violet-300 dark:hover:bg-violet-950/40"
            >
              <BookOpenText className="h-3.5 w-3.5" />
              {t('quiz.reviewLesson')}: {lessonTitle}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Course-level learning dashboard and review session.
 *
 * Loads the learner's partition on open rather than keeping a global store:
 * the queue is small, and a stale in-memory copy is worse than one read per
 * visit. Ratings update the local state from the returned card so the reviewed
 * item leaves the queue immediately, without a second round trip.
 */
export function LearningOverlay({ stageId, open, onOpenChange }: LearningOverlayProps) {
  const { t, locale } = useI18n();
  const scenes = useStageStore((s) => s.scenes);
  const setCurrentSceneId = useStageStore((s) => s.setCurrentSceneId);
  const [state, setState] = useState<LearningState | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(0);
  const [tab, setTab] = useState<'review' | 'mastery'>('review');
  const [revealed, setRevealed] = useState<string | null>(null);
  const [ratingCardId, setRatingCardId] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !stageId) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    setSaveError(false);
    setRevealed(null);
    setNow(Date.now());
    void loadLearningState({ stageId })
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch((err) => {
        console.warn('[learning] failed to load state:', err);
        if (!cancelled) setLoadError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, stageId, reloadKey]);

  const questionByItem = useMemo(() => {
    const map = new Map<string, QuizQuestion>();
    for (const scene of scenes) {
      if (scene.content?.type !== 'quiz') continue;
      for (const question of scene.content.questions) {
        map.set(`${scene.id}\u0000${question.id}`, question);
      }
    }
    return map;
  }, [scenes]);

  const cards = useMemo(() => state?.reviewCards ?? [], [state]);
  const due = useMemo(() => dueReviewCards(cards, now, 50), [cards, now]);
  const summary = useMemo(() => reviewSummary(cards, now), [cards, now]);
  const reviewable = useMemo(
    () =>
      due
        .map((card) => {
          const location = cardLocation(card);
          const key = itemKey(location.sceneId, location.itemId);
          const question = key ? questionByItem.get(key) : undefined;
          const lesson =
            question?.remediationOutlineId !== undefined
              ? scenes.find((scene) => scene.outlineId === question.remediationOutlineId)
              : undefined;
          return { card, question, lesson };
        })
        .filter(
          (
            entry,
          ): entry is {
            card: ReviewCard;
            question: QuizQuestion;
            lesson: (typeof scenes)[number] | undefined;
          } => entry.question !== undefined,
        ),
    [due, questionByItem, scenes],
  );
  const orphaned = due.length - reviewable.length;
  const mastery = useMemo(() => masteryByConcept(state?.evidence ?? []), [state]);
  const concepts = useMemo(
    () =>
      Object.values(mastery).sort(
        (a, b) =>
          masteryScore(a) - masteryScore(b) ||
          b.evidenceCount - a.evidenceCount ||
          a.conceptId.localeCompare(b.conceptId),
      ),
    [mastery],
  );

  const refresh = () => setReloadKey((value) => value + 1);

  const rate = async (card: ReviewCard, rating: ReviewRating) => {
    if (!stageId) return;
    setRatingCardId(card.cardId);
    setSaveError(false);
    try {
      const result = await recordReviewRating({
        stageId,
        card,
        rating,
        reviewId: mintReviewId(card.cardId),
      });
      setState((previous) => {
        if (!previous) return previous;
        const exists = previous.reviewCards.some((entry) => entry.cardId === result.card.cardId);
        const evidenceExists = previous.evidence.some((entry) => entry.id === result.evidence.id);
        return {
          evidence: evidenceExists ? previous.evidence : [...previous.evidence, result.evidence],
          reviewCards: exists
            ? previous.reviewCards.map((entry) =>
                entry.cardId === result.card.cardId ? result.card : entry,
              )
            : [...previous.reviewCards, result.card],
        };
      });
      setRevealed(null);
    } catch (err) {
      console.warn('[learning] failed to save review:', err);
      setSaveError(true);
    } finally {
      setRatingCardId(null);
    }
  };

  const body = loading ? (
    <div className="flex items-center justify-center py-20">
      <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
    </div>
  ) : loadError ? (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <p className="text-sm text-red-600 dark:text-red-400">{t('learning.loadFailed')}</p>
      <button
        type="button"
        onClick={refresh}
        className="rounded-full border px-4 py-1.5 text-xs font-medium hover:bg-gray-50 dark:hover:bg-gray-800"
      >
        {t('common.retry')}
      </button>
    </div>
  ) : tab === 'review' ? (
    <div>
      {saveError && (
        <p className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
          {t('learning.saveFailed')}
        </p>
      )}
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-gray-800 dark:text-gray-200">
            {t('learning.dueCount', { count: reviewable.length })}
          </p>
          {summary.nextDueAt !== null && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t('learning.nextReview', { date: formatDue(summary.nextDueAt, locale) })}
            </p>
          )}
          {orphaned > 0 && (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
              {t('learning.orphaned', { count: orphaned })}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={refresh}
          aria-label={t('common.retry')}
          className="rounded-full p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
        >
          <RotateCcw className="h-4 w-4" />
        </button>
      </div>

      {reviewable.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <CheckCircle2 className="h-10 w-10 text-emerald-500" />
          <p className="mt-3 font-medium text-gray-800 dark:text-gray-200">
            {t('learning.nothingDue')}
          </p>
          <p className="mt-1 max-w-sm text-sm text-gray-500 dark:text-gray-400">
            {t('learning.nothingDueDesc')}
          </p>
        </div>
      ) : (
        <div className="grid gap-3">
          {reviewable.map(({ card, question, lesson }) => (
            <DueCard
              key={card.cardId}
              card={card}
              question={question}
              lessonTitle={lesson?.title}
              revealed={revealed === card.cardId}
              saving={ratingCardId === card.cardId}
              onReveal={() => setRevealed(card.cardId)}
              onRate={(rating) => void rate(card, rating)}
              onOpenLesson={
                lesson
                  ? () => {
                      setCurrentSceneId(lesson.id);
                      onOpenChange(false);
                    }
                  : undefined
              }
            />
          ))}
        </div>
      )}
    </div>
  ) : concepts.length === 0 ? (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <Sparkles className="h-10 w-10 text-violet-400" />
      <p className="mt-3 font-medium text-gray-800 dark:text-gray-200">
        {t('learning.noConcepts')}
      </p>
      <p className="mt-1 max-w-sm text-sm text-gray-500 dark:text-gray-400">
        {t('learning.noConceptsDesc')}
      </p>
    </div>
  ) : (
    <div className="grid gap-3">
      {concepts.map((concept) => {
        const score = Math.round(masteryScore(concept) * 100);
        const confidence = Math.round(masteryConfidence(concept) * 100);
        return (
          <div
            key={concept.conceptId}
            className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900"
          >
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-sm font-medium capitalize text-gray-900 dark:text-gray-100">
                {concept.conceptId}
              </p>
              <span className="text-sm font-semibold tabular-nums text-gray-700 dark:text-gray-300">
                {score}%
              </span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
              <div
                className="h-full rounded-full bg-gradient-to-r from-violet-500 to-emerald-500"
                style={{ width: `${score}%` }}
              />
            </div>
            <div className="mt-1.5 flex justify-between text-[11px] text-gray-400 dark:text-gray-500">
              <span>{t('learning.confidence', { value: confidence })}</span>
              <span>{t('learning.observations', { count: concept.evidenceCount })}</span>
            </div>
          </div>
        );
      })}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[86vh] w-[min(94vw,58rem)] max-w-none flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-gray-100 px-6 py-5 pr-14 dark:border-gray-800">
          <DialogTitle className="flex items-center gap-2 text-lg text-gray-900 dark:text-gray-100">
            <GraduationCap className="h-5 w-5 text-violet-500" />
            {t('learning.title')}
          </DialogTitle>
          <p className="text-sm text-gray-500 dark:text-gray-400">{t('learning.subtitle')}</p>
          <div className="mt-2 inline-flex w-fit rounded-full bg-gray-100 p-1 dark:bg-gray-800">
            {(['review', 'mastery'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setTab(value)}
                className={cn(
                  'rounded-full px-4 py-1.5 text-xs font-medium transition-colors',
                  tab === value
                    ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-gray-100'
                    : 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200',
                )}
              >
                {t(value === 'review' ? 'learning.reviewTab' : 'learning.masteryTab')}
              </button>
            ))}
          </div>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{body}</div>
      </DialogContent>
    </Dialog>
  );
}
