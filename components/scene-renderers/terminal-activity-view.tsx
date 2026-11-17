'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FlaskConical,
  Lightbulb,
  RotateCcw,
  Terminal,
  XCircle,
} from 'lucide-react';
import type { TerminalActivityContent } from '@/lib/types/stage';
import {
  evaluateActivityChecks,
  projectActivityForLearner,
  type ActivityEvaluation,
} from '@/lib/activity/checks';
import type { ActivityRunResult } from '@/lib/activity/protocol';
import { simulateTerminal, TERMINAL_HOME } from '@/lib/activity/terminal-simulator';
import { createActivityAttemptId } from '@/lib/activity/attempt-id';
import { MarkdownText } from '@/components/scene-renderers/pbl/v2/markdown-text';
import { createLogger } from '@/lib/logger';
import { recordActivityLearning } from '@/lib/learning/record-activity';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';

const log = createLogger('TerminalActivityView');

interface TerminalActivityViewProps {
  readonly content: TerminalActivityContent;
  readonly sceneId: string;
  readonly stageId: string;
}

interface TranscriptEntry {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
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

function displayCwd(cwd: string): string {
  if (cwd === TERMINAL_HOME) return '~';
  if (cwd.startsWith(`${TERMINAL_HOME}/`)) return `~${cwd.slice(TERMINAL_HOME.length)}`;
  return cwd;
}

function initialFiles(activity: TerminalActivityContent): Record<string, string> {
  const files: Record<string, string> = {};
  for (const file of activity.files) files[file.path] = file.content;
  return files;
}

export function TerminalActivityView({ content, sceneId, stageId }: TerminalActivityViewProps) {
  const { t } = useI18n();
  const lab = useMemo(() => projectActivityForLearner(content), [content]);
  const terminal = lab.kind === 'terminal' ? lab : null;
  const [commands, setCommands] = useState<string[]>([]);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [input, setInput] = useState('');
  const [run, setRun] = useState<RunState | null>(null);
  const [hintCount, setHintCount] = useState(0);
  const [showInstructions, setShowInstructions] = useState(true);
  const lastReportRef = useRef<ActivityRunResult | null>(null);
  const outputRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // One terminal session is one attempt. Commands keep updating the same run,
  // so evidence is written when the session first passes, not on every command.
  const sessionIdRef = useRef<string>(createActivityAttemptId());

  useEffect(() => {
    setCommands([]);
    setTranscript([]);
    setInput('');
    setRun(null);
    setHintCount(0);
    lastReportRef.current = null;
    sessionIdRef.current = createActivityAttemptId();
  }, [terminal]);

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
  }, [transcript, run]);

  const execute = useCallback(
    (raw: string) => {
      if (!terminal) return;
      const command = raw.trim();
      if (!command) return;
      if (command === 'clear') {
        setCommands([]);
        setTranscript([]);
        setRun(null);
        lastReportRef.current = null;
        setInput('');
        sessionIdRef.current = createActivityAttemptId();
        return;
      }

      const nextCommands = [...commands, command];
      const report = simulateTerminal({
        initialFiles: initialFiles(terminal),
        commands: nextCommands,
      });
      const previous = lastReportRef.current;
      const stdout =
        previous && report.stdout.startsWith(previous.stdout)
          ? report.stdout.slice(previous.stdout.length)
          : report.stdout;
      const stderr =
        previous && report.stderr.startsWith(previous.stderr)
          ? report.stderr.slice(previous.stderr.length)
          : report.stderr;
      const cwd = previous?.state?.cwd ?? TERMINAL_HOME;

      setTranscript((current) => [...current, { command, cwd, stdout, stderr }]);
      setCommands(nextCommands);
      setInput('');
      lastReportRef.current = report;
      setRun({ runner: report, evaluation: evaluateActivityChecks(terminal, report) });
    },
    [commands, terminal],
  );

  const reset = useCallback(() => {
    setCommands([]);
    setTranscript([]);
    setInput('');
    setRun(null);
    lastReportRef.current = null;
    sessionIdRef.current = createActivityAttemptId();
    inputRef.current?.focus();
  }, []);

  // The simulated shell has no Run button: every command recomputes the run.
  // Only a completed session is evidence, and the session id makes later
  // commands (or a React retry) idempotent with the first successful pass.
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
  const promptCwd = run?.runner.state?.cwd ?? TERMINAL_HOME;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border/70 px-5 py-3">
        <div className="flex items-center gap-2">
          <FlaskConical className="h-5 w-5 text-cyan-600 dark:text-cyan-400" />
          <h1 className="text-base font-semibold">{t('activity.title')}</h1>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Terminal
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
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
          <button
            type="button"
            onClick={reset}
            data-testid="activity-reset"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
          >
            <RotateCcw className="h-4 w-4" />
            {t('activity.reset')}
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

        <section className="flex min-h-0 flex-col overflow-hidden bg-zinc-950">
          <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-4 py-2 text-xs text-zinc-400">
            <Terminal className="h-3.5 w-3.5" />
            {t('activity.terminalSession')}
            {run?.runner.error && <span className="text-rose-300">{run.runner.error}</span>}
          </div>

          <div
            ref={outputRef}
            className="min-h-0 flex-1 overflow-y-auto px-4 py-3 font-mono text-[13px] leading-relaxed"
            aria-live="polite"
          >
            {transcript.length === 0 && (
              <p className="text-zinc-500">{t('activity.terminalEmpty')}</p>
            )}
            {transcript.map((entry, index) => (
              <div key={index} className="mb-2">
                <div className="text-cyan-300">
                  <span className="text-zinc-500">learner@openmaic:</span>
                  <span className="text-emerald-300">{displayCwd(entry.cwd)}</span>
                  <span className="text-zinc-500">$ </span>
                  <span className="text-zinc-100">{entry.command}</span>
                </div>
                {entry.stdout && (
                  <pre className="whitespace-pre-wrap text-zinc-200">{entry.stdout}</pre>
                )}
                {entry.stderr && (
                  <pre className="whitespace-pre-wrap text-rose-300">{entry.stderr}</pre>
                )}
              </div>
            ))}
          </div>

          <form
            className="flex shrink-0 items-center gap-2 border-t border-white/10 px-4 py-3 font-mono text-[13px]"
            onSubmit={(event) => {
              event.preventDefault();
              if (run?.runner.error) return;
              execute(input);
            }}
          >
            <span className="shrink-0 text-zinc-500">learner@openmaic:</span>
            <span className="shrink-0 text-emerald-300">{displayCwd(promptCwd)}</span>
            <span className="shrink-0 text-zinc-500">$</span>
            <input
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-label={t('activity.terminalInput')}
              data-testid="activity-terminal"
              className="min-w-0 flex-1 bg-transparent text-zinc-100 outline-none placeholder:text-zinc-600"
              placeholder={t('activity.terminalPlaceholder')}
            />
          </form>

          {run?.evaluation.passed && terminal.debrief && (
            <div className="shrink-0 border-t border-emerald-700/40 bg-emerald-500/10 px-4 py-3">
              <MarkdownText content={terminal.debrief} />
            </div>
          )}
        </section>
      </div>
      <span className="sr-only" data-activity-scene={sceneId} />
    </div>
  );
}
