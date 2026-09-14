'use client';

import { create } from 'zustand';

/**
 * The generic repair-progress channel ("umbrella").
 *
 * ANY repair dispatcher — narration regeneration, image/video requeue,
 * whatever asset class grows later — reports through ONE store instead of
 * owning bespoke UI state. The sidebar dock renders one card per ACTIVE
 * repair from this single list; a dispatcher only has to begin/update/end,
 * and it becomes visible with zero UI coupling.
 *
 * IDs are per-dispatcher-run (e.g. `drain-<nonce>`), so concurrent repair
 * classes render their own cards and a class that hot-loops through repair
 * passes never collides with a previous pass's leftovers.
 */

export type RepairKind = 'narration' | 'media';

export interface RepairProgressEntry {
  kind: RepairKind;
  /** Units known up front (dead clips / missing media tasks). */
  total: number;
  /** Units concluded this run so far (restored, re-queued, or settled). */
  done: number;
}

interface RepairProgressStore {
  repairs: Record<string, RepairProgressEntry>;
  begin: (id: string, kind: RepairKind, total: number) => void;
  /** Functional update; no-ops when the id is already gone (ended twice). */
  update: (id: string, updater: (entry: RepairProgressEntry) => RepairProgressEntry) => void;
  end: (id: string) => void;
}

export const useRepairProgressStore = create<RepairProgressStore>((set) => ({
  repairs: {},
  begin: (id, kind, total) =>
    set((state) => ({ repairs: { ...state.repairs, [id]: { kind, total, done: 0 } } })),
  update: (id, updater) =>
    set((state) => {
      const entry = state.repairs[id];
      if (!entry) return state;
      return { repairs: { ...state.repairs, [id]: updater(entry) } };
    }),
  end: (id) =>
    set((state) => {
      const { [id]: _removed, ...rest } = state.repairs;
      return { repairs: rest };
    }),
}));

/** Active repairs, most-recently-started last, for dock rendering. */
export function useActiveRepairProgress(): Array<{ id: string } & RepairProgressEntry> {
  return useRepairProgressStore((state) =>
    Object.entries(state.repairs).map(([id, entry]) => ({ id, ...entry })),
  );
}

/** One shared-batched reporter factory so dispatchers speak to a single API. */
export interface RepairProgressReporter {
  begin: (total: number) => void;
  done: (count?: number) => void;
  /** Detach the run's card (drains, aborts, and completions all end here). */
  end: () => void;
}

export function createRepairProgressReporter(kind: RepairKind): RepairProgressReporter {
  const runId = `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const begin = (total: number): void => useRepairProgressStore.getState().begin(runId, kind, total);
  const done = (count = 1): void =>
    useRepairProgressStore
      .getState()
      .update(runId, (entry) => ({ ...entry, done: Math.min(entry.total, entry.done + count) }));
  const end = (): void => useRepairProgressStore.getState().end(runId);
  return { begin, done, end };
}
