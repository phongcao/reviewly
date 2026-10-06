import type { LayerEdge } from "@/lib/layer-edges";
import type { RepoMap } from "@/lib/repo-map";
import type { RepoModule } from "@/lib/repo-modules";
import { sqlStorage } from "@/lib/sql-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";

/** A codebase map for one repository, pinned to the commit it was made on. */
export interface RepoMapEntry {
  map: RepoMap;
  modules: RepoModule[];
  edges: LayerEdge[];
  order: string[][];
  skipped: { files: number; lines: number };
  /** `HEAD` when the structure was computed. */
  headSha: string;
  generatedAt: number;
  /** An `AiProvider` id, or `"heuristic"` for the offline map. */
  provider: string;
}

/** Keep at most this many maps — each holds every module's file list. */
const MAX_ENTRIES = 20;

function evict(byRepo: Record<string, RepoMapEntry>): Record<string, RepoMapEntry> {
  const keys = Object.keys(byRepo);
  if (keys.length <= MAX_ENTRIES) return byRepo;
  const keep = keys
    .sort((a, b) => byRepo[b].generatedAt - byRepo[a].generatedAt)
    .slice(0, MAX_ENTRIES);
  const next: Record<string, RepoMapEntry> = {};
  for (const k of keep) next[k] = byRepo[k];
  return next;
}

interface State {
  /** Keyed `repo:owner/repo` (`repoSubject`). */
  byRepo: Record<string, RepoMapEntry>;
  set: (subject: string, entry: RepoMapEntry) => void;
  /** Swap in a planned map, keeping the computed structure. Dropped when the
   * entry has moved to another head since the plan was asked for. */
  setMap: (subject: string, map: RepoMap, meta: { headSha: string; provider: string }) => void;
  reset: (subject: string) => void;
}

export const useRepoMap = create<State>()(
  persist(
    (set, get) => ({
      byRepo: {},
      set: (subject, entry) => set({ byRepo: evict({ ...get().byRepo, [subject]: entry }) }),
      setMap: (subject, map, meta) => {
        const cur = get().byRepo[subject];
        if (!cur || (meta.headSha && cur.headSha !== meta.headSha)) return;
        set({
          byRepo: {
            ...get().byRepo,
            [subject]: { ...cur, map, provider: meta.provider, generatedAt: Date.now() },
          },
        });
      },
      reset: (subject) => {
        const next = { ...get().byRepo };
        delete next[subject];
        set({ byRepo: next });
      },
    }),
    { name: "reviewly.repo-map", storage: sqlStorage<State>() },
  ),
);

/** In-memory run state for map planning, keyed by subject. */
interface GenState {
  inFlight: Record<string, boolean>;
  error: Record<string, string | undefined>;
  start: (subject: string) => void;
  done: (subject: string) => void;
  fail: (subject: string, message: string) => void;
}

export const useRepoMapGen = create<GenState>((set) => ({
  inFlight: {},
  error: {},
  start: (k) =>
    set((s) => ({ inFlight: { ...s.inFlight, [k]: true }, error: { ...s.error, [k]: undefined } })),
  done: (k) => set((s) => ({ inFlight: { ...s.inFlight, [k]: false } })),
  fail: (k, message) =>
    set((s) => ({ inFlight: { ...s.inFlight, [k]: false }, error: { ...s.error, [k]: message } })),
}));
