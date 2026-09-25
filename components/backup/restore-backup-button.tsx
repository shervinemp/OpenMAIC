'use client';

import { useRef } from 'react';

import { DatabaseBackup } from 'lucide-react';

import { useI18n } from '@/lib/hooks/use-i18n';
import { useFullBackup } from '@/lib/backup/use-full-backup';
import { cn } from '@/lib/utils';

/**
 * Compact "Restore backup" affordance for the home page, mirroring the styles
 * of the existing single-course import buttons.
 */
export function RestoreBackupButton({ variant = 'pill' }: { variant?: 'pill' | 'plain' }) {
  const { t } = useI18n();
  const { restoring, restoreFullBackup } = useFullBackup();
  const inputRef = useRef<HTMLInputElement>(null);

  const label = restoring ? t('backup.restoring') : t('backup.restoreFile');

  const className =
    variant === 'plain'
      ? 'flex items-center gap-1.5 text-[12px] text-muted-foreground/40 hover:text-foreground/60 transition-colors disabled:opacity-50'
      : 'group/import-backup grid grid-cols-[auto_0fr] hover:grid-cols-[auto_1fr] items-center gap-1 rounded-full px-1.5 py-0.5 text-[12px] text-muted-foreground/35 hover:text-muted-foreground/70 hover:bg-muted/50 transition-all duration-200 cursor-pointer disabled:opacity-50';
  const labelClassName =
    variant === 'pill'
      ? 'overflow-hidden opacity-0 group-hover/import-backup:opacity-100 transition-opacity duration-200 whitespace-nowrap'
      : undefined;

  return (
    <>
      <button
        type="button"
        className={cn(className)}
        disabled={restoring}
        onClick={() => inputRef.current?.click()}
      >
        <DatabaseBackup className="size-3.5" />
        <span className={labelClassName}>{label}</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        aria-label={t('backup.importHint')}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void restoreFullBackup(file, 'replace');
        }}
      />
    </>
  );
}
