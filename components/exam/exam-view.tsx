'use client';

/**
 * Semester exam overlay (midterm / final).
 *
 * Two timed sections: a substantial single-answer MC section (auto-graded with
 * explanations) and constructed-response questions graded per rubric by the
 * LLM (`POST /api/exam/grade-fr`). The generated artifact is a question POOL;
 * every attempt draws a seeded form, so retakes and different learners see
 * different papers without another model call. Attempts and grades persist
 * with the document, and the list view derives performance analytics from
 * them.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CourseBlueprint } from '@/lib/types/generation';
import type { SceneOutline } from '@/lib/types/generation';
import {
  BookCheck,
  BookOpenText,
  CheckCircle2,
  CircleDot,
  Clock,
  MinusCircle,
  RefreshCw,
  TrendingUp,
  X,
  XCircle,
} from 'lucide-react';
import { useStageStore } from '@/lib/store/stage';
import { useI18n } from '@/lib/hooks/use-i18n';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { getDecisionHeaders } from '@/lib/decision/client-settings';
import { createLogger } from '@/lib/logger';
import type { ExamAttempt, ExamFrGrade, ExamKind, ExamSpec } from '@/lib/types/exam';
import {
  buildExamVariant,
  createVariantSeed,
  effectiveExamForm,
  resolveAttemptVariant,
  type ExamVariant,
} from '@/lib/exam/variants';
import {
  effectiveExamTiming,
  formatExamClock,
  formatExamMinutes,
  sectionBudgetSec,
  secondsRemaining,
  type ExamSection,
} from '@/lib/exam/timing';
import { computeExamAnalytics, type ExamAnalytics } from '@/lib/exam/analytics';
import { recordExamLearning } from '@/lib/learning/record-exam';

const log = createLogger('ExamView');

type Phase = 'list' | 'generating' | 'taking' | 'grading' | 'reviewing';

const EXAM_KINDS: ExamKind[] = ['midterm', 'final'];

const localeCode: Record<string, string> = {
  en: 'en-US',
  zh: 'zh-CN',
  ja: 'ja-JP',
  es: 'es-ES',
  fr: 'fr-FR',
  de: 'de-DE',
  ko: 'ko-KR',
  pt: 'pt-BR',
  ru: 'ru-RU',
};

function modelHeaders(): Record<string, string> {
  const config = getCurrentModelConfig();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-model': config.modelString,
    'x-api-key': config.apiKey,
  };
  if (config.baseUrl) headers['x-base-url'] = config.baseUrl;
  if (config.providerType) headers['x-provider-type'] = config.providerType;
  return { ...headers, ...getDecisionHeaders() };
}

/** Same split as the generation route: midterm covers the front half of units. */
function coverageRange(kind: ExamKind, unitCount: number): [number, number] {
  const to =
    kind === 'midterm' ? Math.max(0, Math.ceil(unitCount / 2) - 1) : Math.max(0, unitCount - 1);
  return [0, to];
}

function outlinesForRange(blueprint?: CourseBlueprint, from = 0, to = 0): SceneOutline[] {
  const units = blueprint?.units;
  if (!units?.length) {
    return blueprint?.lessons?.flatMap((lesson) => lesson.outlines) ?? [];
  }
  return units.slice(from, to + 1).flatMap((u) => u.lessons.flatMap((l) => l.outlines));
}

function percent(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—';
}

