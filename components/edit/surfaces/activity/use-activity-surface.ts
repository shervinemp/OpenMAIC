'use client';

import { useEffect } from 'react';
import type { EditorHint, SurfaceState } from '@/lib/edit/scene-editor-surface';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useStageStore } from '@/lib/store/stage';
import type {
  ActivityCheck,
  ActivityContent,
  ActivityFile,
  ActivityTest,
  CodeActivityCheck,
  CodeActivityContent,
} from '@/lib/types/stage';
import {
  addActivityCheck,
  addActivityFile,
  addActivityHint,
  addActivityReferenceFile,
  addActivityTest,
  moveActivityTest,
  removeActivityCheck,
  removeActivityFile,
  removeActivityHint,
  removeActivityReferenceFile,
  removeActivityTest,
  setActivityHints,
  updateActivityBasics,
  updateActivityCheck,
  updateActivityFile,
  updateActivityHint,
  updateActivityReferenceFile,
  updateActivityTest,
} from './activity-edit-ops';
import { useActivityEditSession } from './activity-edit-session';

/** The activity form owns its expansion state; the chrome has no selection. */
export type ActivitySelection = undefined;

const EMPTY_ACTIVITY: ActivityContent = {
  type: 'activity',
  kind: 'code',
  language: 'python',
  entryFile: 'main.py',
  instructions: '',
  files: [{ path: 'main.py', content: '' }],
  tests: [],
  checks: [],
};

function currentActivityContent(sceneId: string): ActivityContent | null {
  const scene = useStageStore.getState().scenes.find((item) => item.id === sceneId);
  return scene && scene.type === 'activity' ? (scene.content as ActivityContent) : null;
}

function resolvePresent(): ActivityContent {
  const { history, sceneId } = useActivityEditSession.getState();
  return history?.present ?? (sceneId ? currentActivityContent(sceneId) : null) ?? EMPTY_ACTIVITY;
}

function codeOrNull(content: ActivityContent): CodeActivityContent | null {
  return content.kind === 'code' ? content : null;
}

// ---------------------------------------------------------------------------
// Bound mutations — module closures read the current session, never a
// per-render capture, so the chrome's state comparison cannot go stale.
// ---------------------------------------------------------------------------

export function commitActivity(next: ActivityContent): void {
  useActivityEditSession.getState().commit(next);
}

export function updateActivityBasicsBound(
  patch: Parameters<typeof updateActivityBasics>[1],
  coalesceKey: string,
): void {
  useActivityEditSession
    .getState()
    .commitText(updateActivityBasics(resolvePresent(), patch), coalesceKey);
}

export function addActivityFileBound(): void {
  commitActivity(addActivityFile(resolvePresent()));
}
export function updateActivityFileBound(
  index: number,
  patch: Partial<ActivityFile>,
  coalesceKey: string,
): void {
  useActivityEditSession
    .getState()
    .commitText(updateActivityFile(resolvePresent(), index, patch), coalesceKey);
}
export function removeActivityFileBound(index: number): void {
  commitActivity(removeActivityFile(resolvePresent(), index));
}

export function addActivityHintBound(): void {
  commitActivity(addActivityHint(resolvePresent()));
}
export function updateActivityHintBound(index: number, value: string): void {
  useActivityEditSession
    .getState()
    .commitText(updateActivityHint(resolvePresent(), index, value), `hint:${index}`);
}
export function removeActivityHintBound(index: number): void {
  commitActivity(removeActivityHint(resolvePresent(), index));
}
export function setActivityHintsBound(hints: string[]): void {
  commitActivity(setActivityHints(resolvePresent(), hints));
}

export function addActivityTestBound(): void {
  commitActivity(addActivityTest(resolvePresent()));
}
export function updateActivityTestBound(
  index: number,
  patch: Partial<ActivityTest>,
  field: 'name' | 'code' | 'hidden' | 'id',
): void {
  useActivityEditSession
    .getState()
    .commitText(updateActivityTest(resolvePresent(), index, patch), `test:${index}:${field}`);
}
export function removeActivityTestBound(index: number): void {
  commitActivity(removeActivityTest(resolvePresent(), index));
}
export function moveActivityTestBound(index: number, delta: -1 | 1): void {
  commitActivity(moveActivityTest(resolvePresent(), index, delta));
}

