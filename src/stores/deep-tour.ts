import type { GuidedPlan } from "@/lib/guided";
import type { LayerPlan } from "@/lib/layers";
import { sqlStorage } from "@/lib/sql-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";

/** One layer's own tour, as returned by its own AI call. */
export interface TourBatch {
  plan: GuidedPlan;
  /** Which AI produced it ("claude" | "codex"). */
  provider: string;
  /** Epoch ms when generated. */
  generatedAt: number;
}

/**
 * A deep tour: one tour per layer, merged for display by `mergeDeepTour`.
 *
 * Batches are stored per layer rather than as one flat step list so a single
 * layer can be regenerated without disturbing the others, and so a tour that is
 * still filling in is indistinguishable from a finished one that lost a layer.
 */
export interface DeepTourEntry {
  /** The layer partition this tour was built on, snapshotted when it started.
   * Batches are keyed by layer id, and the two sources of layers use disjoint
   * id schemes (`heuristicLayers` uses bucket names, an AI plan uses `l1`…), so
   * reading against a partition the tour wasn't built on would orphan every
   * batch. The tour owns its own partition and reconciles it against the PR's
   * current files at read time. */
  plan: LayerPlan;
  /** layerId → that layer's tour. Absent keys are layers not yet landed. */
  byLayer: Record<string, TourBatch>;
  /** Head SHA the batches were generated against (staleness check). */
  headSha: string;
  /** Epoch ms of the first batch. */
  generatedAt: number;
  /** Dismissed stops, by STABLE step id — see `stepId`. Never by index: the
   * step list grows as layers land, so indices would re-point at other stops. */
  dismissed: string[];
  /** Stops the reviewer has visited, by the same stable step id. A deep tour
   * needs this far more than the classic tour does: its list keeps growing, so
   * "everything before where I am" is not a usable stand-in for "what I've
   * read" — a layer landing ahead of the cursor would inherit the checkmarks of
   * stops the reviewer never saw. Optional so tours persisted before this
   * existed load as "nothing read yet" rather than crashing. */
  seen?: string[];
  /** Step id to resume on. */
  lastActiveId?: string;
  /** Layer ids folded away in the tour rail. View state, but persisted here
   * because it is per PR exactly like the layers it names — a reviewer who
   * shrank the rail down to the layer they're working in should find it that
   * way on the way back. Optional so tours persisted before this existed load
   * as "all expanded", which is also the default. Same reasoning as `seen`. */
  collapsedLayers?: string[];
  /** A layer the reviewer explicitly asked to read ("Tour this layer" / "Read
   * tour" in the layered view). The tour jumps to its first stop as soon as the
   * batch is in, then clears this — it's a one-shot intent, not a selection. */
  focusLayerId?: string;
}

/** Keep at most this many deep tours so the persisted kv row stays bounded.
 * Lower than the classic tour's 40 — a deep tour holds every layer's steps. */
const MAX_ENTRIES = 20;

interface State {
  byPr: Record<string, DeepTourEntry>;
  /** Start (or restart) a deep tour against a layer partition. Called when the
   * jobs are queued, so the partition is persisted before any batch lands. */
  begin: (key: string, plan: LayerPlan, headSha: string) => void;
  setBatch: (
    key: string,
    layerId: string,
    plan: GuidedPlan,
    meta: { headSha: string; provider: string },
  ) => void;
  /** Forget one layer's batch, so it can be regenerated. */
  dropLayer: (key: string, layerId: string) => void;
  reset: (key: string) => void;
  /** Put a whole entry back — the Undo side of `reset`. Batches that were in
   * flight when the tour was discarded are gone for good (their AI runs were
   * canceled); this restores what had already landed. */
  restore: (key: string, entry: DeepTourEntry) => void;
  dismiss: (key: string, stepId: string) => void;
  restoreDismissed: (key: string) => void;
  markSeen: (key: string, stepId: string) => void;
  setLastActive: (key: string, stepId: string) => void;
  /** Fold / unfold one layer's stops in the tour rail. */
  toggleLayerCollapsed: (key: string, layerId: string) => void;
  /** Fold / unfold the given layers at once — collapse-all / expand-all. */
  setLayersCollapsed: (key: string, layerIds: string[], collapsed: boolean) => void;
  /** Ask the tour to jump to this layer once it has landed. */
  focusLayer: (key: string, layerId: string) => void;
  /** The jump happened (or the layer went away) — drop the request. */
  clearFocus: (key: string) => void;
}

/** Drop the oldest entries once we exceed the cap. */
function evict(byPr: Record<string, DeepTourEntry>): Record<string, DeepTourEntry> {
  const keys = Object.keys(byPr);
  if (keys.length <= MAX_ENTRIES) return byPr;
  const ordered = keys.sort((a, b) => byPr[b].generatedAt - byPr[a].generatedAt);
  const next: Record<string, DeepTourEntry> = {};
  for (const k of ordered.slice(0, MAX_ENTRIES)) next[k] = byPr[k];
  return next;
}

