'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FlaskConical,
  Lightbulb,
  Loader2,
  Play,
  RotateCcw,
  Server,
  XCircle,
} from 'lucide-react';
import type { TerminalActivityContent } from '@/lib/types/stage';
import {
  evaluateActivityChecks,
  projectActivityForLearner,
  type ActivityEvaluation,
} from '@/lib/activity/checks';
import { buildActivityRunRequest, type ActivityRunResult } from '@/lib/activity/protocol';
import { createServerTerminalRunner } from '@/lib/activity/server-runner';
import type { ActivityRunner } from '@/lib/activity/worker-runner';
import { MarkdownText } from '@/components/scene-renderers/pbl/v2/markdown-text';
import { createActivityAttemptId } from '@/lib/activity/attempt-id';
import { createLogger } from '@/lib/logger';
import { recordActivityLearning } from '@/lib/learning/record-activity';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';

const log = createLogger('ServerTerminalActivityView');

interface ServerTerminalActivityViewProps {
  readonly content: TerminalActivityContent;
  readonly sceneId: string;
  readonly stageId: string;
}

interface RunState {
  runner: ActivityRunResult;
  evaluation: ActivityEvaluation;
}

function checkLabel(
  t: (key: string, options?: Record<string, unknown>) => string,
  checkId: string,
  label: string | undefined,
): string {
  return label && label.trim() ? label : t('activity.checkFallback', { id: checkId });
}

/**
 * Playback for a terminal lab whose runtime is the operator-gated server tier.
 * The whole command list is one submission: a container per shell command would
 * be slow and would not preserve session state.
 */
