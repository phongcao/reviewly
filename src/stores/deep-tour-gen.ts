import { tourKey } from "@/lib/guided";
import { invoke } from "@/lib/tauri";
import { aiInvokeArgs } from "@/stores/ai";
import { create } from "zustand";

/**
 * How many layer tours may run at once.
 *
 * Each job is an OS process spawn of an AI CLI (see `run_claude` in
 * `src-tauri/src/commands/ai.rs`), and the app may already be running a chat
 * stream or a Dependabot fix alongside. Two keeps a twelve-layer PR from
 * becoming a twelve-process fork bomb while still overlapping the wait, and
 * keeps each call comfortably inside the 180s diff-only timeout. Three is the
 * ceiling — do NOT raise this to "however many layers there are".
 */
export const DEEP_TOUR_CONCURRENCY = 2;

/** One queued layer tour. Holds a fully-built prompt, which is why this store is
 * in-memory only — prompts embed the whole diff and must never be persisted. */
export interface TourJob {
  layerId: string;
  prompt: string;
  headSha: string;
  cwd: string | null;
}

interface Progress {
  queued: TourJob[];
  /** Layer ids currently running in a Rust background task. */
  running: string[];
  errors: Record<string, string | undefined>;
}

const EMPTY: Progress = { queued: [], running: [], errors: {} };

interface State {
  byPr: Record<string, Progress>;
  /** Queue jobs and start as many as concurrency allows. */
  enqueue: (prKey: string, jobs: TourJob[]) => void;
  /** A layer finished (or failed, or was canceled); frees its slot and pumps. */
  finish: (prKey: string, layerId: string, error?: string) => void;
  /** Drop everything queued and kill everything running. */
  cancelAll: (prKey: string) => void;
  /** Re-attach to runs the backend still has in flight after a remount. */
  adopt: (prKey: string, layerIds: string[]) => void;
  clearError: (prKey: string, layerId: string) => void;
}

export const useDeepTourGen = create<State>((set, get) => {
  /** Start jobs until the concurrency budget is full. */
  function pump(prKey: string): void {
    const cur = get().byPr[prKey];
    if (!cur) return;
    if (cur.running.length >= DEEP_TOUR_CONCURRENCY || cur.queued.length === 0) return;

    const take = Math.min(DEEP_TOUR_CONCURRENCY - cur.running.length, cur.queued.length);
    const starting = cur.queued.slice(0, take);
    set((s) => ({
      byPr: {
        ...s.byPr,
        [prKey]: {
          ...cur,
          queued: cur.queued.slice(take),
          running: [...cur.running, ...starting.map((j) => j.layerId)],
        },
      },
    }));

    for (const job of starting) {
      invoke("ai_review_bg", {
        key: tourKey(prKey, job.layerId),
        ...aiInvokeArgs(),
        headSha: job.headSha,
        cwd: job.cwd,
        prompt: job.prompt,
      }).catch((e) => get().finish(prKey, job.layerId, String(e)));
    }
  }

  return {
    byPr: {},

    enqueue: (prKey, jobs) => {
      if (jobs.length === 0) return;
      const cur = get().byPr[prKey] ?? EMPTY;
      // Never double-queue a layer that is already running or waiting.
      const busy = new Set([...cur.running, ...cur.queued.map((j) => j.layerId)]);
      const fresh = jobs.filter((j) => !busy.has(j.layerId));
      if (fresh.length === 0) return;
      const errors = { ...cur.errors };
      for (const j of fresh) errors[j.layerId] = undefined;
      set((s) => ({
        byPr: {
          ...s.byPr,
          [prKey]: {
            ...cur,
            queued: [...cur.queued, ...fresh],
            errors,
          },
        },
      }));
      pump(prKey);
    },

    finish: (prKey, layerId, error) => {
      const cur = get().byPr[prKey];
      if (!cur) return;
      set((s) => ({
        byPr: {
          ...s.byPr,
          [prKey]: {
            ...cur,
            running: cur.running.filter((id) => id !== layerId),
            errors: error ? { ...cur.errors, [layerId]: error } : cur.errors,
          },
        },
      }));
      // One layer failing must not stall the rest of the queue.
      pump(prKey);
    },

    cancelAll: (prKey) => {
      const cur = get().byPr[prKey];
      if (!cur) return;
      // Clear the queue FIRST so the `ai:done {canceled:true}` each cancel emits
      // can't pump a new job into the slot it just freed.
      set((s) => ({ byPr: { ...s.byPr, [prKey]: { ...cur, queued: [] } } }));
      for (const layerId of cur.running) {
        invoke("ai_cancel", { key: tourKey(prKey, layerId) }).catch(() => {});
      }
    },

    adopt: (prKey, layerIds) => {
      if (layerIds.length === 0) return;
      const cur = get().byPr[prKey] ?? EMPTY;
      const running = [...new Set([...cur.running, ...layerIds])];
      set((s) => ({ byPr: { ...s.byPr, [prKey]: { ...cur, running } } }));
    },

    clearError: (prKey, layerId) => {
      const cur = get().byPr[prKey];
      if (!cur?.errors[layerId]) return;
      set((s) => ({
        byPr: {
          ...s.byPr,
          [prKey]: { ...cur, errors: { ...cur.errors, [layerId]: undefined } },
        },
      }));
    },
  };
});
