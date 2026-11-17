'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import type {
  ActivityExpectFileCheck,
  ActivityExpectStateCheck,
  ActivityExpectStdoutCheck,
  TerminalActivityCheck,
  TerminalActivityContent,
} from '@/lib/types/stage';
import type { ActivityRunner } from '@/lib/activity/worker-runner';
import { createTerminalRunner } from '@/lib/activity/terminal-runner';
import { createServerTerminalRunner } from '@/lib/activity/server-runner';
import { type ActivityVerification, verifyTerminalActivity } from '@/lib/activity/verify';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import {
  ActivityKindSelect,
  AddButton,
  CODE,
  INPUT,
  LABEL,
  RemoveButton,
  Section,
  VerificationPanel,
} from './activity-form-ui';
import {
  addActivityFileBound,
  addActivityHintBound,
  addTerminalCheckBound,
  addTerminalReferenceCommandBound,
  removeActivityFileBound,
  removeActivityHintBound,
  removeTerminalCheckBound,
  removeTerminalReferenceCommandBound,
  setTerminalRuntimeBound,
  switchActivityKindBound,
  updateActivityFileBound,
  updateActivityHintBound,
  updateTerminalBasicsBound,
  updateTerminalCheckBound,
  updateTerminalReferenceCommandBound,
} from './use-activity-surface';

function modeOf(check: ActivityExpectStdoutCheck | ActivityExpectFileCheck): 'exact' | 'contains' {
  return check.mode === 'contains' ? 'contains' : 'exact';
}

