'use client';

import type { ActivityContent } from '@/lib/types/stage';
import { CodeActivityView } from './activity-view';
import { ServerTerminalActivityView } from './server-terminal-activity-view';
import { SqlActivityView } from './sql-activity-view';
import { TerminalActivityView } from './terminal-activity-view';

interface ActivitySceneViewProps {
  readonly content: ActivityContent;
  readonly sceneId: string;
}

/** Playback dispatcher for the three activity families. */
export function ActivityView({ content, sceneId }: ActivitySceneViewProps) {
  if (content.kind === 'code') {
    return <CodeActivityView content={content} sceneId={sceneId} />;
  }
  if (content.kind === 'sql') {
    return <SqlActivityView content={content} sceneId={sceneId} />;
  }
  if (content.runtime === 'server') {
    return <ServerTerminalActivityView content={content} sceneId={sceneId} />;
  }
  return <TerminalActivityView content={content} sceneId={sceneId} />;
}
