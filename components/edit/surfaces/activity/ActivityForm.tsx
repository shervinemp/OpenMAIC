'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Loader2,
  Plus,
  ShieldCheck,
  Trash2,
  XCircle,
} from 'lucide-react';
import type {
  ActivityCheck,
  ActivityContent,
  CodeActivityCheck,
  CodeActivityContent,
} from '@/lib/types/stage';
import type { ActivityRunner } from '@/lib/activity/code-runner';
import { createPythonCodeRunner } from '@/lib/activity/code-runner';
import { type CodeActivityVerification, verifyCodeActivity } from '@/lib/activity/verify';
import { MarkdownText } from '@/components/scene-renderers/pbl/v2/markdown-text';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import {
  addActivityCheckBound,
  addActivityFileBound,
  addActivityHintBound,
  addActivityReferenceFileBound,
  addActivityTestBound,
  moveActivityTestBound,
  removeActivityCheckBound,
  removeActivityFileBound,
  removeActivityHintBound,
  removeActivityReferenceFileBound,
  removeActivityTestBound,
  updateActivityBasicsBound,
  updateActivityCheckBound,
  updateActivityFileBound,
  updateActivityHintBound,
  updateActivityReferenceFileBound,
  updateActivityTestBound,
  useActivitySurfaceLifecycle,
  useResolvedActivityContent,
} from './use-activity-surface';

const INPUT =
  'w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none transition-colors focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/30';
const LABEL = 'text-[11px] font-semibold uppercase tracking-wide text-muted-foreground';
const SECTION = 'rounded-xl border border-border/70 bg-card p-4';
const CODE =
  'w-full resize-y rounded-md border border-border bg-zinc-950 px-2.5 py-2 font-mono text-[12px] leading-relaxed text-zinc-100 outline-none focus:border-cyan-500';

function Section({
  title,
  description,
  children,
  action,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className={SECTION}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-muted"
    >
      <Plus className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
    >
      <Trash2 className="h-3.5 w-3.5" />
    </button>
  );
}

function checkMode(check: ActivityCheck): 'exact' | 'contains' {
  return 'mode' in check && check.mode === 'contains' ? 'contains' : 'exact';
}

function CheckFields({ check, index }: { check: CodeActivityCheck; index: number }) {
  const { t } = useI18n();
  const pointsValue = check.points === undefined ? '' : String(check.points);
  const labelValue = check.label ?? '';

  return (
    <div className="grid gap-2">
      <div className="grid grid-cols-[minmax(0,1fr)_90px] gap-2">
        <label className="grid gap-1">
          <span className={LABEL}>{t('edit.activity.label')}</span>
          <input
            className={INPUT}
            value={labelValue}
            onChange={(event) =>
              updateActivityCheckBound(index, { label: event.target.value }, 'label')
            }
          />
        </label>
        <label className="grid gap-1">
          <span className={LABEL}>{t('edit.quiz.pointsLabel')}</span>
          <input
            className={INPUT}
            type="number"
            min={0}
            step={0.5}
            value={pointsValue}
            onChange={(event) => {
              const raw = event.target.value.trim();
              updateActivityCheckBound(
                index,
                { points: raw === '' ? undefined : Number(raw) },
                'points',
              );
            }}
          />
        </label>
      </div>

      {check.type === 'expectTests' && (
        <label className="grid gap-1">
          <span className={LABEL}>{t('edit.activity.testIds')}</span>
          <input
            className={INPUT}
            value={(check.testIds ?? []).join(', ')}
            placeholder={t('edit.activity.testIds')}
            onChange={(event) => {
              const ids = event.target.value
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean);
              updateActivityCheckBound(
                index,
                { testIds: ids.length > 0 ? ids : undefined },
                'testIds',
              );
            }}
          />
        </label>
      )}

      {(check.type === 'expectStdout' || check.type === 'expectFile') && (
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_140px]">
          {check.type === 'expectFile' && (
            <label className="grid gap-1">
              <span className={LABEL}>{t('edit.activity.path')}</span>
              <input
                className={INPUT}
                value={check.path}
                onChange={(event) =>
                  updateActivityCheckBound(index, { path: event.target.value }, 'path')
                }
              />
            </label>
          )}
          <label className="grid gap-1">
            <span className={LABEL}>{t('edit.activity.matchMode')}</span>
            <select
              className={INPUT}
              value={checkMode(check)}
              onChange={(event) =>
                updateActivityCheckBound(
                  index,
                  { mode: event.target.value === 'contains' ? 'contains' : 'exact' },
                  'mode',
                )
              }
            >
              <option value="exact">{t('edit.activity.exact')}</option>
              <option value="contains">{t('edit.activity.contains')}</option>
            </select>
          </label>
        </div>
      )}

      {check.type !== 'expectTests' && (
        <label className="grid gap-1">
          <span className={LABEL}>{t('edit.activity.expected')}</span>
          <textarea
            className={CODE}
            rows={3}
            value={check.expected}
            onChange={(event) =>
              updateActivityCheckBound(index, { expected: event.target.value }, 'expected')
            }
          />
        </label>
      )}

      <div className="flex items-center justify-between gap-2">
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          {check.id}
        </span>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={check.hidden === true}
            onChange={(event) =>
              updateActivityCheckBound(index, { hidden: event.target.checked }, 'hidden')
            }
          />
          {t('edit.activity.hidden')}
        </label>
      </div>
    </div>
  );
}