function TerminalCheckFields({ check, index }: { check: TerminalActivityCheck; index: number }) {
  const { t } = useI18n();
  const pointsValue = check.points === undefined ? '' : String(check.points);

  return (
    <div className="grid gap-2">
      <div className="grid grid-cols-[minmax(0,1fr)_90px] gap-2">
        <label className="grid gap-1">
          <span className={LABEL}>{t('edit.activity.label')}</span>
          <input
            className={INPUT}
            value={check.label ?? ''}
            onChange={(event) =>
              updateTerminalCheckBound(index, { label: event.target.value }, 'label')
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
              updateTerminalCheckBound(
                index,
                { points: raw === '' ? undefined : Number(raw) },
                'points',
              );
            }}
          />
        </label>
      </div>

      {check.type === 'expectFile' && (
        <label className="grid gap-1">
          <span className={LABEL}>{t('edit.activity.path')}</span>
          <input
            className={INPUT}
            value={(check as ActivityExpectFileCheck).path}
            onChange={(event) =>
              updateTerminalCheckBound(index, { path: event.target.value }, 'path')
            }
          />
        </label>
      )}

      {check.type === 'expectState' && (
        <label className="grid gap-1">
          <span className={LABEL}>{t('edit.activity.statePath')}</span>
          <input
            className={INPUT}
            value={(check as ActivityExpectStateCheck).path}
            placeholder="cwd, env.HOME, file:notes.txt"
            onChange={(event) =>
              updateTerminalCheckBound(index, { path: event.target.value }, 'path')
            }
          />
          <span className="text-[11px] text-muted-foreground">
            {t('edit.activity.statePathHint')}
          </span>
        </label>
      )}

      <label className="grid gap-1">
        <span className={LABEL}>
          {check.type === 'expectStdout' ? t('edit.activity.stdout') : t('edit.activity.expected')}
        </span>
        <textarea
          className={CODE}
          rows={3}
          spellCheck={false}
          value={check.expected}
          onChange={(event) =>
            updateTerminalCheckBound(index, { expected: event.target.value }, 'expected')
          }
        />
      </label>

      {check.type !== 'expectState' && (
        <label className="grid gap-1">
          <span className={LABEL}>{t('edit.activity.matchMode')}</span>
          <select
            className={INPUT}
            value={modeOf(check as ActivityExpectStdoutCheck | ActivityExpectFileCheck)}
            onChange={(event) =>
              updateTerminalCheckBound(
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
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={check.hidden === true}
            onChange={(event) =>
              updateTerminalCheckBound(index, { hidden: event.target.checked }, 'hidden')
            }
          />
          {t('edit.activity.hidden')}
        </label>
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          {check.id}
        </span>
      </div>
    </div>
  );
}

export function TerminalActivityEditor({ content }: { content: TerminalActivityContent }) {
  const { t } = useI18n();
  const runnerRef = useRef<ActivityRunner | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [report, setReport] = useState<ActivityVerification | null>(null);
  const [newCheckType, setNewCheckType] = useState<TerminalActivityCheck['type']>('expectState');

  useEffect(() => {
    const runner =
      content.runtime === 'server' ? createServerTerminalRunner() : createTerminalRunner();
    runnerRef.current = runner;
    return () => {
      runnerRef.current = null;
      runner.dispose();
    };
  }, [content.runtime]);

  useEffect(() => {
    setReport(null);
  }, [content]);

  const verify = useCallback(async () => {
    const runner = runnerRef.current;
    if (!runner || verifying) return;
    setVerifying(true);
    try {
      setReport(await verifyTerminalActivity(content, runner));
    } finally {
      setVerifying(false);
    }
  }, [content, verifying]);

  const timeLimit = content.timeLimitSec === undefined ? '' : String(content.timeLimitSec);
  const referenceCommands = content.referenceCommands ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-background">
      <div className="mx-auto w-full max-w-4xl space-y-4 px-5 py-5">
        <ActivityKindSelect value="terminal" onChange={switchActivityKindBound} />
        <Section title={t('edit.activity.basics')}>
          <div className="grid gap-3">
            <label className="grid gap-1">
              <span className={LABEL}>{t('edit.activity.instructions')}</span>
              <textarea
                className={INPUT}
                rows={4}
                data-testid="activity-instructions"
                value={content.instructions}
                onChange={(event) =>
                  updateTerminalBasicsBound({ instructions: event.target.value }, 'instructions')
                }
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
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
                    updateTerminalBasicsBound(
                      { timeLimitSec: raw === '' ? undefined : Number(raw) },
                      'timeLimit',
                    );
                  }}
                />
              </label>
              <label className="grid gap-1">
                <span className={LABEL}>{t('edit.activity.debrief')}</span>
                <input
                  className={INPUT}
                  value={content.debrief ?? ''}
                  onChange={(event) =>
                    updateTerminalBasicsBound(
                      { debrief: event.target.value || undefined },
                      'debrief',
                    )
                  }
                />
              </label>
            </div>
            <label className="grid gap-1">
              <span className={LABEL}>{t('edit.activity.runtime')}</span>
              <select
                className={INPUT}
                value={content.runtime ?? 'simulation'}
                onChange={(event) =>
                  setTerminalRuntimeBound(event.target.value === 'server' ? 'server' : 'simulation')
                }
              >
                <option value="simulation">{t('edit.activity.runtimeSimulation')}</option>
                <option value="server">{t('edit.activity.runtimeServer')}</option>
              </select>
              <span className="text-[11px] text-muted-foreground">
                {content.runtime === 'server'
                  ? t('edit.activity.runtimeServerNote')
                  : t('edit.activity.runtimeSimulationNote')}
              </span>
            </label>
          </div>
        </Section>

        <Section
          title={t('edit.activity.files')}
          description={t('edit.activity.terminalFilesDescription')}
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
                  <RemoveButton
                    label={t('edit.delete')}
                    onClick={() => removeActivityFileBound(index)}
                  />
                </div>
                <textarea
                  className={CODE}
                  rows={4}
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
          title={t('edit.activity.checks')}
          description={t('edit.activity.terminalChecksDescription')}
        >
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <select
              className={cn(INPUT, 'max-w-56')}
              value={newCheckType}
              onChange={(event) =>
                setNewCheckType(event.target.value as TerminalActivityCheck['type'])
              }
            >
              <option value="expectState">{t('edit.activity.checkState')}</option>
              <option value="expectStdout">{t('edit.activity.checkStdout')}</option>
              <option value="expectFile">{t('edit.activity.checkFile')}</option>
            </select>
            <AddButton
              label={t('edit.activity.checksAdd')}
              onClick={() => addTerminalCheckBound(newCheckType)}
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
                    onClick={() => removeTerminalCheckBound(index)}
                  />
                </div>
                <TerminalCheckFields check={check} index={index} />
              </div>
            ))}
          </div>
        </Section>

        <Section
          title={t('edit.activity.referenceCommands')}
          description={t('edit.activity.referenceCommandsDescription')}
          action={
            <AddButton
              label={t('edit.activity.addReferenceCommand')}
              onClick={addTerminalReferenceCommandBound}
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
          <div className="mt-3 space-y-2">
            {referenceCommands.map((command, index) => (
              <div key={index} className="flex items-center gap-2">
                <span className="shrink-0 font-mono text-xs text-muted-foreground">$</span>
                <input
                  className={cn(INPUT, 'font-mono text-xs')}
                  value={command}
                  placeholder={t('edit.activity.commandPlaceholder')}
                  onChange={(event) =>
                    updateTerminalReferenceCommandBound(index, event.target.value)
                  }
                />
                <RemoveButton
                  label={t('edit.delete')}
                  onClick={() => removeTerminalReferenceCommandBound(index)}
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
      </div>
    </div>
  );
}
