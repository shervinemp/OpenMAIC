'use client';

/**
 * Semester exam overlay (midterm / final).
 *
 * Two sections: a substantial single-answer MC section (auto-graded with
 * explanations) and constructed-response questions graded per rubric by the
 * LLM (`POST /api/exam/grade-fr`). The exam plans from the course blueprint's
 * outlines, so it can be generated as soon as the curriculum exists. Attempts
 * and grades persist with the document via the stage store.
 */

import { useCallback, useState } from 'react';
import type { CourseBlueprint } from '@/lib/types/generation';
import type { SceneOutline } from '@/lib/types/generation';
import {
  BookCheck,
  CheckCircle2,
  CircleDot,
  MinusCircle,
  RefreshCw,
  X,
  XCircle,
} from 'lucide-react';
import { useStageStore } from '@/lib/store/stage';
import { useI18n } from '@/lib/hooks/use-i18n';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { createLogger } from '@/lib/logger';
import type { ExamAttempt, ExamFrGrade, ExamKind, ExamSpec } from '@/lib/types/exam';

const log = createLogger('ExamView');

type Phase = 'list' | 'generating' | 'taking' | 'grading' | 'reviewing';

const localeCode: Record<string, string> = { en: 'en-US', zh: 'zh-CN', ja: 'ja-JP', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', ko: 'ko-KR', pt: 'pt-BR', ru: 'ru-RU' };

function modelHeaders(): Record<string, string> {
  const config = getCurrentModelConfig();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-model': config.modelString,
    'x-api-key': config.apiKey,
  };
  if (config.baseUrl) headers['x-base-url'] = config.baseUrl;
  if (config.providerType) headers['x-provider-type'] = config.providerType;
  return headers;
}

/** Same split as the generation route: midterm covers the front half of units. */
function coverageRange(kind: ExamKind, unitCount: number): [number, number] {
  const to = kind === 'midterm' ? Math.max(0, Math.ceil(unitCount / 2) - 1) : Math.max(0, unitCount - 1);
  return [0, to];
}

function outlinesForRange(
  blueprint?: CourseBlueprint,
  from = 0,
  to = 0,
): SceneOutline[] {
  const units = blueprint?.units;
  if (!units?.length) {
    return blueprint?.lessons?.flatMap((lesson) => lesson.outlines) ?? [];
  }
  return units.slice(from, to + 1).flatMap((u) => u.lessons.flatMap((l) => l.outlines));
}

