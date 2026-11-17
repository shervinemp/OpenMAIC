'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import type { ActivityExpectSqlRowsCheck, SqlActivityContent, SqlValue } from '@/lib/types/stage';
import type { ActivityRunner } from '@/lib/activity/worker-runner';
import { createSqlActivityRunner } from '@/lib/activity/sql-runner';
import { type ActivityVerification, verifySqlActivity } from '@/lib/activity/verify';
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
  addActivityHintBound,
  addSqlCheckBound,
  removeActivityHintBound,
  removeSqlCheckBound,
  setSqlReferenceBound,
  setSqlSetupBound,
  setSqlStarterBound,
  switchActivityKindBound,
  updateActivityHintBound,
  updateSqlBasicsBound,
  updateSqlCheckBound,
} from './use-activity-surface';

function isSqlRowValue(value: unknown): value is SqlValue {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

/**
 * Expected rows are authored as JSON. The editor keeps its own text so an
 * invalid intermediate keystroke is not written into the scene (which would
 * make the lab unloadable); only a complete array-of-arrays reaches the store.
 */
function SqlRowsEditor({
  value,
  onChange,
}: {
  value: SqlValue[][];
  onChange: (rows: SqlValue[][] | null) => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    try {
      if (JSON.stringify(JSON.parse(text)) === JSON.stringify(value)) return;
    } catch {
      /* fall through to the committed value */
    }
    setText(JSON.stringify(value, null, 2));
    setInvalid(false);
    // `text` is intentionally not a dependency: this only re-syncs when the
    // committed value changes (undo/redo, imported scene).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const parse = (next: string) => {
    setText(next);
    if (next.trim() === '') {
      setInvalid(false);
      onChange([]);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(next);
      if (
        !Array.isArray(parsed) ||
        parsed.some((row) => !Array.isArray(row) || row.some((cell) => !isSqlRowValue(cell)))
      ) {
        setInvalid(true);
        onChange(null);
        return;
      }
      setInvalid(false);
      onChange(parsed as SqlValue[][]);
    } catch {
      setInvalid(true);
      onChange(null);
    }
  };

  return (
    <label className="grid gap-1">
      <span className={LABEL}>{t('edit.activity.expectedRows')}</span>
      <textarea
        className={cn(CODE, invalid && 'border-destructive focus:border-destructive')}
        rows={4}
        spellCheck={false}
        value={text}
        onChange={(event) => parse(event.target.value)}
      />
      {invalid && (
        <span className="text-[11px] text-destructive">{t('edit.activity.invalidRows')}</span>
      )}
    </label>
  );
}

function SqlCheckFields({ check, index }: { check: ActivityExpectSqlRowsCheck; index: number }) {
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
            onChange={(event) => updateSqlCheckBound(index, { label: event.target.value }, 'label')}
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
              updateSqlCheckBound(
                index,
                { points: raw === '' ? undefined : Number(raw) },
                'points',
              );
            }}
          />
        </label>
      </div>

      <label className="grid gap-1">
        <span className={LABEL}>{t('edit.activity.probeSql')}</span>
        <textarea
          className={CODE}
          rows={2}
          spellCheck={false}
          value={check.sql}
          onChange={(event) => updateSqlCheckBound(index, { sql: event.target.value }, 'sql')}
        />
      </label>

      <SqlRowsEditor
        value={check.expected}
        onChange={(rows) => {
          if (rows) updateSqlCheckBound(index, { expected: rows }, 'expected');
        }}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={check.ordered === true}
              onChange={(event) =>
                updateSqlCheckBound(index, { ordered: event.target.checked }, 'ordered')
              }
            />
            {t('edit.activity.ordered')}
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={check.hidden === true}
              onChange={(event) =>
                updateSqlCheckBound(index, { hidden: event.target.checked }, 'hidden')
              }
            />
            {t('edit.activity.hidden')}
          </label>
        </div>
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          {check.id}
        </span>
      </div>
    </div>
  );
}

export function SqlActivityEditor({ content }: { content: SqlActivityContent }) {
  const { t } = useI18n();
  const runnerRef = useRef<ActivityRunner | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [report, setReport] = useState<ActivityVerification | null>(null);

  useEffect(() => {
    const runner = createSqlActivityRunner();
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
      setReport(await verifySqlActivity(content, runner));
    } finally {
      setVerifying(false);
    }
  }, [content, verifying]);

  const timeLimit = content.timeLimitSec === undefined ? '' : String(content.timeLimitSec);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-background">
      <div className="mx-auto w-full max-w-4xl space-y-4 px-5 py-5">
        <ActivityKindSelect value="sql" onChange={switchActivityKindBound} />
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
                  updateSqlBasicsBound({ instructions: event.target.value }, 'instructions')
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
                    updateSqlBasicsBound(
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
                    updateSqlBasicsBound({ debrief: event.target.value || undefined }, 'debrief')
                  }
                />
              </label>
            </div>
          </div>
        </Section>

        <Section
          title={t('edit.activity.setupSql')}
          description={t('edit.activity.setupSqlDescription')}
        >
          <textarea
            className={CODE}
            rows={7}
            spellCheck={false}
            data-testid="activity-setup-sql"
            value={content.setupSql}
            onChange={(event) => setSqlSetupBound(event.target.value)}
          />
        </Section>

        <Section
          title={t('edit.activity.starterSql')}
          description={t('edit.activity.starterSqlDescription')}
        >
          <textarea
            className={CODE}
            rows={5}
            spellCheck={false}
            data-testid="activity-starter-sql"
            value={content.starterSql}
            onChange={(event) => setSqlStarterBound(event.target.value)}
          />
        </Section>

        <Section
          title={t('edit.activity.checks')}
          description={t('edit.activity.sqlChecksDescription')}
          action={<AddButton label={t('edit.activity.checksAdd')} onClick={addSqlCheckBound} />}
        >
          <div className="space-y-3">
            {content.checks.map((check, index) => (
              <div key={check.id} className="rounded-lg border border-border/60 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="rounded bg-cyan-50 px-1.5 py-0.5 text-[11px] font-medium text-cyan-800 dark:bg-cyan-500/15 dark:text-cyan-300">
                    {check.type}
                  </span>
                  <RemoveButton
                    label={t('edit.delete')}
                    onClick={() => removeSqlCheckBound(index)}
                  />
                </div>
                <SqlCheckFields check={check} index={index} />
              </div>
            ))}
          </div>
        </Section>

        <Section
          title={t('edit.activity.referenceSql')}
          description={t('edit.activity.referenceSqlDescription')}
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
          <textarea
            className={cn(CODE, 'mt-3')}
            rows={7}
            spellCheck={false}
            data-testid="activity-reference-sql"
            value={content.referenceSql ?? ''}
            onChange={(event) => setSqlReferenceBound(event.target.value)}
          />
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
