'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FolderGit2, GitBranch, Loader2, RefreshCw, Trash2 } from 'lucide-react';

import { useI18n } from '@/lib/hooks/use-i18n';
import {
  bindCourseToRepo,
  listCourseBindings,
  isGitSyncAvailable,
  listUnboundCourses,
  unbindCourseRepo,
  type CourseSummary,
} from '@/lib/persistence/git-course-client';

/**
 * Settings-pane overview card for the per-course git bindings (bindings are
 * created server-side; this card shows every connection in one place and
 * binds/unbinds via `/api/course-git`).
 * Mounted by {@link GeneralSettings}; server persistence disabled → hidden.
 */

interface CourseBinding {
  stageId: string;
  repoPath: string;
  boundAt: number;
}

export function GitCourseSettingsCard() {
  const { t } = useI18n();
  const enabled = useMemo(() => isGitSyncAvailable(), []);
  const [courses, setCourses] = useState<CourseSummary[]>([]);
  const [bindings, setBindings] = useState<CourseBinding[]>([]);
  const [stageId, setStageId] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [initMissing, setInitMissing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const mountedRef = useRef(true);

  const reload = useCallback(async () => {
    if (!enabled) return;
    try {
      const [unbound, currentBindings] = await Promise.all([
        listUnboundCourses(),
        listCourseBindings(),
      ]);
      if (!mountedRef.current) return;
      setCourses(unbound);
      setBindings(currentBindings);
    } catch {
      if (mountedRef.current) setMessage({ kind: 'error', text: t('gitSync.loadFailed') });
    }
  }, [enabled, t]);

  useEffect(() => {
    mountedRef.current = true;
    void reload();
    return () => {
      mountedRef.current = false;
    };
  }, [reload]);

  if (!enabled) return null;

  const bind = async () => {
    if (!stageId || !repoPath.trim()) {
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
        setMessage({ kind: 'ok', text: t('gitSync.bindOk') });
        setRepoPath('');
        setStageId('');
        await reload();
      } else {
        setMessage({ kind: 'error', text: result.message });
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const disconnect = async (binding: CourseBinding) => {
    setBusy(true);
    setMessage(null);
    try {
      if (await unbindCourseRepo(binding.stageId)) {
        setMessage({ kind: 'ok', text: t('gitSync.unbindOk') });
      } else {
        setMessage({ kind: 'error', text: t('gitSync.loadFailed') });
      }
    } finally {
      if (mountedRef.current) {
        setBusy(false);
        await reload();
      }
    }
  };

  return (
    <div className="relative rounded-xl border border-border bg-card overflow-hidden">
      <div className="relative p-4 space-y-4">
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 rounded-md bg-primary/10 text-primary">
            <FolderGit2 className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">{t('gitSync.cardTitle')}</h3>
            <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
              {t('gitSync.desc')}
            </p>
          </div>
        </div>

        {bindings.length > 0 && (
          <ul className="space-y-1.5">
            {bindings.map((binding) => (
              <li
                key={binding.stageId}
                className="flex items-center gap-2 text-xs rounded-md border border-border/60 px-2.5 py-1.5"
              >
                <GitBranch className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                <span className="font-medium truncate max-w-[38%]">{binding.stageId}</span>
                <code className="truncate text-[10px] text-muted-foreground flex-1 text-left">
                  {binding.repoPath}
                </code>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 w-6 p-0 shrink-0"
                  aria-label={t('gitSync.disconnect')}
                  disabled={busy}
                  onClick={() => void disconnect(binding)}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}

        {courses.length > 0 ? (
          <div className="space-y-2">
            <div className="space-y-1">
              <label className="block text-xs font-medium">{t('gitSync.courseLabel')}</label>
              <select
                className="w-full h-8 rounded-md border border-border bg-background px-2 text-xs"
                value={stageId}
                onChange={(event) => setStageId(event.target.value)}
              >
                <option value="">{t('gitSync.coursePlaceholder')}</option>
                {courses.map((course) => (
                  <option key={course.id} value={course.id}>
                    {course.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="block text-xs font-medium">{t('gitSync.repoLabel')}</label>
              <Input
                className="h-8 text-xs"
                placeholder={t('gitSync.repoPlaceholder')}
                value={repoPath}
                onChange={(event) => setRepoPath(event.target.value)}
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="accent-primary"
                checked={initMissing}
                onChange={(event) => setInitMissing(event.target.checked)}
              />
              {t('gitSync.initIfMissing')}
            </label>
            <div className="flex items-center gap-2">
              <Button size="sm" disabled={busy} onClick={() => void bind()}>
                {busy ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : null}
                {t('gitSync.connect')}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void reload()}>
                <RefreshCw className="w-3.5 h-3.5 mr-1" />
                {t('gitSync.refresh')}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">{t('gitSync.hint')}</p>
          </div>
        ) : (
          bindings.length > 0 && (
            <p className="text-xs text-muted-foreground">{t('gitSync.allBound')}</p>
          )
        )}

        {message && (
          <p
            className={
              message.kind === 'ok' ? 'text-xs text-emerald-600' : 'text-xs text-destructive'
            }
          >
            {message.text}
          </p>
        )}
      </div>
    </div>
  );
}