export default function ExamOverlay({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const stageId = useStageStore((s) => s.stage?.id ?? null);
  const blueprint = useStageStore((s) => s.blueprint);
  const exams = useStageStore((s) => s.exams);
  const examAttempts = useStageStore((s) => s.examAttempts);
  const setExamSpec = useStageStore((s) => s.setExamSpec);
  const saveExamAttempt = useStageStore((s) => s.saveExamAttempt);

  const [phase, setPhase] = useState<Phase>('list');
  const [activeKind, setActiveKind] = useState<ExamKind>('midterm');
  const [variantSeed, setVariantSeed] = useState<string | null>(null);
  const [section, setSection] = useState<ExamSection>('mc');
  const [remainingSec, setRemainingSec] = useState<number | null>(null);
  const [mcTimedOut, setMcTimedOut] = useState(false);
  const [mcAnswers, setMcAnswers] = useState<Record<string, string>>({});
  const [frAnswers, setFrAnswers] = useState<Record<string, string>>({});
  const [reviewing, setReviewing] = useState<ExamAttempt | null>(null);
  const [reviewVariant, setReviewVariant] = useState<ExamVariant | null>(null);
  const [generatingKind, setGeneratingKind] = useState<ExamKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const [sectionSeconds, setSectionSeconds] = useState<{ mc?: number; fr?: number }>({});

  const deadlineRef = useRef<number | null>(null);
  const mcStartedAtRef = useRef<number | null>(null);
  const frStartedAtRef = useRef<number | null>(null);
  const submitRef = useRef<(auto?: boolean) => void>(() => {});

  const unitCount = blueprint?.units?.length ?? 0;
  const eligible = unitCount >= 2;

  const activeSpec = exams[activeKind] ?? null;
  const activeVariant = useMemo(
    () => (activeSpec && variantSeed ? buildExamVariant(activeSpec, variantSeed) : null),
    [activeSpec, variantSeed],
  );

  const analytics = useMemo(() => {
    const result: Partial<Record<ExamKind, ExamAnalytics>> = {};
    for (const kind of EXAM_KINDS) {
      const spec = exams[kind];
      if (spec) result[kind] = computeExamAnalytics(spec, examAttempts[kind] ?? []);
    }
    return result;
  }, [exams, examAttempts]);

  const recordSectionTime = useCallback((which: ExamSection) => {
    const started = which === 'mc' ? mcStartedAtRef.current : frStartedAtRef.current;
    if (started == null) return;
    const seconds = Math.max(0, Math.round((Date.now() - started) / 1000));
    setSectionSeconds((current) => ({ ...current, [which]: seconds }));
    if (which === 'mc') mcStartedAtRef.current = null;
    else frStartedAtRef.current = null;
  }, []);

  const beginSection = useCallback((which: ExamSection, spec: ExamSpec) => {
    const budget = sectionBudgetSec(spec, which);
    deadlineRef.current = budget != null ? Date.now() + budget * 1000 : null;
    setRemainingSec(budget);
    setSection(which);
    if (which === 'mc') mcStartedAtRef.current = Date.now();
    else frStartedAtRef.current = Date.now();
  }, []);

  const startTaking = useCallback(
    (kind: ExamKind, specOverride?: ExamSpec) => {
      const spec = specOverride ?? exams[kind];
      if (!spec) return;
      const seed = createVariantSeed();
      setActiveKind(kind);
      setVariantSeed(seed);
      setMcAnswers({});
      setFrAnswers({});
      setTimedOut(false);
      setMcTimedOut(false);
      setSectionSeconds({});
      setError(null);
      const variant = buildExamVariant(spec, seed);
      beginSection(variant.mcQuestions.length > 0 ? 'mc' : 'fr', spec);
      setPhase('taking');
    },
    [beginSection, exams],
  );

  const generateExam = useCallback(
    async (kind: ExamKind) => {
      setPhase('generating');
      setGeneratingKind(kind);
      setError(null);
      try {
        const [from, to] = coverageRange(kind, unitCount);
        const coveredOutlines = outlinesForRange(blueprint, from, to);
        const res = await fetch('/api/generate/exam', {
          method: 'POST',
          headers: modelHeaders(),
          body: JSON.stringify({
            kind,
            blueprint,
            coveredOutlines,
            languageDirective: blueprint?.languageDirective,
          }),
        });
        const j = await res.json();
        if (!res.ok || !j?.exam) {
          throw new Error(j?.error || `Exam generation failed (${res.status})`);
        }
        setExamSpec(j.exam as ExamSpec);
        startTaking(kind, j.exam as ExamSpec);
      } catch (err) {
        log.error('Exam generation failed:', err);
        setError(err instanceof Error ? err.message : String(err));
        setPhase('list');
      } finally {
        setGeneratingKind(null);
      }
    },
    [blueprint, setExamSpec, startTaking, unitCount],
  );

  const advanceToFr = useCallback(() => {
    if (!activeSpec) return;
    recordSectionTime('mc');
    beginSection('fr', activeSpec);
    setMcTimedOut(false);
  }, [activeSpec, beginSection, recordSectionTime]);

  const submit = useCallback(
    async (auto = false) => {
      const target = activeSpec;
      const variant = activeVariant;
      if (!target || !variant) return;

      const now = Date.now();
      const started = section === 'mc' ? mcStartedAtRef.current : frStartedAtRef.current;
      const currentSectionSeconds =
        started != null ? Math.max(0, Math.round((now - started) / 1000)) : undefined;
      const mergedSectionSeconds = {
        ...sectionSeconds,
        ...(currentSectionSeconds !== undefined ? { [section]: currentSectionSeconds } : {}),
      };
      if (section === 'mc') mcStartedAtRef.current = null;
      else frStartedAtRef.current = null;
      deadlineRef.current = null;
      setRemainingSec(null);
      setSectionSeconds(mergedSectionSeconds);
      if (auto) setTimedOut(true);

      setPhase('grading');
      setError(null);

      const mcResults: ExamAttempt['mcResults'] = {};
      variant.mcQuestions.forEach((q) => {
        const picked = mcAnswers[q.id] ?? null;
        mcResults[q.id] =
          picked != null && q.answer.includes(picked)
            ? { correct: true, earned: q.points }
            : { correct: false, earned: 0 };
      });

      let frGrades: ExamFrGrade[];
      try {
        frGrades = await Promise.all(
          variant.frQuestions.map(async (fr) => {
            const res = await fetch('/api/exam/grade-fr', {
              method: 'POST',
              headers: modelHeaders(),
              body: JSON.stringify({
                questionId: fr.id,
                prompt: fr.prompt,
                userAnswer: frAnswers[fr.id] ?? '',
                rubric: fr.rubric,
                sampleAnswer: fr.sampleAnswer,
                maxPoints: fr.maxPoints,
                commentPrompt: fr.commentPrompt,
                language: localeCode[locale] ?? locale,
                withCriteria: true,
              }),
            });
            const j = await res.json();
            if (!res.ok) throw new Error(j?.error || `Grading failed (${res.status})`);
            return {
              questionId: fr.id,
              score: Number(j.score ?? 0),
              maxPoints: Number(j.maxPoints ?? fr.maxPoints),
              comment: String(j.comment ?? ''),
              criteria: Array.isArray(j.criteria) ? j.criteria : undefined,
            } satisfies ExamFrGrade;
          }),
        );
      } catch (err) {
        log.error('Free-response grading failed:', err);
        setError(err instanceof Error ? err.message : String(err));
        setPhase('taking');
        return;
      }

      const total =
        variant.mcQuestions.reduce((sum, question) => sum + question.points, 0) +
        frGrades.reduce((sum, grade) => sum + grade.maxPoints, 0);
      const earned =
        Object.values(mcResults).reduce((sum, result) => sum + result.earned, 0) +
        frGrades.reduce((sum, grade) => sum + grade.score, 0);
      const attempt: ExamAttempt = {
        id: `attempt_${Date.now()}`,
        kind: activeKind,
        variantSeed: variant.seed,
        specGeneratedAt: target.generatedAt,
        mcAnswers,
        frAnswers,
        mcResults,
        frGrades,
        scorePct: total > 0 ? earned / total : null,
        sectionSeconds: mergedSectionSeconds,
        timedOut: auto || timedOut,
        submittedAt: Date.now(),
        gradedAt: Date.now(),
      };
      saveExamAttempt(attempt);
      setReviewing(attempt);
      setReviewVariant(variant);
      setPhase('reviewing');
    },
    [
      activeKind,
      activeSpec,
      activeVariant,
      frAnswers,
      locale,
      mcAnswers,
      saveExamAttempt,
      section,
      sectionSeconds,
      timedOut,
    ],
  );

  useEffect(() => {
    submitRef.current = submit;
  }, [submit]);

  // A graded attempt feeds concept mastery whether it was just submitted or
  // reopened from history. Evidence ids are idempotent, so a retry is safe;
  // legacy attempts and regenerated pools are skipped by the bridge.
  useEffect(() => {
    if (phase !== 'reviewing' || !reviewing || !stageId) return;
    const spec = exams[reviewing.kind];
    if (!spec) return;
    void recordExamLearning({ stageId, spec, attempt: reviewing }).catch((error) => {
      log.warn('Failed to record exam learning evidence:', error);
    });
  }, [phase, reviewing, stageId, exams]);

  /**
   * Whole-section budget. A timed MC section hands over to the written section
   * with the learner's answers intact; a timed written section submits what
   * exists. Untimed sections run no interval at all.
   */
  useEffect(() => {
    if (phase !== 'taking' || !activeSpec || !activeVariant) return;
    if (sectionBudgetSec(activeSpec, section) == null) {
      setRemainingSec(null);
      return;
    }

    const tick = () => {
      const deadline = deadlineRef.current;
      if (deadline == null) return;
      const left = secondsRemaining(deadline);
      setRemainingSec(left);
      if (left > 0) return;
      deadlineRef.current = null;
      if (section === 'mc' && activeVariant.frQuestions.length > 0) {
        recordSectionTime('mc');
        beginSection('fr', activeSpec);
        setMcTimedOut(true);
      } else {
        void submitRef.current(true);
      }
    };

    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [activeSpec, activeVariant, beginSection, phase, recordSectionTime, section]);

  const reviewAttempt = useCallback(
    (kind: ExamKind, attempt: ExamAttempt) => {
      const spec = exams[kind];
      if (!spec) return;
      setActiveKind(kind);
      setReviewing(attempt);
      setReviewVariant(resolveAttemptVariant(spec, attempt));
      setPhase('reviewing');
    },
    [exams],
  );

  const close = useCallback(() => {
    onOpenChange(false);
    deadlineRef.current = null;
    setRemainingSec(null);
    setPhase((current) => (current === 'list' ? current : 'list'));
  }, [onOpenChange]);

  const reviewLesson = useCallback(
    (sceneId: string) => {
      useStageStore.getState().setCurrentSceneId(sceneId);
      close();
    },
    [close],
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[90] bg-zinc-950/70 backdrop-blur-md" role="presentation">
      <div
        className="mx-auto my-6 flex h-[calc(100%-3rem)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-zinc-900"
        role="dialog"
        aria-modal="true"
        aria-label={t('exams.title')}
      >
        <div className="flex items-center justify-between border-b border-zinc-200 px-6 py-4 dark:border-zinc-700">
          <div className="flex items-center gap-2.5">
            <BookCheck className="h-5 w-5 text-violet-600 dark:text-violet-400" />
            <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
              {t('exams.title')}
            </h2>
          </div>
          <button
            onClick={close}
            className="rounded-full p-2 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800"
            aria-label={t('exams.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 pb-8">
          {error && (
            <p className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600 dark:bg-red-900/30 dark:text-red-300">
              {error}
            </p>
          )}

          {(phase === 'list' || phase === 'generating') && (
            <div className="flex flex-col gap-3">
              {!eligible && (
                <p className="rounded-lg bg-zinc-50 px-4 py-3 text-sm text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                  {t('exams.needSemester')}
                </p>
              )}
              {EXAM_KINDS.map((kind) => {
                const row = exams[kind];
                const attempts = examAttempts[kind] ?? [];
                const lastAttempt = attempts.at(-1) ?? null;
                const [from, to] = coverageRange(kind, unitCount);
                const isGenerating = generatingKind === kind;
                const form = row ? effectiveExamForm(row) : null;
                const timing = row ? effectiveExamTiming(row) : {};
                const hasTimer = timing.mcSec != null || timing.frSec != null;
                const poolBigger =
                  row != null &&
                  form != null &&
                  (row.mcQuestions.length > form.mcCount || row.frQuestions.length > form.frCount);
                return (
                  <Fragment key={kind}>
                    <div className="flex items-center justify-between rounded-xl border border-zinc-200 px-5 py-4 dark:border-zinc-700">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                          {row?.title ?? t(kind === 'midterm' ? 'exams.midterm' : 'exams.final')}
                        </p>
                        <p className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">
                          {row && form
                            ? t('exams.comp', {
                                mc: form.mcCount,
                                fr: form.frCount,
                                from: from + 1,
                                to: to + 1,
                              })
                            : t('exams.notGenerated')}
                          {lastAttempt && typeof lastAttempt.scorePct === 'number'
                            ? ` · ${t('exams.lastScore', {
                                pct: Math.round(lastAttempt.scorePct * 100),
                              })}`
                            : ''}
                        </p>
                        {row && (hasTimer || poolBigger) && (
                          <p className="mt-0.5 truncate text-[11px] text-zinc-400 dark:text-zinc-500">
                            {hasTimer
                              ? t('exams.timed', {
                                  mc:
                                    timing.mcSec != null
                                      ? formatExamMinutes(timing.mcSec)
                                      : t('exams.untimed'),
                                  fr:
                                    timing.frSec != null
                                      ? formatExamMinutes(timing.frSec)
                                      : t('exams.untimed'),
                                })
                              : ''}
                            {hasTimer && poolBigger ? ' · ' : ''}
                            {poolBigger && row
                              ? t('exams.pool', {
                                  mc: row.mcQuestions.length,
                                  fr: row.frQuestions.length,
                                })
                              : ''}
                          </p>
                        )}
                      </div>
                      <div className="ml-4 flex shrink-0 items-center gap-2">
                        {isGenerating ? (
                          <span className="flex items-center gap-2 text-xs text-violet-600 dark:text-violet-300">
                            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                            {t('exams.generating')}
                          </span>
                        ) : row ? (
                          <>
                            <button
                              onClick={() => startTaking(kind)}
                              className="rounded-lg bg-violet-600 px-3.5 py-2 text-xs font-semibold text-white transition-colors hover:bg-violet-700"
                            >
                              {t(lastAttempt ? 'exams.retake' : 'exams.start')}
                            </button>
                            {lastAttempt && (
                              <button
                                onClick={() => reviewAttempt(kind, lastAttempt)}
                                className="rounded-lg border border-zinc-200 px-3.5 py-2 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
                              >
                                {t('exams.review')}
                              </button>
                            )}
                          </>
                        ) : (
                          <button
                            onClick={() => generateExam(kind)}
                            disabled={!eligible}
                            className="rounded-lg bg-violet-600 px-3.5 py-2 text-xs font-semibold text-white transition-colors enabled:hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {t('exams.generate')}
                          </button>
                        )}
                      </div>
                    </div>
                    {phase === 'list' && row && analytics[kind]?.attempts ? (
                      <ExamAnalyticsPanel
                        analytics={analytics[kind] as ExamAnalytics}
                        onReview={() => {
                          if (lastAttempt) reviewAttempt(kind, lastAttempt);
                        }}
                      />
                    ) : null}
                  </Fragment>
                );
              })}
            </div>
          )}

          {phase === 'taking' && activeSpec && activeVariant && (
            <ExamTaking
              spec={activeSpec}
              variant={activeVariant}
              section={section}
              remainingSec={remainingSec}
              mcTimedOut={mcTimedOut}
              mcAnswers={mcAnswers}
              frAnswers={frAnswers}
              onMc={(qid, value) => setMcAnswers((s) => ({ ...s, [qid]: value }))}
              onFr={(frId, text) => setFrAnswers((s) => ({ ...s, [frId]: text }))}
              onNext={advanceToFr}
              onSubmit={() => void submit(false)}
            />
          )}

          {phase === 'grading' && (
            <div className="mt-16 flex flex-col items-center gap-3 text-center" aria-live="polite">
              <RefreshCw className="h-8 w-8 animate-spin text-violet-600" />
              <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
                {t('exams.grading')}
              </p>
              {timedOut && (
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  {t('exams.submittedByTimer')}
                </p>
              )}
            </div>
          )}

          {phase === 'reviewing' && reviewing && reviewVariant && activeSpec && (
            <ExamReview
              spec={activeSpec}
              variant={reviewVariant}
              attempt={reviewing}
              onReviewLesson={reviewLesson}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function ExamAnalyticsPanel({
  analytics,
  onReview,
}: {
  analytics: ExamAnalytics;
  onReview: () => void;
}) {
  const { t } = useI18n();

  return (
    <details className="rounded-xl border border-zinc-200 bg-zinc-50/60 px-5 py-3 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800/40 dark:text-zinc-200">
      <summary className="flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <TrendingUp className="h-3.5 w-3.5 text-violet-600 dark:text-violet-300" />
        <span className="font-semibold">{t('exams.analyticsTitle')}</span>
        <span className="text-zinc-500 dark:text-zinc-400">
          {t('exams.analyticsSummary', {
            attempts: analytics.attempts,
            best: percent(analytics.bestScorePct),
            average: percent(analytics.averageScorePct),
          })}
        </span>
        <button
          type="button"
          onClick={(event) => {
            event.preventDefault();
            onReview();
          }}
          className="ml-auto rounded-md border border-zinc-200 px-2 py-1 text-[11px] font-medium text-zinc-600 transition-colors hover:bg-white dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          {t('exams.reviewLatest')}
        </button>
      </summary>

      <div className="mt-3 space-y-4 text-xs">
        <div>
          <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
            {t('exams.analyticsTrend')}
          </h4>
          <div className="flex flex-wrap gap-1.5">
            {analytics.trend.map((point, index) => (
              <span
                key={`${point.submittedAt}-${index}`}
                title={new Date(point.submittedAt).toLocaleString()}
                className="rounded-md bg-white px-2 py-1 font-medium tabular-nums text-zinc-600 shadow-sm dark:bg-zinc-900 dark:text-zinc-300"
              >
                {t('exams.analyticsAttempt', {
                  n: index + 1,
                  pct: Math.round(point.scorePct * 100),
                })}
              </span>
            ))}
          </div>
        </div>

        {analytics.mc.length > 0 && (
          <div>
            <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
              {t('exams.analyticsMc')}
            </h4>
            <ul className="space-y-1.5">
              {analytics.mc.slice(0, 3).map((stat) => (
                <li key={stat.questionId} className="space-y-1">
                  <div className="flex items-start justify-between gap-3">
                    <span className="min-w-0 truncate text-zinc-600 dark:text-zinc-300">
                      {stat.question}
                    </span>
                    <span className="shrink-0 tabular-nums text-zinc-500 dark:text-zinc-400">
                      {t('exams.analyticsAccuracy', {
                        pct: Math.round(stat.accuracy * 100),
                        correct: stat.correct,
                        attempts: stat.attempts,
                      })}
                    </span>
                  </div>
                  {stat.misconceptions.length > 0 && (
                    <ul className="space-y-0.5 pl-3 text-[11px] text-amber-600 dark:text-amber-400">
                      {stat.misconceptions.slice(0, 2).map((entry) => (
                        <li key={entry.optionValue}>
                          {t('quiz.misconception')}: {entry.misconception ?? entry.label}{' '}
                          <span className="text-zinc-400 dark:text-zinc-500">({entry.count})</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {analytics.fr.length > 0 && (
          <div>
            <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
              {t('exams.analyticsFr')}
            </h4>
            <ul className="space-y-1.5">
              {analytics.fr.slice(0, 3).map((stat) => (
                <li key={stat.questionId} className="flex items-start justify-between gap-3">
                  <span className="min-w-0 truncate text-zinc-600 dark:text-zinc-300">
                    {stat.prompt}
                  </span>
                  <span className="shrink-0 tabular-nums text-zinc-500 dark:text-zinc-400">
                    {t('exams.analyticsAverage', { pct: Math.round(stat.averagePct * 100) })}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {analytics.timedOut > 0 && (
          <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
            {t('exams.analyticsTimedOut', { count: analytics.timedOut })}
          </p>
        )}
      </div>
    </details>
  );
}

function ScoreRing({ pct, label }: { pct: number; label: string }) {
  const color = pct >= 0.8 ? '#16a34a' : pct >= 0.6 ? '#7c3aed' : '#dc2626';
  const radius = 34;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.min(1, Math.max(0, pct));
  return (
    <div
      className="flex flex-col items-center gap-1"
      role="img"
      aria-label={`${label}: ${Math.round(pct * 100)}%`}
    >
      <svg width="88" height="88" viewBox="0 0 88 88" aria-hidden="true">
        <circle
          cx="44"
          cy="44"
          r={radius}
          fill="none"
          strokeWidth="7"
          className="stroke-zinc-200 dark:stroke-zinc-700"
        />
        <circle
          cx="44"
          cy="44"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - clamped)}
          transform="rotate(-90 44 44)"
        />
        <text
          x="44"
          y="49"
          textAnchor="middle"
          fontSize="19"
          fontWeight="700"
          className="fill-zinc-900 dark:fill-zinc-50"
        >
          {`${Math.round(pct * 100)}%`}
        </text>
      </svg>
      <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</p>
    </div>
  );
}

function SectionTimer({ remainingSec }: { remainingSec: number | null }) {
  const { t } = useI18n();
  if (remainingSec == null) return null;
  const urgent = remainingSec <= 60;
  return (
    <span
      className={
        'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold tabular-nums ' +
        (urgent
          ? 'bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-300'
          : 'bg-violet-50 text-violet-700 dark:bg-violet-900/30 dark:text-violet-200')
      }
      role="timer"
      aria-label={t('exams.timeLeft', { time: formatExamClock(remainingSec) })}
    >
      <Clock className="h-3.5 w-3.5" />
      {formatExamClock(remainingSec)}
    </span>
  );
}

function ExamTaking({
  spec,
  variant,
  section,
  remainingSec,
  mcTimedOut,
  mcAnswers,
  frAnswers,
  onMc,
  onFr,
  onNext,
  onSubmit,
}: {
  spec: ExamSpec;
  variant: ExamVariant;
  section: ExamSection;
  remainingSec: number | null;
  mcTimedOut: boolean;
  mcAnswers: Record<string, string>;
  frAnswers: Record<string, string>;
  onMc: (questionId: string, value: string) => void;
  onFr: (frId: string, text: string) => void;
  onNext: () => void;
  onSubmit: () => void;
}) {
  const { t } = useI18n();
  const hasFr = variant.frQuestions.length > 0;
  const inMc = section === 'mc';
  const answeredMc = variant.mcQuestions.filter(
    (question) => mcAnswers[question.id] != null,
  ).length;
  const answeredFr = variant.frQuestions.filter(
    (question) => (frAnswers[question.id] ?? '').trim().length > 0,
  ).length;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (inMc && hasFr) onNext();
        else onSubmit();
      }}
    >
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl bg-zinc-50 px-5 py-4 dark:bg-zinc-800">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{spec.title}</p>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            {spec.coverage} · {t(inMc ? 'exams.mcSectionShort' : 'exams.frSectionShort')}
          </p>
        </div>
        <SectionTimer remainingSec={remainingSec} />
      </div>

      {mcTimedOut && (
        <p className="mb-4 rounded-lg bg-amber-50 px-4 py-2.5 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
          {t('exams.mcTimeUp')}
        </p>
      )}

      {inMc && (
        <section className="mb-8" aria-label={t('exams.mcSection')}>
          <h3 className="mb-1 text-[11px] font-bold uppercase tracking-[0.12em] text-zinc-500 dark:text-zinc-400">
            {t('exams.mcSection')}
          </h3>
          <p className="mb-4 text-xs text-zinc-500 dark:text-zinc-400">{t('exams.mcIntro')}</p>
          {variant.mcQuestions.map((q, qi) => (
            <fieldset
              key={q.id}
              className="mb-5 rounded-xl border border-zinc-200 px-5 py-4 dark:border-zinc-700"
            >
              <legend className="sr-only">{`MC ${qi + 1}`}</legend>
              <p className="mb-3 text-sm font-medium text-zinc-800 dark:text-zinc-100">
                <span className="mr-1.5 tabular-nums text-zinc-400">{qi + 1}.</span>
                {q.question}
              </p>
              <div className="flex flex-col gap-1.5">
                {q.options.map((opt) => {
                  const picked = mcAnswers[q.id] === opt.value;
                  return (
                    <label
                      key={opt.value}
                      className={
                        'flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 text-sm transition-colors ' +
                        (picked
                          ? 'border-violet-400 bg-violet-50 dark:border-violet-500 dark:bg-violet-900/20'
                          : 'border-transparent hover:bg-zinc-50 dark:hover:bg-zinc-800')
                      }
                    >
                      <input
                        type="radio"
                        name={`mc_${q.id}`}
                        checked={picked}
                        onChange={() => onMc(q.id, opt.value)}
                        className="mt-0.5 accent-violet-600"
                      />
                      <span>
                        <span className="mr-1.5 font-semibold tabular-nums text-zinc-400">
                          {opt.value}.
                        </span>
                        {opt.label}
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </section>
      )}

      {!inMc && (
        <section className="mb-6" aria-label={t('exams.frSection')}>
          <h3 className="mb-1 text-[11px] font-bold uppercase tracking-[0.12em] text-zinc-500 dark:text-zinc-400">
            {t('exams.frSection')}
          </h3>
          <p className="mb-4 text-xs text-zinc-500 dark:text-zinc-400">{t('exams.frIntro')}</p>
          {variant.frQuestions.map((fr, i) => (
            <div
              key={fr.id}
              className="mb-5 rounded-xl border border-zinc-200 px-5 py-4 dark:border-zinc-700"
            >
              <p className="mb-2 text-sm font-medium text-zinc-800 dark:text-zinc-100">
                <span className="mr-1.5 tabular-nums text-zinc-400">{i + 1}.</span>
                {fr.prompt}
              </p>
              {fr.guidance?.length ? (
                <ul className="mb-3 space-y-1 text-xs text-zinc-500 dark:text-zinc-400">
                  {fr.guidance.map((g, gi) => (
                    <li key={gi}>· {g}</li>
                  ))}
                </ul>
              ) : null}
              <p className="mb-2 text-[11px] text-zinc-400">
                {t('exams.rubricShow', { n: fr.rubric.length, pts: fr.maxPoints })}
              </p>
              <div className="mb-3 flex flex-wrap gap-1.5">
                {fr.rubric.map((c) => (
                  <span
                    key={c.id}
                    title={c.lookFor}
                    className="rounded-md bg-zinc-100 px-2 py-1 text-[11px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                  >
                    {c.criterion}
                    <span className="ml-1 text-zinc-400 dark:text-zinc-500">
                      {c.weight === 'essential'
                        ? t('exams.weightEssential')
                        : t('exams.weightImportant')}
                    </span>
                  </span>
                ))}
              </div>
              <textarea
                value={frAnswers[fr.id] ?? ''}
                onChange={(e) => onFr(fr.id, e.target.value)}
                rows={5}
                className="w-full resize-y rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-800 outline-none transition-colors focus:border-violet-400 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100"
                placeholder={t('exams.frPlaceholder')}
                aria-label={t('exams.frAnswerLabel', { n: i + 1 })}
              />
            </div>
          ))}
        </section>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs tabular-nums text-zinc-400 dark:text-zinc-500">
          {inMc
            ? t('exams.answeredCount', {
                answered: answeredMc,
                total: variant.mcQuestions.length,
              })
            : t('exams.answeredCount', {
                answered: answeredFr,
                total: variant.frQuestions.length,
              })}
        </span>
        {inMc && hasFr ? (
          <button
            type="button"
            onClick={onNext}
            className="rounded-lg bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-violet-700"
          >
            {t('exams.nextSection')}
          </button>
        ) : (
          <button
            type="submit"
            className="rounded-lg bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-violet-700"
          >
            {t('exams.submit')}
          </button>
        )}
      </div>
    </form>
  );
}

function RemediationLink({
  outlineId,
  onReviewLesson,
}: {
  outlineId?: string;
  onReviewLesson: (sceneId: string) => void;
}) {
  const { t } = useI18n();
  const scenes = useStageStore((state) => state.scenes);
  if (!outlineId) return null;
  const scene = scenes.find((entry) => entry.outlineId === outlineId);
  if (!scene) return null;
  return (
    <button
      type="button"
      onClick={() => onReviewLesson(scene.id)}
      className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-violet-200 px-3 py-1 text-xs font-medium text-violet-700 transition-colors hover:bg-violet-50 dark:border-violet-800 dark:text-violet-300 dark:hover:bg-violet-950/40"
    >
      <BookOpenText className="h-3.5 w-3.5" />
      {t('quiz.reviewLesson')}: {scene.title}
    </button>
  );
}

function ExamReview({
  spec,
  variant,
  attempt,
  onReviewLesson,
}: {
  spec: ExamSpec;
  variant: ExamVariant;
  attempt: ExamAttempt;
  onReviewLesson: (sceneId: string) => void;
}) {
  const { t } = useI18n();
  const showSectionTimes =
    attempt.sectionSeconds &&
    (attempt.sectionSeconds.mc != null || attempt.sectionSeconds.fr != null);

  return (
    <div>
      <div className="mb-6 flex items-center gap-6 rounded-xl bg-zinc-50 px-6 py-5 dark:bg-zinc-800">
        {attempt.scorePct != null && (
          <ScoreRing pct={attempt.scorePct} label={t('exams.scoreLabel')} />
        )}
        <div className="min-w-0 text-sm">
          <p className="font-semibold text-zinc-900 dark:text-zinc-50">
            {spec.title || t('exams.title')}
          </p>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            {t('exams.submittedAt', {
              time: new Date(attempt.submittedAt).toLocaleString(),
            })}
          </p>
          {showSectionTimes && (
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              {t('exams.sectionTimes', {
                mc:
                  attempt.sectionSeconds?.mc != null
                    ? formatExamClock(attempt.sectionSeconds.mc)
                    : t('exams.untimed'),
                fr:
                  attempt.sectionSeconds?.fr != null
                    ? formatExamClock(attempt.sectionSeconds.fr)
                    : t('exams.untimed'),
              })}
            </p>
          )}
          {attempt.timedOut && (
            <p className="mt-1 text-xs font-medium text-amber-600 dark:text-amber-300">
              {t('exams.submittedByTimer')}
            </p>
          )}
        </div>
      </div>
      {variant.mcQuestions.map((q, qi) => {
        const picked = attempt.mcAnswers[q.id] ?? null;
        return (
          <div
            key={q.id}
            className="mb-4 rounded-xl border border-zinc-200 px-5 py-4 dark:border-zinc-700"
          >
            <p className="text-sm font-medium text-zinc-800 dark:text-zinc-100">
              <span className="mr-1.5 tabular-nums text-zinc-400">{qi + 1}.</span>
              {q.question}
            </p>
            <ul className="mt-2 space-y-1 text-xs">
              {q.options.map((opt) => {
                const isAnswer = q.answer.includes(opt.value);
                const isPicked = picked === opt.value;
                return (
                  <li
                    key={opt.value}
                    className={
                      'flex items-start gap-2 rounded-md px-2 py-1.5 ' +
                      (isAnswer
                        ? 'bg-green-50 dark:bg-green-900/20'
                        : isPicked
                          ? 'bg-red-50 dark:bg-red-900/20'
                          : '')
                    }
                  >
                    {isAnswer ? (
                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-600" />
                    ) : isPicked ? (
                      <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
                    ) : (
                      <MinusCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-300 dark:text-zinc-600" />
                    )}
                    <span className="flex-1 text-zinc-700 dark:text-zinc-200">
                      {`${opt.value}. ${opt.label}`}
                      {opt.rationale && (
                        <span className="mt-0.5 block text-[11px] font-normal text-zinc-500 dark:text-zinc-400">
                          {opt.rationale}
                        </span>
                      )}
                      {isPicked && !isAnswer && opt.misconception && (
                        <span className="mt-0.5 block text-[11px] font-normal text-red-600 dark:text-red-400">
                          {t('quiz.misconception')}: {opt.misconception}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
            {q.analysis && (
              <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{q.analysis}</p>
            )}
            <RemediationLink outlineId={q.remediationOutlineId} onReviewLesson={onReviewLesson} />
          </div>
        );
      })}
      {variant.frQuestions.map((fr, fi) => {
        const grade = attempt.frGrades.find((x) => x.questionId === fr.id);
        const criterionTextById = new Map(fr.rubric.map((c) => [c.id, c.criterion]));
        return (
          <div
            key={fr.id}
            className="mb-4 rounded-xl border border-zinc-200 px-5 py-4 dark:border-zinc-700"
          >
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm font-medium text-zinc-800 dark:text-zinc-100">
                <span className="mr-1.5 tabular-nums text-zinc-400">{fi + 1}.</span>
                {fr.prompt}
              </p>
              <span className="shrink-0 rounded-md bg-zinc-100 px-2 py-1 text-xs font-bold tabular-nums text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200">
                {grade ? `${grade.score} / ${grade.maxPoints}` : t('exams.ungraded')}
              </span>
            </div>
            {grade?.comment && (
              <p className="mt-2 rounded-lg bg-violet-50 px-3 py-2 text-xs text-violet-800 dark:bg-violet-900/20 dark:text-violet-200">
                {grade.comment}
              </p>
            )}
            {grade?.criteria?.length ? (
              <ul className="mt-2 space-y-1">
                {grade.criteria.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-start gap-2 text-xs text-zinc-600 dark:text-zinc-300"
                  >
                    {c.met ? (
                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-600" />
                    ) : (
                      <CircleDot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                    )}
                    <span>
                      <span className="font-medium text-zinc-700 dark:text-zinc-200">
                        {criterionTextById.get(c.id) ?? c.id}
                      </span>
                      {c.comment ? ` — ${c.comment}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {attempt.frAnswers[fr.id] && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-zinc-400">
                  {t('exams.yourAnswer')}
                </summary>
                <p className="mt-1 whitespace-pre-wrap rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                  {attempt.frAnswers[fr.id]}
                </p>
              </details>
            )}
            <RemediationLink outlineId={fr.remediationOutlineId} onReviewLesson={onReviewLesson} />
          </div>
        );
      })}
    </div>
  );
}