export function ServerTerminalActivityView({
  content,
  sceneId,
  stageId,
}: ServerTerminalActivityViewProps) {
  const { t } = useI18n();
  const lab = useMemo(() => projectActivityForLearner(content), [content]);
  const terminal = lab.kind === 'terminal' ? lab : null;
  const runnerRef = useRef<ActivityRunner | null>(null);
  const [script, setScript] = useState('');
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<RunState | null>(null);
  const [hintCount, setHintCount] = useState(0);
  const [showInstructions, setShowInstructions] = useState(true);
  // One visit is one attempt: the script starts empty, so only a completed
  // session is evidence, and later passing runs reuse this id.
  const sessionIdRef = useRef<string>(createActivityAttemptId());

  useEffect(() => {
    setScript('');
    setRun(null);
    setHintCount(0);
    sessionIdRef.current = createActivityAttemptId();
  }, [terminal]);

  useEffect(() => {
    const runner = createServerTerminalRunner();
    runnerRef.current = runner;
    return () => {
      runnerRef.current = null;
      runner.dispose();
    };
  }, []);

  const reset = useCallback(() => {
    setScript('');
    setRun(null);
    sessionIdRef.current = createActivityAttemptId();
  }, []);

  const runSession = useCallback(async () => {
    if (!terminal || running) return;
    const runner = runnerRef.current;
    if (!runner) return;
    const commands = script
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const request = buildActivityRunRequest(terminal, { kind: 'terminal', commands });
    if (!request) return;
    setRunning(true);
    try {
      const result = await runner.run(request);
      setRun({ runner: result, evaluation: evaluateActivityChecks(terminal, result) });
    } finally {
      setRunning(false);
    }
  }, [running, script, terminal]);

  useEffect(() => {
    if (!run || !stageId || !run.evaluation.passed) return;
    void recordActivityLearning({
      stageId,
      sceneId,
      attemptId: sessionIdRef.current,
      concepts: terminal?.concepts,
      results: run.evaluation.results,
    }).catch((error) => {
      log.warn('Failed to record activity learning evidence:', error);
    });
  }, [run, terminal, stageId, sceneId]);

  if (!terminal) return null;

  const hints = terminal.hints ?? [];
  const shownHints = hints.slice(0, hintCount);
  const percent = run?.evaluation.percent ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border/70 px-5 py-3">
        <div className="flex items-center gap-2">
          <FlaskConical className="h-5 w-5 text-cyan-600 dark:text-cyan-400" />
          <h1 className="text-base font-semibold">{t('activity.title')}</h1>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Terminal
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300">
            <Server className="h-3 w-3" />
            {t('activity.serverIsolated')}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={reset}
            disabled={running}
            data-testid="activity-reset"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
          >
            <RotateCcw className="h-4 w-4" />
            {t('activity.reset')}
          </button>
          <button
            type="button"
            onClick={runSession}
            disabled={running}
            data-testid="activity-run"
            className="inline-flex items-center gap-1.5 rounded-md bg-cyan-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-cyan-700 disabled:opacity-60"
          >
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {running ? t('activity.running') : t('activity.run')}
          </button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[minmax(280px,0.82fr)_minmax(0,1.6fr)]">
        <aside className="min-h-0 overflow-y-auto border-b border-border/70 px-5 py-4 lg:border-b-0 lg:border-r">
          <button
            type="button"
            onClick={() => setShowInstructions((value) => !value)}
            className="flex w-full items-center gap-1 text-left text-sm font-semibold"
          >
            {showInstructions ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
            {t('activity.brief')}
          </button>
          {showInstructions && (
            <div className="mt-2 text-sm text-foreground/90">
              <MarkdownText content={terminal.instructions} />
            </div>
          )}

          <div className="mt-5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">{t('activity.checks')}</h2>
              {run && percent !== null && (
                <span
                  className={cn(
                    'text-xs font-medium',
                    run.evaluation.passed ? 'text-emerald-600' : 'text-amber-600',
                  )}
                >
                  {run.evaluation.earned}/{run.evaluation.possible}
                </span>
              )}
            </div>
            <ul className="mt-2 space-y-2">
              {terminal.checks
                .filter((check) => !check.hidden)
                .map((check) => {
                  const result = run?.evaluation.results.find(
                    (entry) => entry.checkId === check.id,
                  );
                  return (
                    <li
                      key={check.id}
                      className="rounded-lg border border-border/70 bg-card/60 px-3 py-2"
                    >
                      <div className="flex items-start gap-2">
                        {result?.status === 'passed' ? (
                          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                        ) : result?.status === 'failed' ? (
                          <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                        ) : result?.status === 'ungraded' ? (
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                        ) : (
                          <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-muted-foreground/40" />
                        )}
                        <div className="min-w-0">
                          <p className="text-sm font-medium">
                            {checkLabel(t, check.id, check.label)}
                          </p>
                          {result?.message && (
                            <p className="mt-0.5 text-xs text-muted-foreground">{result.message}</p>
                          )}
                          {result?.status === 'failed' &&
                            result.expected !== undefined &&
                            result.actual !== undefined && (
                              <div className="mt-2 grid gap-1 text-[11px]">
                                <span className="text-muted-foreground">
                                  {t('activity.expectedLabel')}
                                </span>
                                <pre className="max-h-24 overflow-auto rounded bg-muted/60 p-2 font-mono">
                                  {result.expected}
                                </pre>
                                <span className="text-muted-foreground">
                                  {t('activity.actualLabel')}
                                </span>
                                <pre className="max-h-24 overflow-auto rounded bg-muted/60 p-2 font-mono">
                                  {result.actual}
                                </pre>
                              </div>
                            )}
                        </div>
                      </div>
                    </li>
                  );
                })}
            </ul>
          </div>

          {hints.length > 0 && (
            <div className="mt-5">
              <h2 className="text-sm font-semibold">{t('activity.hints')}</h2>
              <ul className="mt-2 space-y-2">
                {shownHints.map((hint, index) => (
                  <li
                    key={index}
                    className="flex gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200"
                  >
                    <Lightbulb className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{hint}</span>
                  </li>
                ))}
              </ul>
              {hintCount < hints.length && (
                <button
                  type="button"
                  onClick={() => setHintCount((value) => value + 1)}
                  className="mt-2 text-xs font-medium text-cyan-700 hover:underline dark:text-cyan-300"
                >
                  {t('activity.showHint')}
                </button>
              )}
            </div>
          )}

          <p className="mt-6 text-[11px] leading-relaxed text-muted-foreground">
            {t('activity.practiceNote')}
          </p>
        </aside>

        <section className="flex min-h-0 flex-col overflow-hidden">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/70 px-4 py-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('activity.serverScript')}
            </h2>
            {run && (
              <span
                data-testid="activity-status"
                className={cn(
                  'rounded-full px-2 py-0.5 text-[11px] font-medium',
                  run.evaluation.passed
                    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300'
                    : 'bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200',
                )}
              >
                {run.evaluation.passed
                  ? t('activity.allPassed')
                  : run.evaluation.percent === null
                    ? t('activity.notGraded')
                    : t('activity.someFailed')}
              </span>
            )}
          </div>
          <textarea
            value={script}
            onChange={(event) => {
              setScript(event.target.value);
              setRun(null);
            }}
            spellCheck={false}
            aria-label={t('activity.serverScript')}
            data-testid="activity-server-script"
            placeholder={t('activity.serverScriptPlaceholder')}
            className="min-h-[220px] flex-1 resize-none bg-zinc-950 p-4 font-mono text-[13px] leading-relaxed text-zinc-100 outline-none placeholder:text-zinc-600"
          />

          <div className="shrink-0 border-t border-border/70 bg-card">
            <div className="px-4 py-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('activity.output')}
              </h2>
            </div>
            <div
              aria-live="polite"
              data-testid="activity-server-output"
              className="max-h-64 min-h-[72px] overflow-auto border-t border-border/50 bg-zinc-950 px-4 py-3 font-mono text-xs text-zinc-200"
            >
              {!run && !running && (
                <span className="text-zinc-500">{t('activity.serverNoOutput')}</span>
              )}
              {running && (
                <span className="inline-flex items-center gap-2 text-zinc-400">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t('activity.running')}
                </span>
              )}
              {run && (
                <div className="space-y-2">
                  {run.runner.error && (
                    <div className="text-rose-300">
                      {run.runner.status === 'timeout'
                        ? t('activity.timeout')
                        : t('activity.runnerError', { message: run.runner.error })}
                    </div>
                  )}
                  {run.runner.stdout && (
                    <pre className="whitespace-pre-wrap">{run.runner.stdout}</pre>
                  )}
                  {run.runner.stderr && (
                    <pre className="whitespace-pre-wrap text-rose-300">{run.runner.stderr}</pre>
                  )}
                  {!run.runner.error && !run.runner.stdout && !run.runner.stderr && (
                    <span className="text-zinc-500">{t('activity.emptyOutput')}</span>
                  )}
                  {run.runner.durationMs > 0 && (
                    <div className="text-[10px] text-zinc-500">
                      {t('activity.duration', { ms: run.runner.durationMs })}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {run?.evaluation.passed && terminal.debrief && (
            <div className="shrink-0 border-t border-border/70 bg-emerald-50 px-4 py-3 dark:bg-emerald-500/10">
              <MarkdownText content={terminal.debrief} />
            </div>
          )}
        </section>
      </div>
      <span className="sr-only" data-activity-scene={sceneId} />
    </div>
  );
}