export const useDeepTour = create<State>()(
  persist(
    (set, get) => ({
      byPr: {},

      begin: (key, plan, headSha) => {
        const cur = get().byPr[key];
        // Keep what's already toured when this is the same run resumed: same
        // head, same partition. Anything else describes a different diff or a
        // different slicing, and merging the two would be nonsense.
        const samePartition =
          cur &&
          cur.headSha === headSha &&
          cur.plan.layers.length === plan.layers.length &&
          cur.plan.layers.every((l, i) => l.id === plan.layers[i].id);
        if (samePartition) {
          set({ byPr: { ...get().byPr, [key]: { ...cur, plan } } });
          return;
        }
        set({
          byPr: evict({
            ...get().byPr,
            [key]: {
              plan,
              byLayer: {},
              headSha,
              generatedAt: Date.now(),
              dismissed: [],
              seen: [],
              collapsedLayers: [],
            },
          }),
        });
      },

      setBatch: (key, layerId, plan, meta) => {
        const cur = get().byPr[key];
        // No partition means no place to put this batch — the tour was reset or
        // restarted while this layer was still in flight. Drop it rather than
        // inventing an entry the merge couldn't read.
        if (!cur) return;
        if (meta.headSha && cur.headSha && meta.headSha !== cur.headSha) return;
        set({
          byPr: {
            ...get().byPr,
            [key]: {
              ...cur,
              byLayer: {
                ...cur.byLayer,
                [layerId]: { plan, provider: meta.provider, generatedAt: Date.now() },
              },
            },
          },
        });
      },

      dropLayer: (key, layerId) => {
        const cur = get().byPr[key];
        if (!cur?.byLayer[layerId]) return;
        const byLayer = { ...cur.byLayer };
        delete byLayer[layerId];
        set({ byPr: { ...get().byPr, [key]: { ...cur, byLayer } } });
      },

      reset: (key) => {
        const next = { ...get().byPr };
        delete next[key];
        set({ byPr: next });
      },

      restore: (key, entry) => {
        set({ byPr: evict({ ...get().byPr, [key]: entry }) });
      },

      dismiss: (key, stepId) => {
        const cur = get().byPr[key];
        if (!cur || cur.dismissed.includes(stepId)) return;
        set({ byPr: { ...get().byPr, [key]: { ...cur, dismissed: [...cur.dismissed, stepId] } } });
      },

      restoreDismissed: (key) => {
        const cur = get().byPr[key];
        if (!cur || cur.dismissed.length === 0) return;
        set({ byPr: { ...get().byPr, [key]: { ...cur, dismissed: [] } } });
      },

      markSeen: (key, stepId) => {
        const cur = get().byPr[key];
        if (!cur || (cur.seen ?? []).includes(stepId)) return;
        set({ byPr: { ...get().byPr, [key]: { ...cur, seen: [...(cur.seen ?? []), stepId] } } });
      },

      toggleLayerCollapsed: (key, layerId) => {
        const cur = get().byPr[key];
        if (!cur) return;
        const now = cur.collapsedLayers ?? [];
        const next = now.includes(layerId) ? now.filter((id) => id !== layerId) : [...now, layerId];
        set({ byPr: { ...get().byPr, [key]: { ...cur, collapsedLayers: next } } });
      },

      setLayersCollapsed: (key, layerIds, collapsed) => {
        const cur = get().byPr[key];
        if (!cur) return;
        const now = cur.collapsedLayers ?? [];
        const next = collapsed
          ? [...new Set([...now, ...layerIds])]
          : now.filter((id) => !layerIds.includes(id));
        // Collapse-all with everything already folded (or expand-all with
        // nothing folded) is a no-op — don't rewrite the persisted row, and
        // don't hand the tour a fresh progress object for nothing.
        if (next.length === now.length && next.every((id, i) => id === now[i])) return;
        set({ byPr: { ...get().byPr, [key]: { ...cur, collapsedLayers: next } } });
      },

      focusLayer: (key, layerId) => {
        const cur = get().byPr[key];
        if (!cur || cur.focusLayerId === layerId) return;
        set({ byPr: { ...get().byPr, [key]: { ...cur, focusLayerId: layerId } } });
      },

      clearFocus: (key) => {
        const cur = get().byPr[key];
        if (!cur?.focusLayerId) return;
        const { focusLayerId: _, ...rest } = cur;
        set({ byPr: { ...get().byPr, [key]: rest } });
      },

      setLastActive: (key, stepId) => {
        const cur = get().byPr[key];
        if (!cur || cur.lastActiveId === stepId) return;
        set({ byPr: { ...get().byPr, [key]: { ...cur, lastActiveId: stepId } } });
      },
    }),
    { name: "reviewly.deep-tour", storage: sqlStorage<State>() },
  ),
);
