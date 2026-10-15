import type { GuidedPlan } from "@/lib/guided";
import type { MapSnapshot, RepoTourBatch } from "@/lib/repo-tour";
import { repoTourKey } from "@/lib/repo-tour";
import { sqlStorage } from "@/lib/sql-storage";
import { invoke } from "@/lib/tauri";
import { aiInvokeArgs } from "@/stores/ai";
import { create } from "zustand";
import { persist } from "zustand/middleware";

/** A codebase tour, keyed by stable step id like a deep tour. */
export interface RepoTourEntry {
  mapSnapshot: MapSnapshot;
  byLayer: Record<string, RepoTourBatch>;
  headSha: string;
  generatedAt: number;
  seen: string[];
  dismissed: string[];
  lastActiveId?: string;
  /** Layers folded away in the tour rail. */
  collapsedLayers?: string[];
}

const MAX_ENTRIES = 20;

function evict(by: Record<string, RepoTourEntry>): Record<string, RepoTourEntry> {
  const keys = Object.keys(by);
  if (keys.length <= MAX_ENTRIES) return by;
  const keep = keys.sort((a, b) => by[b].generatedAt - by[a].generatedAt).slice(0, MAX_ENTRIES);
  const next: Record<string, RepoTourEntry> = {};
  for (const k of keep) next[k] = by[k];
  return next;
}

interface State {
  /** Keyed `repo:owner/repo`. */
  byRepo: Record<string, RepoTourEntry>;
  /** Start or resume a tour on a map. The same head and the same layer ids
   * keep what has landed; anything else starts over. */
  begin: (subject: string, snap: MapSnapshot, headSha: string) => void;
  setBatch: (
    subject: string,
    layerId: string,
    plan: GuidedPlan,
    meta: { headSha: string; provider: string },
  ) => void;
  dropLayer: (subject: string, layerId: string) => void;
  reset: (subject: string) => void;
  dismiss: (subject: string, stepId: string) => void;
  restoreDismissed: (subject: string) => void;
  markSeen: (subject: string, stepId: string) => void;
  setLastActive: (subject: string, stepId: string) => void;
  toggleLayerCollapsed: (subject: string, layerId: string) => void;
  setLayersCollapsed: (subject: string, layerIds: string[], collapsed: boolean) => void;
}

export const useRepoTour = create<State>()(
  persist(
    (set, get) => {
      const patch = (subject: string, fn: (e: RepoTourEntry) => RepoTourEntry | null) => {
        const cur = get().byRepo[subject];
        if (!cur) return;
        const next = fn(cur);
        if (next && next !== cur) set({ byRepo: { ...get().byRepo, [subject]: next } });
      };
      return {
        byRepo: {},
        begin: (subject, snap, headSha) => {
          const cur = get().byRepo[subject];
          const same =
            cur &&
            cur.headSha === headSha &&
            cur.mapSnapshot.map.layers.length === snap.map.layers.length &&
            cur.mapSnapshot.map.layers.every((l, i) => l.id === snap.map.layers[i].id);
          if (same) {
            set({ byRepo: { ...get().byRepo, [subject]: { ...cur, mapSnapshot: snap } } });
            return;
          }
          set({
            byRepo: evict({
              ...get().byRepo,
              [subject]: {
                mapSnapshot: snap,
                byLayer: {},
                headSha,
                generatedAt: Date.now(),
                seen: [],
                dismissed: [],
              },
            }),
          });
        },
        setBatch: (subject, layerId, plan, meta) =>
          patch(subject, (cur) =>
            meta.headSha && cur.headSha !== meta.headSha
              ? null
              : {
                  ...cur,
                  byLayer: {
                    ...cur.byLayer,
                    [layerId]: { plan, provider: meta.provider, generatedAt: Date.now() },
                  },
                },
          ),
        dropLayer: (subject, layerId) =>
          patch(subject, (cur) => {
            if (!cur.byLayer[layerId]) return null;
            const byLayer = { ...cur.byLayer };
            delete byLayer[layerId];
            return { ...cur, byLayer };
          }),
        reset: (subject) => {
          const next = { ...get().byRepo };
          delete next[subject];
          set({ byRepo: next });
        },
        dismiss: (subject, id) =>
          patch(subject, (cur) =>
            cur.dismissed.includes(id) ? null : { ...cur, dismissed: [...cur.dismissed, id] },
          ),
        restoreDismissed: (subject) =>
          patch(subject, (cur) => (cur.dismissed.length ? { ...cur, dismissed: [] } : null)),
        markSeen: (subject, id) =>
          patch(subject, (cur) =>
            cur.seen.includes(id) ? null : { ...cur, seen: [...cur.seen, id] },
          ),
        setLastActive: (subject, id) =>
          patch(subject, (cur) => (cur.lastActiveId === id ? null : { ...cur, lastActiveId: id })),
        toggleLayerCollapsed: (subject, layerId) =>
          patch(subject, (cur) => {
            const now = cur.collapsedLayers ?? [];
            const next = now.includes(layerId)
              ? now.filter((id) => id !== layerId)
              : [...now, layerId];
            return { ...cur, collapsedLayers: next };
          }),
        setLayersCollapsed: (subject, layerIds, collapsed) =>
          patch(subject, (cur) => {
            const now = cur.collapsedLayers ?? [];
            const next = collapsed
              ? [...new Set([...now, ...layerIds])]
              : now.filter((id) => !layerIds.includes(id));
            // Nothing to fold or unfold: keep the row, and the tour's progress
            // object, as they are.
            if (next.length === now.length && next.every((id, i) => id === now[i])) return null;
            return { ...cur, collapsedLayers: next };
          }),
      };
    },
    { name: "reviewly.repo-tour", storage: sqlStorage<State>() },
  ),
);

