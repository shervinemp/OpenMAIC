/**
 * Module-level activity-edit session — in-memory undo/redo for the activity
 * content surface. Every committed snapshot is written through to the
 * canonical `useStageStore`, exactly like the quiz session; this store owns
 * only the undo/redo timeline of an in-progress edit.
 */
import { create } from 'zustand';
import { useStageStore } from '@/lib/store/stage';
import type { ActivityContent } from '@/lib/types/stage';
import {
  commitActivityContent,
  createActivityEditHistory,
  redoActivity,
  undoActivity,
  type ActivityEditHistory,
} from './activity-edit-ops';

interface ActivityEditSessionState {
  sceneId: string | null;
  history: ActivityEditHistory | null;
  coalesceKey: string | null;

  seed: (sceneId: string, content: ActivityContent) => void;
  commit: (next: ActivityContent) => void;
  commitText: (next: ActivityContent, coalesceKey: string) => void;
  undo: () => void;
  redo: () => void;
  end: () => void;
}

export const useActivityEditSession = create<ActivityEditSessionState>((set, get) => {
  const writeThrough = (next: ActivityContent) => {
    const { sceneId } = get();
    if (!sceneId) return;
    useStageStore.getState().updateScene(sceneId, { content: next });
  };

  const replace = (history: ActivityEditHistory) => {
    const { history: previous } = get();
    if (history === previous) return;
    writeThrough(history.present);
    set({ history, coalesceKey: null });
  };

  return {
    sceneId: null,
    history: null,
    coalesceKey: null,

    seed: (sceneId, content) => {
      set({ sceneId, history: createActivityEditHistory(content), coalesceKey: null });
    },

    commit: (next) => {
      const { history } = get();
      if (!history) return;
      replace(commitActivityContent(history, next));
    },

    commitText: (next, coalesceKey) => {
      const { history, coalesceKey: activeKey } = get();
      if (!history) return;
      if (next === history.present) return;
      writeThrough(next);
      if (activeKey === coalesceKey) {
        set({ history: { ...history, present: next, future: [] } });
      } else {
        set({ history: commitActivityContent(history, next), coalesceKey });
      }
    },

    undo: () => {
      const { history } = get();
      if (!history) return;
      replace(undoActivity(history));
    },

    redo: () => {
      const { history } = get();
      if (!history) return;
      replace(redoActivity(history));
    },

    end: () => {
      set({ sceneId: null, history: null, coalesceKey: null });
    },
  };
});