export function addActivityCheckBound(type: CodeActivityCheck['type']): void {
  commitActivity(addActivityCheck(resolvePresent(), type));
}
export function updateActivityCheckBound(
  index: number,
  patch: Partial<ActivityCheck>,
  field: string,
): void {
  useActivityEditSession
    .getState()
    .commitText(updateActivityCheck(resolvePresent(), index, patch), `check:${index}:${field}`);
}
export function removeActivityCheckBound(index: number): void {
  commitActivity(removeActivityCheck(resolvePresent(), index));
}

export function addActivityReferenceFileBound(): void {
  commitActivity(addActivityReferenceFile(resolvePresent()));
}
export function updateActivityReferenceFileBound(
  index: number,
  patch: Partial<ActivityFile>,
  field: 'path' | 'content',
): void {
  useActivityEditSession
    .getState()
    .commitText(
      updateActivityReferenceFile(resolvePresent(), index, patch),
      `reference:${index}:${field}`,
    );
}
export function removeActivityReferenceFileBound(index: number): void {
  commitActivity(removeActivityReferenceFile(resolvePresent(), index));
}

// ---------------------------------------------------------------------------
// Authoring hints
// ---------------------------------------------------------------------------

const MAX_HINTS = 5;

export function buildActivityHints(
  content: ActivityContent,
  t: (key: string, options?: Record<string, unknown>) => string,
): EditorHint[] {
  const hints: EditorHint[] = [];
  const add = (id: string, severity: EditorHint['severity'], key: string) => {
    if (hints.length >= MAX_HINTS) return;
    hints.push({ id, severity, message: t(`edit.activity.hint.${key}`) });
  };

  const current = codeOrNull(content);
  if (!current) {
    add('unsupported', 'info', 'unsupportedKind');
    return hints;
  }

  if (!current.instructions.trim()) add('instructions', 'suggestion', 'emptyInstructions');
  if (!current.entryFile.trim()) add('entryFile', 'warning', 'entryMissing');
  else if (!current.files.some((file) => file.path === current.entryFile)) {
    add('entryFile', 'warning', 'entryMissing');
  }
  if (current.checks.length === 0) add('checks', 'warning', 'noChecks');
  if (current.checks.some((check) => check.type === 'expectTests') && current.tests.length === 0) {
    add('tests', 'warning', 'noTests');
  }
  if (!current.referenceFiles || current.referenceFiles.length === 0) {
    add('reference', 'suggestion', 'noReference');
  } else if (!current.referenceFiles.some((file) => file.path === current.entryFile)) {
    add('reference', 'warning', 'entryNotInReference');
  }
  if (new Set(current.tests.map((test) => test.id)).size !== current.tests.length) {
    add('duplicateTests', 'warning', 'duplicateTestIds');
  }
  if (new Set(current.checks.map((check) => check.id)).size !== current.checks.length) {
    add('duplicateChecks', 'warning', 'duplicateCheckIds');
  }
  return hints;
}

export function useResolvedActivityContent(): ActivityContent {
  const history = useActivityEditSession((state) => state.history);
  const sceneContent = useStageStore((state) => {
    const scene = state.scenes.find((item) => item.id === state.currentSceneId) ?? null;
    return scene && scene.type === 'activity' ? (scene.content as ActivityContent) : null;
  });
  return history?.present ?? sceneContent ?? EMPTY_ACTIVITY;
}

export function useActivitySurfaceState(): SurfaceState<ActivityContent, ActivitySelection> {
  const { t } = useI18n();
  const history = useActivityEditSession((state) => state.history);
  const content = useResolvedActivityContent();

  return {
    content,
    selection: undefined,
    hasSelection: false,
    history: {
      canUndo: !!history && history.past.length > 0,
      canRedo: !!history && history.future.length > 0,
      undo: () => useActivityEditSession.getState().undo(),
      redo: () => useActivityEditSession.getState().redo(),
    },
    insertItems: [],
    floatingActions: [],
    commands: [],
    hints: buildActivityHints(content, t),
  };
}

export function useActivitySurfaceLifecycle(): string {
  const sceneId = useStageStore((state) => {
    const scene = state.scenes.find((item) => item.id === state.currentSceneId) ?? null;
    return scene && scene.type === 'activity' ? scene.id : '';
  });

  useEffect(() => {
    if (!sceneId) return;
    const content = currentActivityContent(sceneId);
    if (content && useActivityEditSession.getState().sceneId !== sceneId) {
      useActivityEditSession.getState().seed(sceneId, content);
    }
  }, [sceneId]);

  useEffect(() => () => useActivityEditSession.getState().end(), []);

  return sceneId;
}
