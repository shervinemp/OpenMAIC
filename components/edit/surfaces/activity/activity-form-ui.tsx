'use client';

import { CheckCircle2, Plus, Trash2, XCircle } from 'lucide-react';
import type { ActivityVerification } from '@/lib/activity/verify';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';

export const INPUT =
  'w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none transition-colors focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/30';
export const LABEL = 'text-[11px] font-semibold uppercase tracking-wide text-muted-foreground';
const SECTION = 'rounded-xl border border-border/70 bg-card p-4';
export const CODE =
  'w-full resize-y rounded-md border border-border bg-zinc-950 px-2.5 py-2 font-mono text-[12px] leading-relaxed text-zinc-100 outline-none focus:border-cyan-500';

export function Section({
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

export function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
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

export function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
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

export function VerificationPanel({ report }: { report: ActivityVerification }) {
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

/**
 * Lab-family switch. Changing it resets the kind-specific fields to a valid
 * stub (undo restores them), so an author can start a SQL or terminal lab from
 * the rail's default code lab.
 */
export function ActivityKindSelect({
  value,
  onChange,
}: {
  value: 'code' | 'sql' | 'terminal';
  onChange: (kind: 'code' | 'sql' | 'terminal') => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-card px-4 py-3">
      <div>
        <p className="text-sm font-semibold">{t('edit.activity.kind')}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('edit.activity.kindDescription')}</p>
      </div>
      <select
        value={value}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next === 'sql' ? 'sql' : next === 'terminal' ? 'terminal' : 'code');
        }}
        className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
      >
        <option value="code">{t('edit.activity.kindCode')}</option>
        <option value="sql">{t('edit.activity.kindSql')}</option>
        <option value="terminal">{t('edit.activity.kindTerminal')}</option>
      </select>
    </div>
  );
}
