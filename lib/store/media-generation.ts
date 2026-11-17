/**
 * Media Generation Store
 *
 * Tracks per-element media generation status (pending → generating → done/failed).
 * Drives skeleton loading in slide renderer components.
 *
 * The task table is in-memory only. Durable media lives in IndexedDB and is
 * restored by the classroom loader (`lib/classroom/load-classroom.ts`), which
 * can defer blob materialization until a scene is near the viewport.
 */

import { create } from 'zustand';
import type { MediaGenerationRequest } from '@/lib/media/types';

// ==================== Types ====================

export type MediaTaskStatus = 'pending' | 'generating' | 'done' | 'failed';

export interface MediaTask {
  elementId: string;
  /** Original generation placeholder retained after the task is re-keyed to an allocated id. */
  placeholderRef?: string;
  type: 'image' | 'video';
  status: MediaTaskStatus;
  prompt: string;
  params: {
    aspectRatio?: string;
    style?: string;
    duration?: number;
  };
  objectUrl?: string; // URL.createObjectURL() for rendering
  poster?: string; // Video poster objectUrl
  posterAssetId?: string; // Allocated poster identity used by late scene reconciliation
  error?: string;
  errorCode?: string; // Structured error code (e.g. 'CONTENT_SENSITIVE')
  retryCount: number;
  stageId: string;
}

interface MediaGenerationState {
  tasks: Record<string, MediaTask>;

  // Batch enqueue
  enqueueTasks: (stageId: string, requests: MediaGenerationRequest[]) => void;

  // Status transitions
  markGenerating: (elementId: string) => void;
  markDone: (elementId: string, objectUrl: string, poster?: string) => void;
  rekeyDone: (
    oldRef: string,
    newRef: string,
    objectUrl: string,
    poster?: string,
    posterAssetId?: string,
  ) => void;
  markFailed: (elementId: string, error: string, errorCode?: string) => void;

  // Retry support
  markPendingForRetry: (elementId: string) => void;

  // Queries
  getTask: (elementId: string) => MediaTask | undefined;
  isReady: (elementId: string) => boolean;

  // Cleanup
  clearStage: (stageId: string) => void;
  revokeObjectUrls: () => void;
}

// ==================== Helper ====================

const CONCRETE_URL = /^(https?:|data:|blob:|\/|\.\.?\/)/i;

/** Check whether a media reference still needs resolution before rendering. */
export function isMediaPlaceholder(src: string): boolean {
  return !!src && !CONCRETE_URL.test(src);
}

/**
 * Release a URL this store minted, and nothing else.
 *
 * `objectUrl` is usually a blob URL, but a restored task can carry a durable
 * hosted URL (`ossKey`) instead. Revoking one of those would be a no-op today;
 * the guard keeps that an accident rather than a relied-upon behaviour.
 */
function revokeBlobUrl(url: string | undefined): void {
  if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
}

// ==================== Store ====================

export const useMediaGenerationStore = create<MediaGenerationState>()((set, get) => ({
  tasks: {},

  enqueueTasks: (stageId, requests) => {
    const newTasks: Record<string, MediaTask> = {};
    for (const req of requests) {
      // Skip if already tracked
      if (get().tasks[req.elementId]) continue;
      newTasks[req.elementId] = {
        elementId: req.elementId,
        type: req.type,
        status: 'pending',
        prompt: req.prompt,
        params: {
          aspectRatio: req.aspectRatio,
          style: req.style,
        },
        retryCount: 0,
        stageId,
      };
    }
    if (Object.keys(newTasks).length > 0) {
      set((s) => ({ tasks: { ...s.tasks, ...newTasks } }));
    }
  },

  markGenerating: (elementId) =>
    set((s) => {
      const task = s.tasks[elementId];
      if (!task) return s;
      return {
        tasks: { ...s.tasks, [elementId]: { ...task, status: 'generating' } },
      };
    }),

  markDone: (elementId, objectUrl, poster) =>
    set((s) => {
      const task = s.tasks[elementId];
      if (!task) return s;
      return {
        tasks: {
          ...s.tasks,
          [elementId]: {
            ...task,
            status: 'done',
            objectUrl,
            poster,
            error: undefined,
          },
        },
      };
    }),

  rekeyDone: (oldRef, newRef, objectUrl, poster, posterAssetId) => {
    // URLs a dropped task leaves behind are unreachable from the task table
    // afterwards, so collect them inside the update and release them after it.
    const orphaned: string[] = [];
    set((s) => {
      const task = s.tasks[oldRef];
      if (!task) return s;
      const tasks = { ...s.tasks };
      delete tasks[oldRef];
      // Identical requests share one stored asset, so two placeholders can
      // re-key onto the same id. Keep the task already there: its object URL
      // names the same bytes, and the first slot's placeholder reference is
      // still the one late reconciliation looks up. Overwriting it would also
      // put a URL this entry does not own in front of a slot that does.
      //
      // The incoming URLs were minted for a task this update discards, so they
      // are orphaned too -- whether the task was already displaying them (the
      // held path) or had not been given them yet (the immediate path). A
      // duplicate video easily pins tens of megabytes that way.
      const existing = Object.hasOwn(tasks, newRef) ? tasks[newRef] : undefined;
      if (existing?.status === 'done') {
        const kept = new Set([existing.objectUrl, existing.poster]);
        for (const url of [objectUrl, poster, task.objectUrl, task.poster]) {
          if (url && !kept.has(url)) orphaned.push(url);
        }
        return { tasks };
      }
      tasks[newRef] = {
        ...task,
        elementId: newRef,
        placeholderRef: task.placeholderRef ?? oldRef,
        status: 'done',
        objectUrl,
        poster,
        posterAssetId,
        error: undefined,
        errorCode: undefined,
      };
      return { tasks };
    });
    for (const url of new Set(orphaned)) revokeBlobUrl(url);
  },

  markFailed: (elementId, error, errorCode) =>
    set((s) => {
      const task = s.tasks[elementId];
      if (!task) return s;
      return {
        tasks: {
          ...s.tasks,
          [elementId]: { ...task, status: 'failed', error, errorCode },
        },
      };
    }),

  markPendingForRetry: (elementId) =>
    set((s) => {
      const task = s.tasks[elementId];
      if (!task) return s;
      return {
        tasks: {
          ...s.tasks,
          [elementId]: {
            ...task,
            status: 'pending',
            error: undefined,
            errorCode: undefined,
            retryCount: task.retryCount + 1,
          },
        },
      };
    }),

  getTask: (elementId) => get().tasks[elementId],

  isReady: (elementId) => get().tasks[elementId]?.status === 'done',

  clearStage: (stageId) =>
    set((s) => {
      const remaining: Record<string, MediaTask> = {};
      for (const [id, task] of Object.entries(s.tasks)) {
        if (task.stageId !== stageId) {
          remaining[id] = task;
        } else if (task.objectUrl) {
          URL.revokeObjectURL(task.objectUrl);
          if (task.poster) URL.revokeObjectURL(task.poster);
        }
      }
      return { tasks: remaining };
    }),

  revokeObjectUrls: () => {
    const tasks = get().tasks;
    for (const task of Object.values(tasks)) {
      if (task.objectUrl) URL.revokeObjectURL(task.objectUrl);
      if (task.poster) URL.revokeObjectURL(task.poster);
    }
  },
}));
