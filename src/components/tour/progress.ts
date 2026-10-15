/**
 * How a tour reads and writes the reader's progress.
 *
 * The tour UI is used by surfaces whose progress is keyed differently: the
 * classic whole-PR tour stores `seen` / `dismissed` as indices into a single
 * fixed `steps` array, while a fanned-out deep tour or a codebase tour grows
 * its step list as layers land and so must key progress by a stable per-step
 * id. Rather than duplicate the tour UI, it takes plain step indices and lets
 * the caller decide what they mean.
 */
export interface TourProgress {
  /** Indices of stops the reader dismissed (hidden from the tour). */
  dismissed: Set<number>;
  /** Indices of stops the reader has already read. The rail marks these done
   * rather than inferring it from position: in a deep tour the list grows, and
   * a stop that lands ahead of the cursor has not been read just because it now
   * sits behind it. */
  seen: Set<number>;
  /** Index to resume on. */
  lastActive: number;
  markSeen: (index: number) => void;
  setLastActive: (index: number) => void;
  dismiss: (index: number) => void;
  restoreDismissed: () => void;
  /** Which layers are folded away in the tour rail. Rail-only view state, but
   * persisted alongside the rest of the reader's tour state — shrinking the
   * rail should survive navigating away. Absent on the classic whole-PR tour,
   * which has no layers to fold: its absence is what hides the controls. */
  collapse?: {
    collapsed: Set<string>;
    toggle: (layerId: string) => void;
    /** Bulk set, for collapse-all / expand-all. */
    setAll: (layerIds: string[], collapsed: boolean) => void;
  };
}

/**
 * Index-keyed progress over id-keyed storage. Index ↔ stable id is rebuilt
 * from `ids` (the merged plan's step ids, in order) — the whole point of
 * id-keyed progress: after a new layer lands, index 4 may be a different stop,
 * but the id the reader dismissed still resolves correctly.
 */
export function idKeyedProgress(
  ids: string[],
  state: {
    dismissed?: readonly string[];
    seen?: readonly string[];
    lastActiveId?: string;
    collapsedLayers?: readonly string[];
  },
  actions: {
    markSeen: (id: string) => void;
    setLastActive: (id: string) => void;
    dismiss: (id: string) => void;
    restoreDismissed: () => void;
    toggleLayerCollapsed?: (layerId: string) => void;
    setLayersCollapsed?: (layerIds: string[], collapsed: boolean) => void;
  },
): TourProgress {
  const hidden = new Set(state.dismissed ?? []);
  const read = new Set(state.seen ?? []);
  const dismissed = new Set<number>();
  const seen = new Set<number>();
  ids.forEach((id, i) => {
    if (hidden.has(id)) dismissed.add(i);
    if (read.has(id)) seen.add(i);
  });
  const resume = state.lastActiveId ? ids.indexOf(state.lastActiveId) : -1;
  const at = (fn: (id: string) => void) => (i: number) => {
    const id = ids[i];
    if (id) fn(id);
  };
  const { toggleLayerCollapsed: toggle, setLayersCollapsed: setAll } = actions;
  return {
    dismissed,
    // Read state is per stop, by stable id. Stops that land later read as new,
    // however far up the merged list their layer inserts them.
    seen,
    lastActive: resume >= 0 ? resume : 0,
    markSeen: at(actions.markSeen),
    setLastActive: at(actions.setLastActive),
    dismiss: at(actions.dismiss),
    restoreDismissed: actions.restoreDismissed,
    collapse:
      toggle && setAll
        ? { collapsed: new Set(state.collapsedLayers ?? []), toggle, setAll }
        : undefined,
  };
}
