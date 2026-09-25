'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Check, GitBranch, Loader2, Trash2 } from 'lucide-react';

import { useI18n } from '@/lib/hooks/use-i18n';
import {
  applyRepoSync,
  bindCourseToRepo,
  fetchCourseMaterialization,
  getCourseBinding,
  scanRepoUpdates,
  unbindCourseRepo,
  type CourseBinding,
  type CourseMaterialization,
  type RepoUpdateEntry,
  type SyncStageResult,
} from '@/lib/persistence/git-course-client';
import { useStageStore } from '@/lib/store';

/**
 * Per-course "Connect to Git…" dialog: bind the CURRENTLY OPEN course to a
 * repository, or disconnect an existing binding. Reached from the course
 * header dropdown so the action sits exactly where the user is thinking
 * about the course. Pure bookkeeping — binding changes never touch course
 * content and can never fail a course save.
 *
 * When bound, the dialog is also the approval confluence for the inbound
 * half: a diff-first update scan (new / update / equal) whose entries PUT
 * through an explicit apply, and the one-click media backfill that hands the
 * server every byte this browser owns (uploads are idempotent and never
 * demote playback).
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
  const [updates, setUpdates] = useState<RepoUpdateEntry[] | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [applyResults, setApplyResults] = useState<SyncStageResult[] | null>(null);
  const [backfillStatus, setBackfillStatus] = useState<string | null>(null);
  const [materialization, setMaterialization] = useState<CourseMaterialization | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    if (!stageId) return;
    const current = await getCourseBinding(stageId);
    if (mountedRef.current) setBinding(current);
    // Live self-containment report (per class: does the server hold the
    // bytes?). Independent of the binding — shown for bound and unbound
    // courses alike, since it answers "is this course physically whole".
    const report = await fetchCourseMaterialization(stageId);
    if (mountedRef.current) setMaterialization(report);
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
        setUpdates(null);
        setApplyResults(null);
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

  // ── Update scan + approval apply (inbound half) ──
  const runUpdateScan = async () => {
    setScanBusy(true);
    setApplyResults(null);
    try {
      const result = await scanRepoUpdates();
      if (mountedRef.current) {
        if (result.ok) {
          setUpdates(result.updates);
        } else {
          setMessage({ kind: 'error', text: result.message });
        }
      }
    } finally {
      if (mountedRef.current) setScanBusy(false);
    }
  };

  const applySelected = async (stageIds: string[], apply: boolean, importNew: boolean) => {
    setScanBusy(true);
    try {
      const result = await applyRepoSync({ apply, importNew, ...(stageIds.length ? { stageIds } : {}) });
      if (mountedRef.current) {
        if (result.ok) setApplyResults(result.results);
        else setMessage({ kind: 'error', text: result.message });
      }
    } finally {
      if (mountedRef.current) setScanBusy(false);
    }
  };

  // ── Media backfill (browser → server byte handoff) ──
  const runMediaBackfill = async () => {
    setBackfillStatus('collecting references…');
    const { stage, scenes, blueprint } = useStageStore.getState();
    const snapshot = stage ? { stage, scenes, outline: blueprint } : null;
    if (!snapshot) {
      setBackfillStatus('no course open');
      return;
    }
    try {
      const { backfillCourseMedia } = await import('@/lib/media/backfill-course-media');
      const progress = await backfillCourseMedia(snapshot);
      setBackfillStatus(
        t('gitSync.backfillDone', {
          uploaded: progress.uploaded,
          existing: progress.skippedExisting,
          missing: progress.noBytes,
        }),
      );
      // The upload just changed server truth — read the fresh counts.
      const report = await fetchCourseMaterialization(stageId ?? '');
      if (mountedRef.current) setMaterialization(report);
    } catch (error) {
      setBackfillStatus(error instanceof Error ? error.message : 'backfill failed');
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

      {/* Live self-containment: per asset class, does the server hold the
          bytes? Answers "can this course play/reproduce anywhere" at a
          glance — and tells you BEFORE a sync whether a backfill is owed. */}
      {materialization && (
        <div
          className={
            materialization.narration.onServer === materialization.narration.declared &&
            materialization.media.onServer === materialization.media.declared
              ? 'rounded-md border border-emerald-500/30 bg-emerald-500/[0.06] px-3 py-2 text-[11px] text-emerald-700 dark:text-emerald-400'
              : 'rounded-md border border-amber-500/40 bg-amber-500/[0.07] px-3 py-2 text-[11px] text-amber-700 dark:text-amber-400'
          }
        >
          <p className="font-medium">{t('gitSync.materializeSection')}</p>
          <p className="mt-0.5 text-[10.5px] leading-relaxed break-words">
            {t('gitSync.materializeNarration', {
              onServer: materialization.narration.onServer,
              declared: materialization.narration.declared,
            })}
          </p>
          <p className="text-[10.5px] leading-relaxed break-words">
            {t('gitSync.materializeMedia', {
              onServer: materialization.media.onServer,
              declared: materialization.media.declared,
            })}
          </p>
        </div>
      )}

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

          {/* Approval confluence: scan, then per-entry apply/import. */}
          <div className="space-y-2 pt-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold text-muted-foreground">
                {t('gitSync.updatesSection')}
              </span>
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2 text-[10px]"
                disabled={scanBusy}
                onClick={() => void runUpdateScan()}
              >
                {scanBusy ? (
                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                ) : (
                  <GitBranch className="w-3 h-3 mr-1" />
                )}
                {t('gitSync.checkUpdates')}
              </Button>
            </div>

            {updates !== null && (
              <div className="space-y-1.5">
                {updates.filter((entry) => entry.state !== 'equal').length === 0 ? (
                  <p className="text-[11px] text-muted-foreground px-1">
                    {t('gitSync.noUpdates')}
                  </p>
                ) : (
                  updates
                    .filter((entry) => entry.state !== 'equal')
                    .map((entry) => (
                      <div
                        key={`${entry.stageId}:${entry.state}`}
                        className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5"
                      >
                        <div className="min-w-0">
                          <p className="text-[11.5px] font-medium truncate">{entry.title}</p>
                          <p className="text-[10px] text-muted-foreground">
                            {t('gitSync.updateState', {
                              state: entry.state,
                              scenes: entry.sceneCount,
                            })}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-[10px] shrink-0"
                          disabled={scanBusy}
                          onClick={() =>
                            void applySelected([entry.stageId], true, entry.state === 'new')
                          }
                        >
                          {entry.state === 'new'
                            ? t('gitSync.import')
                            : t('gitSync.applyUpdate')}
                        </Button>
                      </div>
                    ))
                )}
              </div>
            )}

            {applyResults && (
              <ul className="space-y-1 rounded-md border bg-muted/30 px-2.5 py-2">
                {applyResults.map((result) => (
                  <li key={result.stageId} className="text-[10.5px] text-muted-foreground break-all">
                    <span
                      className={
                        result.action === 'applied' || result.action === 'imported'
                          ? 'text-emerald-600 font-medium'
                          : undefined
                      }
                    >
                      {result.action}
                    </span>{' '}
                    {result.detail}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Media byte handoff (uploads are idempotent). */}
          <div className="space-y-1.5 pt-1 border-t">
            <Button
              size="sm"
              variant="outline"
              className="h-7 w-full text-[11px]"
              disabled={!!backfillStatus && backfillStatus.startsWith('collecting')}
              onClick={() => void runMediaBackfill()}
            >
              <Loader2 className="w-3 h-3 mr-1.5" />
              {t('gitSync.backfillMedia')}
            </Button>
            {backfillStatus && (
              <p className="text-[10.5px] text-muted-foreground">{backfillStatus}</p>
            )}
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
