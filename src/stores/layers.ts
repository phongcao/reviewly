import type { LayerPlan } from "@/lib/layers";
import { sqlStorage } from "@/lib/sql-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";

/** A layer plan plus the metadata needed to trust and resume it. */
export interface LayersEntry {
  /** The plan as produced — reconciled against the PR's files at read time. */
  plan: LayerPlan;
  /** Head SHA the plan was made against (staleness check). */
  headSha: string;
  /** Who produced it: an AI provider id, or "structure" for the offline split. */
  source: string;
  /** Epoch ms when generated. */
  generatedAt: number;
  /** Layer id the reviewer is on. */
  active: string;
}

/** Keep at most this many plans so the persisted kv row stays bounded. */
const MAX_ENTRIES = 40;

interface State {
  /** Persisted plans keyed by `${owner}/${repo}#${number}`. */
  byPr: Record<string, LayersEntry>;
  set: (key: string, plan: LayerPlan, meta: { headSha: string; source: string }) => void;
  reset: (key: string) => void;
  setActive: (key: string, layerId: string) => void;
  /** Merge plans from an exported bundle. Newer `generatedAt` wins per PR.
   * Returns how many entries actually landed. */
  importEntries: (entries: Record<string, LayersEntry>) => number;
}

/** Drop the oldest entries once we exceed the cap. */
function evict(byPr: Record<string, LayersEntry>): Record<string, LayersEntry> {
  const keys = Object.keys(byPr);
  if (keys.length <= MAX_ENTRIES) return byPr;
  const keep = keys.sort((a, b) => byPr[b].generatedAt - byPr[a].generatedAt).slice(0, MAX_ENTRIES);
  const next: Record<string, LayersEntry> = {};
  for (const k of keep) next[k] = byPr[k];
  return next;
}

export const useLayers = create<State>()(
  persist(
    (set, get) => ({
      byPr: {},
      set: (key, plan, meta) =>
        set({
          byPr: evict({
            ...get().byPr,
            [key]: {
              plan,
              headSha: meta.headSha,
              source: meta.source,
              generatedAt: Date.now(),
              active: plan.layers[0]?.id ?? "",
            },
          }),
        }),
      reset: (key) => {
        const next = { ...get().byPr };
        delete next[key];
        set({ byPr: next });
      },
      importEntries: (entries) => {
        const cur = get().byPr;
        const next = { ...cur };
        let added = 0;
        for (const [key, entry] of Object.entries(entries)) {
          if (cur[key] && cur[key].generatedAt >= entry.generatedAt) continue;
          next[key] = entry;
          added++;
        }
        if (added > 0) set({ byPr: evict(next) });
        return added;
      },

      setActive: (key, layerId) => {
        const cur = get().byPr[key];
        if (!cur || cur.active === layerId) return;
        set({ byPr: { ...get().byPr, [key]: { ...cur, active: layerId } } });
      },
    }),
    { name: "reviewly.layers", storage: sqlStorage<State>() },
  ),
);