/** Same budget as a deep tour, for the same reason: each job is an AI CLI
 * process, run inside the clone. */
export const REPO_TOUR_CONCURRENCY = 2;

interface Job {
  layerId: string;
  prompt: string;
  headSha: string;
  cwd: string;
}

interface Progress {
  queued: Job[];
  running: string[];
  errors: Record<string, string | undefined>;
}

interface GenState {
  /** Keyed `owner/repo` (the part after `repo:`). */
  byRepo: Record<string, Progress>;
  enqueue: (repo: string, jobs: Job[]) => void;
  finish: (repo: string, layerId: string, error?: string) => void;
  cancelAll: (repo: string) => void;
  adopt: (repo: string, layerIds: string[]) => void;
}

/** In-memory run queue for codebase tours — prompts are never persisted. */
export const useRepoTourGen = create<GenState>((set, get) => {
  function pump(repo: string): void {
    const cur = get().byRepo[repo];
    if (!cur || cur.running.length >= REPO_TOUR_CONCURRENCY || cur.queued.length === 0) return;
    const take = Math.min(REPO_TOUR_CONCURRENCY - cur.running.length, cur.queued.length);
    const starting = cur.queued.slice(0, take);
    set((s) => ({
      byRepo: {
        ...s.byRepo,
        [repo]: {
          ...cur,
          queued: cur.queued.slice(take),
          running: [...cur.running, ...starting.map((j) => j.layerId)],
        },
      },
    }));
    for (const job of starting) {
      invoke("ai_review_bg", {
        key: repoTourKey(job.layerId, repo),
        ...aiInvokeArgs(),
        headSha: job.headSha,
        cwd: job.cwd,
        prompt: job.prompt,
      }).catch((e) => get().finish(repo, job.layerId, String(e)));
    }
  }
  return {
    byRepo: {},
    enqueue: (repo, jobs) => {
      const cur = get().byRepo[repo] ?? { queued: [], running: [], errors: {} };
      const busy = new Set([...cur.running, ...cur.queued.map((j) => j.layerId)]);
      const fresh = jobs.filter((j) => !busy.has(j.layerId));
      if (fresh.length === 0) return;
      const errors = { ...cur.errors };
      for (const j of fresh) errors[j.layerId] = undefined;
      set((s) => ({
        byRepo: { ...s.byRepo, [repo]: { ...cur, queued: [...cur.queued, ...fresh], errors } },
      }));
      pump(repo);
    },
    finish: (repo, layerId, error) => {
      const cur = get().byRepo[repo];
      if (!cur) return;
      set((s) => ({
        byRepo: {
          ...s.byRepo,
          [repo]: {
            ...cur,
            running: cur.running.filter((id) => id !== layerId),
            errors: error ? { ...cur.errors, [layerId]: error } : cur.errors,
          },
        },
      }));
      pump(repo);
    },
    cancelAll: (repo) => {
      const cur = get().byRepo[repo];
      if (!cur) return;
      set((s) => ({ byRepo: { ...s.byRepo, [repo]: { ...cur, queued: [] } } }));
      for (const id of cur.running)
        invoke("ai_cancel", { key: repoTourKey(id, repo) }).catch(() => {});
    },
    adopt: (repo, layerIds) => {
      if (layerIds.length === 0) return;
      const cur = get().byRepo[repo] ?? { queued: [], running: [], errors: {} };
      set((s) => ({
        byRepo: {
          ...s.byRepo,
          [repo]: { ...cur, running: [...new Set([...cur.running, ...layerIds])] },
        },
      }));
    },
  };
});
