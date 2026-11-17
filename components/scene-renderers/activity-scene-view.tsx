'use client';

import { Terminal } from 'lucide-react';
import type { ActivityContent } from '@/lib/types/stage';
import { useI18n } from '@/lib/hooks/use-i18n';
import { CodeActivityView } from './activity-view';
import { SqlActivityView } from './sql-activity-view';

interface ActivitySceneViewProps {
  readonly content: ActivityContent;
  readonly sceneId: string;
}

/**
 * Playback dispatcher for the activity families. Code and SQL have real
 * runtimes today; a terminal lab without its simulation runtime is shown as
 * unavailable rather than as a fake shell.
 */
export function ActivityView({ content, sceneId }: ActivitySceneViewProps) {
  if (content.kind === 'code') {
    return <CodeActivityView content={content} sceneId={sceneId} />;
  }
  if (content.kind === 'sql') {
    return <SqlActivityView content={content} sceneId={sceneId} />;
  }
  return <UnavailableActivity content={content} sceneId={sceneId} />;
}

function UnavailableActivity({
  content,
  sceneId,
}: {
  content: Exclude<ActivityContent, { kind: 'code' | 'sql' }>;
  sceneId: string;
}) {
  const { t } = useI18n();
  return (
    <div className="flex h-full items-center justify-center bg-background p-6">
      <div className="max-w-md rounded-xl border border-border/70 bg-card p-6 text-center">
        <Terminal className="mx-auto h-8 w-8 text-muted-foreground" />
        <h2 className="mt-3 text-lg font-semibold">{t('activity.unavailableTitle')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {t('activity.unavailableBody', { kind: content.kind })}
        </p>
      </div>
      <span className="sr-only" data-activity-scene={sceneId} />
    </div>
  );
}