function VerificationPanel({ report }: { report: CodeActivityVerification }) {
  const { t } = useI18n();
  return (
    <div
      data-testid="activity-verification"
      className={cn(
        'rounded-lg border p-3 text-sm',
        report.ok
          ? 'border-emerald-300/60 bg-emerald-50 text-emerald-900 dark:border-emerald-700/40 dark:bg-emerald-500/10 dark:text-emerald-200'
          : 'border-amber-300/60 bg-amber-50 text-amber-900 dark:border-amber-700/40 dark:bg-amber-500/10 dark:text-amber-200',
      )}
    >
      <div className="flex items-center gap-2 font-semibold">
        {report.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
        {report.ok ? t('edit.activity.verified') : t('edit.activity.unverified')}
      </div>
      {report.reference && (
        <p className="mt-1 text-xs">
          {t('edit.activity.verifyReference', {
            passed: report.reference.evaluation.results.filter(
              (result) => result.status === 'passed',
            ).length,
            total: report.reference.evaluation.results.length,
          })}
        </p>
      )}
      {report.starter && (
        <p className="mt-0.5 text-xs">
          {t('edit.activity.verifyStarter', {
            failed: report.starter.evaluation.results.filter((result) => result.status === 'failed')
              .length,
          })}
        </p>
      )}
      {report.issues.length > 0 && (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
          {report.issues.map((issue, index) => (
            <li key={index}>{issue}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CodeActivityEditor({ content }: { content: CodeActivityContent }) {
  const { t } = useI18n();
  const runnerRef = useRef<ActivityRunner | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [report, setReport] = useState<CodeActivityVerification | null>(null);
  const [newCheckType, setNewCheckType] = useState<CodeActivityCheck['type']>('expectTests');

  useEffect(() => {
    const runner = createPythonCodeRunner();
    runnerRef.current = runner;
    return () => {
      runnerRef.current = null;
      runner.dispose();
    };
  }, []);

  // Any edit invalidates a previous verification result.
  useEffect(() => {
    setReport(null);
  }, [content]);

  const verify = useCallback(async () => {
    const runner = runnerRef.current;
    if (!runner || verifying) return;
    setVerifying(true);
    try {
      setReport(await verifyCodeActivity(content, runner));
    } finally {
      setVerifying(false);
    }
  }, [content, verifying]);

  const timeLimit = content.timeLimitSec === undefined ? '' : String(content.timeLimitSec);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-background">
      <div className="mx-auto w-full max-w-4xl space-y-4 px-5 py-5">
        <Section title={t('edit.activity.basics')}>
          <div className="grid gap-3">
            <label className="grid gap-1">
              <span className={LABEL}>{t('edit.activity.instructions')}</span>
              <textarea
                className={INPUT}
                rows={5}
                data-testid="activity-instructions"
                value={content.instructions}
                onChange={(event) =>
                  updateActivityBasicsBound({ instructions: event.target.value }, 'instructions')
                }
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="grid gap-1">
                <span className={LABEL}>{t('edit.activity.language')}</span>
                <input
                  className={INPUT}
                  value={content.language}
                  onChange={(event) =>
                    updateActivityBasicsBound({ language: event.target.value }, 'language')
                  }
                />
              </label>
              <label className="grid gap-1">
                <span className={LABEL}>{t('edit.activity.entryFile')}</span>
                <input
                  className={INPUT}
                  value={content.entryFile}
                  onChange={(event) =>
                    updateActivityBasicsBound({ entryFile: event.target.value }, 'entryFile')
                  }
                />
              </label>
              <label className="grid gap-1">
                <span className={LABEL}>{t('edit.activity.timeLimit')}</span>
                <input
                  className={INPUT}
                  type="number"
                  min={1}
                  max={120}
                  value={timeLimit}
                  placeholder="15"
                  onChange={(event) => {
                    const raw = event.target.value.trim();
                    updateActivityBasicsBound(
                      { timeLimitSec: raw === '' ? undefined : Number(raw) },
                      'timeLimit',
                    );
                  }}
                />
              </label>
            </div>
            <label className="grid gap-1">
              <span className={LABEL}>{t('edit.activity.debrief')}</span>
              <textarea
                className={INPUT}
                rows={2}
                value={content.debrief ?? ''}
                onChange={(event) =>
                  updateActivityBasicsBound({ debrief: event.target.value || undefined }, 'debrief')
                }
              />
            </label>
          </div>
        </Section>

        <Section
          title={t('edit.activity.files')}
          description={t('edit.activity.files')}
          action={<AddButton label={t('edit.activity.filesAdd')} onClick={addActivityFileBound} />}
        >
          <div className="space-y-3">
            {content.files.map((file, index) => (
              <div key={index} className="rounded-lg border border-border/60 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <input
                    className={cn(INPUT, 'flex-1 font-mono text-xs')}
                    value={file.path}
                    onChange={(event) =>
                      updateActivityFileBound(
                        index,
                        { path: event.target.value },
                        `file:${index}:path`,
                      )
                    }
                  />
                  <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={file.editable !== false}
                      onChange={(event) =>
                        updateActivityFileBound(
                          index,
                          { editable: event.target.checked },
                          `file:${index}:editable`,
                        )
                      }
                    />
                    {t('edit.activity.editable')}
                  </label>
                  <RemoveButton
                    label={t('edit.delete')}
                    onClick={() => removeActivityFileBound(index)}
                  />
                </div>
                <textarea
                  className={CODE}
                  rows={6}
                  value={file.content}
                  onChange={(event) =>
                    updateActivityFileBound(
                      index,
                      { content: event.target.value },
                      `file:${index}:content`,
                    )
                  }
                />
              </div>
            ))}
          </div>
        </Section>

        <Section
          title={t('edit.activity.tests')}
          description={t('edit.activity.tests')}
          action={<AddButton label={t('edit.activity.testsAdd')} onClick={addActivityTestBound} />}
        >
          <div className="space-y-3">
            {content.tests.map((test, index) => (
              <div key={test.id} className="rounded-lg border border-border/60 p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <input
                    className={cn(INPUT, 'min-w-40 flex-1')}
                    value={test.name}
                    placeholder={t('edit.activity.testName')}
                    onChange={(event) =>
                      updateActivityTestBound(index, { name: event.target.value }, 'name')
                    }
                  />
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                    {test.id}
                  </span>
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={test.hidden === true}
                      onChange={(event) =>
                        updateActivityTestBound(index, { hidden: event.target.checked }, 'hidden')
                      }
                    />
                    {t('edit.activity.hidden')}
                  </label>
                  <button
                    type="button"
                    onClick={() => moveActivityTestBound(index, -1)}
                    disabled={index === 0}
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-muted disabled:opacity-30"
                    aria-label={t('edit.quiz.moveUp')}
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveActivityTestBound(index, 1)}
                    disabled={index === content.tests.length - 1}
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-muted disabled:opacity-30"
                    aria-label={t('edit.quiz.moveDown')}
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                  <RemoveButton
                    label={t('edit.delete')}
                    onClick={() => removeActivityTestBound(index)}
                  />
                </div>
                <textarea
                  className={CODE}
                  rows={5}
                  value={test.code}
                  placeholder={t('edit.activity.testCode')}
                  onChange={(event) =>
                    updateActivityTestBound(index, { code: event.target.value }, 'code')
                  }
                />
              </div>
            ))}
          </div>
        </Section>

        <Section title={t('edit.activity.checks')} description={t('edit.activity.checks')}>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <select
              className={cn(INPUT, 'max-w-56')}
              value={newCheckType}
              onChange={(event) => setNewCheckType(event.target.value as CodeActivityCheck['type'])}
            >
              <option value="expectTests">{t('edit.activity.checkTests')}</option>
              <option value="expectStdout">{t('edit.activity.checkStdout')}</option>
              <option value="expectFile">{t('edit.activity.checkFile')}</option>
            </select>
            <AddButton
              label={t('edit.activity.checksAdd')}
              onClick={() => addActivityCheckBound(newCheckType)}
            />
          </div>
          <div className="space-y-3">
            {content.checks.map((check, index) => (
              <div key={check.id} className="rounded-lg border border-border/60 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="rounded bg-cyan-50 px-1.5 py-0.5 text-[11px] font-medium text-cyan-800 dark:bg-cyan-500/15 dark:text-cyan-300">
                    {check.type}
                  </span>
                  <RemoveButton
                    label={t('edit.delete')}
                    onClick={() => removeActivityCheckBound(index)}
                  />
                </div>
                <CheckFields check={check} index={index} />
              </div>
            ))}
          </div>
        </Section>

        <Section
          title={t('edit.activity.reference')}
          description={t('edit.activity.referenceNote')}
          action={
            <AddButton
              label={t('edit.activity.referenceAdd')}
              onClick={addActivityReferenceFileBound}
            />
          }
        >
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={verify}
              disabled={verifying}
              data-testid="activity-verify"
              className="inline-flex items-center gap-1.5 rounded-md bg-cyan-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-cyan-700 disabled:opacity-60"
            >
              {verifying ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ShieldCheck className="h-3.5 w-3.5" />
              )}
              {verifying ? t('edit.activity.verifying') : t('edit.activity.verify')}
            </button>
            <span className="text-xs text-muted-foreground">
              {t('edit.activity.referenceNote')}
            </span>
          </div>
          {report && <VerificationPanel report={report} />}
          <div className="mt-3 space-y-3">
            {(content.referenceFiles ?? []).map((file, index) => (
              <div key={index} className="rounded-lg border border-border/60 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <input
                    className={cn(INPUT, 'flex-1 font-mono text-xs')}
                    value={file.path}
                    onChange={(event) =>
                      updateActivityReferenceFileBound(index, { path: event.target.value }, 'path')
                    }
                  />
                  <RemoveButton
                    label={t('edit.delete')}
                    onClick={() => removeActivityReferenceFileBound(index)}
                  />
                </div>
                <textarea
                  className={CODE}
                  rows={6}
                  value={file.content}
                  onChange={(event) =>
                    updateActivityReferenceFileBound(
                      index,
                      { content: event.target.value },
                      'content',
                    )
                  }
                />
              </div>
            ))}
          </div>
        </Section>

        <Section
          title={t('edit.activity.hints')}
          action={<AddButton label={t('edit.activity.hintsAdd')} onClick={addActivityHintBound} />}
        >
          <div className="space-y-2">
            {(content.hints ?? []).map((hint, index) => (
              <div key={index} className="flex items-center gap-2">
                <input
                  className={INPUT}
                  value={hint}
                  onChange={(event) => updateActivityHintBound(index, event.target.value)}
                />
                <RemoveButton
                  label={t('edit.delete')}
                  onClick={() => removeActivityHintBound(index)}
                />
              </div>
            ))}
          </div>
        </Section>

        {content.instructions && (
          <details className="rounded-xl border border-border/70 bg-muted/20 p-4">
            <summary className="cursor-pointer text-sm font-semibold">
              {t('edit.activity.preview')}
            </summary>
            <div className="mt-3">
              <MarkdownText content={content.instructions} />
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

function UnsupportedKind({ content }: { content: Exclude<ActivityContent, CodeActivityContent> }) {
  const { t } = useI18n();
  return (
    <div className="flex h-full items-center justify-center bg-background p-6">
      <div className="max-w-md rounded-xl border border-border/70 bg-card p-6 text-center">
        <h2 className="text-base font-semibold">{t('edit.activity.unsupportedTitle')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {t('edit.activity.unsupportedBody', { kind: content.kind })}
        </p>
        <div className="mt-4 text-left text-sm">
          <MarkdownText content={content.instructions} />
        </div>
      </div>
    </div>
  );
}

export function ActivityForm() {
  const sceneId = useActivitySurfaceLifecycle();
  const content = useResolvedActivityContent();
  const { t } = useI18n();
  const heading = useMemo(() => t('edit.activity.title'), [t]);

  if (!sceneId) return null;
  return (
    <div className="h-full min-h-0" data-activity-editor={sceneId} aria-label={heading}>
      {content.kind === 'code' ? (
        <CodeActivityEditor content={content} />
      ) : (
        <UnsupportedKind content={content} />
      )}
    </div>
  );
}
