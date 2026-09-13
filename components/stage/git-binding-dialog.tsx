'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Check, GitBranch, Loader2, Trash2 } from 'lucide-react';

import { useI18n } from '@/lib/hooks/use-i18n';
import {
  bindCourseToRepo,
  getCourseBinding,
  unbindCourseRepo,
  type CourseBinding,
} from '@/lib/persistence/git-course-client';

/**
 * Per-course "Connect to Git…" dialog: bind the CURRENTLY OPEN course to a
 * repository, or disconnect an existing binding. Reached from the course
 * header dropdown so the action sits exactly where the user is thinking
 * about the course. Pure bookkeeping — binding changes never touch course
 * content and can never fail a course save.
 */

export function GitBindingDialog({
  stageId,
  open,
  onOpenChange,
  onBindingChanged,
}: {
  stageId: string | null | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Lets the parent close itself after a successful disconnect/bind. */
  onBindingChanged?: () => void;
}) {
  const { t } = useI18n();
  const [binding, setBinding] = useState<CourseBinding | null>(null);
  const [repoPath, setRepoPath] = useState('');
  const [initMissing, setInitMissing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    if (!stageId) return;
    const current = await getCourseBinding(stageId);
    if (mountedRef.current) setBinding(current);
  }, [stageId]);

  useEffect(() => {
    mountedRef.current = true;
    if (open) void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [open, refresh]);

  if (!stageId) return null;

  const connect = async () => {
    if (!repoPath.trim()) {
      setMessage({ kind: 'error', text: t('gitSync.missingFields') });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = await bindCourseToRepo({
        stageId,
        repoPath: repoPath.trim(),
        init: initMissing,
      });
      if (result.ok) {
        setBinding(result.binding);
        setRepoPath('');
        setMessage({ kind: 'ok', text: t('gitSync.bindOk') });
        onBindingChanged?.();
      } else {
        setMessage({ kind: 'error', text: result.message });
      }
    } catch (error) {
      setMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : t('gitSync.bindFailed'),
      });
    } finally {
      if (mountedRef.current) {
        setBusy(false);
        onOpenChange(false);
      }
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setMessage(null);
    try {
      if (await unbindCourseRepo(stageId)) {
        setBinding(null);
        setMessage({ kind: 'ok', text: t('gitSync.unbindOk') });
        onBindingChanged?.();
      } else {
        setMessage({ kind: 'error', text: t('gitSync.bindFailed') });
      }
    } finally {
      if (mountedRef.current) {
        setBusy(false);
        onOpenChange(false);
      }
    }
  };

  return (
    <div className="w-[min(420px,90vw)] space-y-3 p-4">
      <div className="flex items-center gap-2.5">
        <div className="p-1.5 rounded-md bg-primary/10 text-primary shrink-0">
          <GitBranch className="w-4 h-4" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{t('gitSync.dialogTitle')}</h3>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            {t('gitSync.dialogDesc')}
          </p>
        </div>
      </div>

      {binding ? (
        <div className="space-y-2.5">
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/[0.06] px-3 py-2.5 space-y-1">
            <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5" />
              {t('gitSync.connectedLabel')}
            </p>
            <code className="block text-[10.5px] text-muted-foreground break-all">
              {binding.repoPath}
            </code>
          </div>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={() => void disconnect()}
          >
            {busy ? (
              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
            ) : (
              <Trash2 className="w-3.5 h-3.5 mr-1.5" />
            )}
            {t('gitSync.disconnect')}
          </Button>
        </div>
      ) : (
        <div className="space-y-2.5">
          <Input
            className="h-8 text-xs"
            placeholder={t('gitSync.repoPlaceholder')}
            value={repoPath}
            disabled={busy}
            onChange={(event) => setRepoPath(event.target.value)}
          />
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="accent-primary"
              checked={initMissing}
              disabled={busy}
              onChange={(event) => setInitMissing(event.target.checked)}
            />
            {t('gitSync.initIfMissing')}
          </label>
          <Button size="sm" disabled={busy} onClick={() => void connect()}>
            {busy ? (
              <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
            ) : (
              <GitBranch className="w-3.5 h-3.5 mr-1" />
            )}
            {t('gitSync.connect')}
          </Button>
        </div>
      )}

      {message && (
        <p className={message.kind === 'ok' ? 'text-xs text-emerald-600' : 'text-xs text-destructive'}>
          {message.text}
        </p>
      )}
    </div>
  );
}
