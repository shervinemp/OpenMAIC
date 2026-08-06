'use client';

import { useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Camera, Database, Download, Loader2, Upload } from 'lucide-react';

import { useI18n } from '@/lib/hooks/use-i18n';
import { useFullBackup } from '@/lib/backup/use-full-backup';
import { MAX_AUTO_SNAPSHOTS } from '@/lib/backup/snapshots';

/**
 * Settings-pane card for full local backups: downloadable ZIP, restore-from
 * file with a conflict policy, and in-browser automatic snapshots.
 * Mounted by {@link GeneralSettings}, gated by {@link BACKUP_UI_ENABLED}.
 */
export function BackupSettingsCard() {
  const { t } = useI18n();
  const {
    exporting: backupExporting,
    restoring: backupRestoring,
    progress: backupProgress,
    autoSnapshots,
    snapshots,
    exportFullBackup,
    restoreFullBackup,
    toggleAutoSnapshots,
    captureSnapshot,
    restoreSnapshot,
    deleteSnapshot,
  } = useFullBackup();
  const backupInputRef = useRef<HTMLInputElement>(null);
  const [restoreMode, setRestoreMode] = useState<'replace' | 'skip' | 'add'>('replace');

  return (
    <div className="relative rounded-xl border border-border bg-card overflow-hidden">
      <div className="relative p-4 space-y-4">
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 rounded-md bg-primary/10 text-primary">
            <Database className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">{t('backup.cardTitle')}</h3>
            <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
              {t('backup.desc')}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" onClick={() => void exportFullBackup()} disabled={backupExporting}>
            {backupExporting ? (
              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
            ) : (
              <Download className="w-3.5 h-3.5 mr-1.5" />
            )}
            {backupExporting ? t('backup.exporting') : t('backup.export')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => backupInputRef.current?.click()}
            disabled={backupRestoring}
          >
            {backupRestoring ? (
              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
            ) : (
              <Upload className="w-3.5 h-3.5 mr-1.5" />
            )}
            {backupRestoring ? t('backup.restoring') : t('backup.restoreFile')}
          </Button>
          <input
            ref={backupInputRef}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            aria-label={t('backup.importHint')}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void restoreFullBackup(file, restoreMode);
            }}
          />
          <select
            value={restoreMode}
            onChange={(e) => setRestoreMode(e.target.value as 'replace' | 'skip' | 'add')}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs text-muted-foreground"
            aria-label={t('backup.modeLabel')}
          >
            <option value="replace">{t('backup.modeReplace')}</option>
            <option value="skip">{t('backup.modeSkip')}</option>
            <option value="add">{t('backup.modeAdd')}</option>
          </select>
          {backupProgress && (
            <span className="text-xs text-muted-foreground">{backupProgress}</span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-border/60 pt-3">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch
              checked={autoSnapshots}
              disabled={backupRestoring}
              onCheckedChange={(checked) => void toggleAutoSnapshots(checked)}
            />
            <span>
              {t('backup.autoToggle')}
              <span className="text-muted-foreground">
                {' '}
                ({t('backup.autoToggleHint', { max: MAX_AUTO_SNAPSHOTS })})
              </span>
            </span>
          </label>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void captureSnapshot()}
            disabled={backupExporting || backupRestoring}
          >
            <Camera className="w-3.5 h-3.5 mr-1.5" />
            {t('backup.capture')}
          </Button>
        </div>

        {snapshots.length > 0 && (
          <div className="space-y-2 border-t border-border/60 pt-3">
            <p className="text-xs font-medium text-muted-foreground">
              {t('backup.snapshotsTitle')}
            </p>
            {snapshots.slice(0, 8).map((snapshot) => (
              <div
                key={snapshot.id}
                className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-muted/25 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium">
                    {new Date(snapshot.savedAt).toLocaleString()}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {snapshot.label} · {t('backup.coursesOther', { count: snapshot.courseCount })} ·{' '}
                    {(snapshot.size / 1048576).toFixed(1)} MB
                    {snapshot.settingsIncluded ? t('backup.settingsSuffix') : ''}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={backupRestoring}
                    onClick={() => void restoreSnapshot(snapshot.id, restoreMode)}
                  >
                    {t('backup.restore')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={backupRestoring}
                    onClick={() => void deleteSnapshot(snapshot.id)}
                  >
                    {t('backup.delete')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
