'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FolderGit2, GitBranch, Loader2, RefreshCw, Trash2 } from 'lucide-react';

import { useI18n } from '@/lib/hooks/use-i18n';
import {
  getPersistenceRequestHeaders,
  isBrowserPersistenceEnabled,
} from '@/lib/persistence/bootstrap';
import { listStages } from '@/lib/utils/stage-storage';

/**
 * Settings-pane card tying courses to git repositories (server persistence +
 * file backend only, PERSISTENCE_* mode). Bindings live server-side; this card
 * binds/unbinds and shows status via `/api/course-git`.
 * Mounted by {@link GeneralSettings}; server persistence disabled → hidden.
 */

interface CourseBinding {
  stageId: string;
  repoPath: string;
  boundAt: number;
}

interface CourseSummary {
  id: string;
  name: string;
}

const GIT_SYNC_DEFAULT_DEBOUNCE = '4000';

function gitCourseUrl(path: string): string {
  return `/api/course-git${path}`;
}

async function bindApi(body: {
  stageId: string;
  repoPath: string;
  init: boolean;
}): Promise<{ binding?: CourseBinding; error?: string }> {
  const response = await fetch(gitCourseUrl(''), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await getPersistenceRequestHeaders()) },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as {
    binding?: CourseBinding;
    error?: { message?: string };
  };
  if (!response.ok) {
    return { error: data.error?.message ?? `HTTP ${response.status}` };
  }
  return { binding: data.binding };
}

async function unbindApi(stageId: string): Promise<boolean> {
  const response = await fetch(gitCourseUrl(`?stageId=${encodeURIComponent(stageId)}`), {
    method: 'DELETE',
    headers: await getPersistenceRequestHeaders(),
  });
  if (!response.ok) return false;
  const data = (await response.json().catch(() => ({}))) as { removed?: boolean };
  return data.removed === true;
}

async function bindingsApi(stageId?: string): Promise<CourseBinding[]> {
  const qs = stageId ? `?stageId=${encodeURIComponent(stageId)}` : '';
  const response = await fetch(gitCourseUrl(qs), {
    headers: await getPersistenceRequestHeaders(),
  });
  if (!response.ok) return [];
  const data = (await response.json().catch(() => ({}))) as {
    bindings?: CourseBinding[];
    binding?: CourseBinding | null;
  };
  return data.bindings ?? (data.binding ? [data.binding] : []);
}

export function GitCourseSettingsCard() {
  const { t } = useI18n();
  const enabled = useMemo(() => isBrowserPersistenceEnabled(), []);
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
      const [stages, currentBindings] = await Promise.all([listStages(), bindingsApi()]);
      if (!mountedRef.current) return;
      setCourses(stages.map((stage) => ({ id: stage.id, name: stage.name })));
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

  const byId = new Map(courses.map((course) => [course.id, course.name]));
  const boundIds = new Set(bindings.map((binding) => binding.stageId));
  const unboundCourses = courses.filter((course) => !boundIds.has(course.id));

  const connect = async () => {
    if (!stageId || !repoPath.trim()) {
      setMessage({ kind: 'error', text: t('gitSync.missingFields') });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = await bindApi({ stageId, repoPath: repoPath.trim(), init: initMissing });
      if (result.error || !result.binding) {
        setMessage({ kind: 'error', text: result.error ?? t('gitSync.bindFailed') });
      } else {
        setMessage({ kind: 'ok', text: t('gitSync.bindOk') });
        setRepoPath('');
        setStageId('');
        await reload();
      }
    } catch (error) {
      setMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : t('gitSync.bindFailed'),
      });
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const disconnect = async (target: CourseBinding) => {
    setBusy(true);
    setMessage(null);
    try {
      if (await unbindApi(target.stageId)) {
        setMessage({ kind: 'ok', text: t('gitSync.unbindOk') });
      } else {
        setMessage({ kind: 'error', text: t('gitSync.bindFailed') });
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
                <span className="font-medium truncate max-w-[38%]">
                  {byId.get(binding.stageId) ?? binding.stageId}
                </span>
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

        {unboundCourses.length > 0 ? (
          <div className="space-y-2">
            <div className="space-y-1">
              <Label className="text-xs">{t('gitSync.courseLabel')}</Label>
              <select
                className="w-full h-8 rounded-md border border-border bg-background px-2 text-xs"
                value={stageId}
                onChange={(event) => setStageId(event.target.value)}
              >
                <option value="">{t('gitSync.coursePlaceholder')}</option>
                {unboundCourses.map((course) => (
                  <option key={course.id} value={course.id}>
                    {course.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('gitSync.repoLabel')}</Label>
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
              <Button size="sm" disabled={busy} onClick={() => void connect()}>
                {busy ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : null}
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
          courses.length > 0 && (
            <p className="text-xs text-muted-foreground">{t('gitSync.allBound')}</p>
          )
        )}

        {message && (
          <p
            className={
              message.kind === 'ok'
                ? 'text-xs text-emerald-600'
                : 'text-xs text-destructive'
            }
          >
            {message.text}
          </p>
        )}
      </div>
    </div>
  );
}

export const GIT_SYNC_DEBOUNCE_DEFAULT_HINT = GIT_SYNC_DEFAULT_DEBOUNCE;