export default function ExamOverlay({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const blueprint = useStageStore((s) => s.blueprint);
  const exams = useStageStore((s) => s.exams);
  const examAttempts = useStageStore((s) => s.examAttempts);
  const setExamSpec = useStageStore((s) => s.setExamSpec);
  const saveExamAttempt = useStageStore((s) => s.saveExamAttempt);

  const [phase, setPhase] = useState<Phase>('list');
  const [activeKind, setActiveKind] = useState<ExamKind>('midterm');
  const [mcAnswers, setMcAnswers] = useState<Record<string, string>>({});
  const [frAnswers, setFrAnswers] = useState<Record<string, string>>({});
  const [reviewing, setReviewing] = useState<ExamAttempt | null>(null);
  const [generatingKind, setGeneratingKind] = useState<ExamKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  const unitCount = blueprint?.units?.length ?? 0;
  const eligible = unitCount >= 2;
  const kinds: ExamKind[] = ['midterm', 'final'];

  const startTaking = useCallback((kind: ExamKind) => {
    setActiveKind(kind);
    setMcAnswers({});
    setFrAnswers({});
    setPhase('taking');
  }, []);

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
        startTaking(kind);
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

  const submit = useCallback(async () => {
    const target = exams[activeKind];
    if (!target) return;
    setPhase('grading');
    setError(null);
    const mcResults: ExamAttempt['mcResults'] = {};
    target.mcQuestions.forEach((q) => {
      const picked = mcAnswers[q.id] ?? null;
      mcResults[q.id] =
        picked != null && q.answer.includes(picked)
          ? { correct: true, earned: q.points }
          : { correct: false, earned: 0 };
    });

    let frGrades;
    try {
      frGrades = await Promise.all(
        target.frQuestions.map(async (fr) => {
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

    const total = target.mcQuestions.length + frGrades.reduce((sum, g) => sum + g.maxPoints, 0);
    const earned =
      Object.values(mcResults).reduce((s, r) => s + r.earned, 0) +
      frGrades.reduce((s, g) => s + g.score, 0);
    const attempt: ExamAttempt = {
      id: `attempt_${Date.now()}`,
      kind: activeKind,
      mcAnswers,
      frAnswers,
      mcResults,
      frGrades,
      scorePct: total > 0 ? earned / total : null,
      submittedAt: Date.now(),
      gradedAt: Date.now(),
    };
    saveExamAttempt(attempt);
    setReviewing(attempt);
    setPhase('reviewing');
  }, [activeKind, exams, mcAnswers, frAnswers, locale, saveExamAttempt]);

  if (!open) return null;

  const close = () => {
    onOpenChange(false);
    if (phase === 'reviewing' || phase === 'generating') setPhase('list');
  };

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
            <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">{t('exams.title')}</h2>
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
              {kinds.map((kind) => {
                const row = exams[kind];
                const lastAttempt = examAttempts[kind]?.at(-1) ?? null;
                const [from, to] = coverageRange(kind, unitCount);
                const isGenerating = generatingKind === kind;
                return (
                  <div
                    key={kind}
                    className="flex items-center justify-between rounded-xl border border-zinc-200 px-5 py-4 dark:border-zinc-700"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                        {row?.title ?? t(kind === 'midterm' ? 'exams.midterm' : 'exams.final')}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">
                        {row
                          ? t('exams.comp', {
                              mc: row.mcQuestions.length,
                              fr: row.frQuestions.length,
                              from: from + 1,
                              to: to + 1,
                            })
                          : t('exams.notGenerated')}
                        {lastAttempt && typeof lastAttempt.scorePct === 'number'
                          ? ` · ${t('exams.lastScore', { pct: Math.round(lastAttempt.scorePct * 100) })}`
                          : ''}
                      </p>
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
                              onClick={() => {
                                setActiveKind(kind);
                                setReviewing(lastAttempt);
                                setPhase('reviewing');
                              }}
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
                );
              })}
            </div>
          )}

          {phase === 'taking' && exams[activeKind] && (
            <ExamTaking
              spec={exams[activeKind] as ExamSpec}
              mcAnswers={mcAnswers}
              frAnswers={frAnswers}
              onMc={(qid, value) => setMcAnswers((s) => ({ ...s, [qid]: value }))}
              onFr={(frId, text) => setFrAnswers((s) => ({ ...s, [frId]: text }))}
              onSubmit={submit}
            />
          )}

          {phase === 'grading' && (
            <div className="mt-16 flex flex-col items-center gap-3 text-center" aria-live="polite">
              <RefreshCw className="h-8 w-8 animate-spin text-violet-600" />
              <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">{t('exams.grading')}</p>
            </div>
          )}

          {phase === 'reviewing' && reviewing && <ExamReview attempt={reviewing} />}
        </div>
      </div>
    </div>
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
        <circle cx="44" cy="44" r={radius} fill="none" strokeWidth="7" className="stroke-zinc-200 dark:stroke-zinc-700" />
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
        <text x="44" y="49" textAnchor="middle" fontSize="19" fontWeight="700" className="fill-zinc-900 dark:fill-zinc-50">
          {`${Math.round(pct * 100)}%`}
        </text>
      </svg>
      <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</p>
    </div>
  );
}

function ExamTaking({
  spec,
  mcAnswers,
  frAnswers,
  onMc,
  onFr,
  onSubmit,
}: {
  spec: ExamSpec;
  mcAnswers: Record<string, string>;
  frAnswers: Record<string, string>;
  onMc: (questionId: string, value: string) => void;
  onFr: (frId: string, text: string) => void;
  onSubmit: () => void;
}) {
  const { t } = useI18n();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <div className="mb-4 rounded-xl bg-zinc-50 px-5 py-4 dark:bg-zinc-800">
        <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{spec.title}</p>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{spec.coverage}</p>
      </div>

      <section className="mb-8" aria-label={t('exams.mcSection')}>
        <h3 className="mb-1 text-[11px] font-bold uppercase tracking-[0.12em] text-zinc-500 dark:text-zinc-400">
          {t('exams.mcSection')}
        </h3>
        <p className="mb-4 text-xs text-zinc-500 dark:text-zinc-400">{t('exams.mcIntro')}</p>
        {spec.mcQuestions.map((q, qi) => (
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
                      <span className="mr-1.5 font-semibold tabular-nums text-zinc-400">{opt.value}.</span>
                      {opt.label}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
      </section>

      <section className="mb-6" aria-label={t('exams.frSection')}>
        <h3 className="mb-1 text-[11px] font-bold uppercase tracking-[0.12em] text-zinc-500 dark:text-zinc-400">
          {t('exams.frSection')}
        </h3>
        <p className="mb-4 text-xs text-zinc-500 dark:text-zinc-400">{t('exams.frIntro')}</p>
        {spec.frQuestions.map((fr, i) => (
          <div key={fr.id} className="mb-5 rounded-xl border border-zinc-200 px-5 py-4 dark:border-zinc-700">
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
                    {c.weight === 'essential' ? t('exams.weightEssential') : t('exams.weightImportant')}
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

      <div className="flex justify-end">
        <button
          type="submit"
          className="rounded-lg bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-violet-700"
        >
          {t('exams.submit')}
        </button>
      </div>
    </form>
  );
}

function ExamReview({ attempt }: { attempt: ExamAttempt }) {
  const { t } = useI18n();
  const exams = useStageStore((s) => s.exams);
  const spec = exams[attempt.kind];
  return (
    <div>
      <div className="mb-6 flex items-center gap-6 rounded-xl bg-zinc-50 px-6 py-5 dark:bg-zinc-800">
        {attempt.scorePct != null && (
          <ScoreRing pct={attempt.scorePct} label={t('exams.scoreLabel')} />
        )}
        <div className="min-w-0 text-sm">
          <p className="font-semibold text-zinc-900 dark:text-zinc-50">
            {spec?.title ?? t('exams.title')}
          </p>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            {t('exams.submittedAt', {
              time: new Date(attempt.submittedAt).toLocaleString(),
            })}
          </p>
        </div>
      </div>
      {spec?.mcQuestions.map((q, qi) => {
        const picked = attempt.mcAnswers[q.id] ?? null;
        return (
          <div key={q.id} className="mb-4 rounded-xl border border-zinc-200 px-5 py-4 dark:border-zinc-700">
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
                      'flex items-center gap-2 rounded-md px-2 py-1.5 ' +
                        (isAnswer
                          ? 'bg-green-50 dark:bg-green-900/20'
                          : isPicked
                            ? 'bg-red-50 dark:bg-red-900/20'
                            : '')
                    }
                  >
                    {isAnswer ? (
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-600" />
                    ) : isPicked ? (
                      <XCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
                    ) : (
                      <MinusCircle className="h-3.5 w-3.5 shrink-0 text-zinc-300 dark:text-zinc-600" />
                    )}
                    <span className="text-zinc-700 dark:text-zinc-200">{`${opt.value}. ${opt.label}`}</span>
                  </li>
                );
              })}
            </ul>
            {q.analysis && <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{q.analysis}</p>}
          </div>
        );
      })}
      {spec?.frQuestions.map((fr, fi) => {
        const grade = attempt.frGrades.find((x) => x.questionId === fr.id);
        const criterionTextById = new Map(fr.rubric.map((c) => [c.id, c.criterion]));
        return (
          <div key={fr.id} className="mb-4 rounded-xl border border-zinc-200 px-5 py-4 dark:border-zinc-700">
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
                  <li key={c.id} className="flex items-start gap-2 text-xs text-zinc-600 dark:text-zinc-300">
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
                <summary className="cursor-pointer text-xs text-zinc-400">{t('exams.yourAnswer')}</summary>
                <p className="mt-1 whitespace-pre-wrap rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                  {attempt.frAnswers[fr.id]}
                </p>
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}