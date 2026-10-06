import { sqlStorage } from "@/lib/sql-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";

/** The Explain tab's sub-views: the layers, the codebase tour, and questions. */
export type ExplainView = "layers" | "tour" | "ask";

/**
 * Per-repository Explain view memory. Persisted because the tab unmounts on
 * every "Open in Code" — a reader who follows a stop into the file and comes
 * back should land on the view, layer, file, and question they left.
 */
interface RepoExplainState {
  /** Keyed `repo:owner/repo`, here and below. */
  views: Record<string, ExplainView>;
  /** The question whose answer is open in Ask. */
  openQuestion: Record<string, string>;
  /** The layer being read in Layers. */
  layer: Record<string, string>;
  /** The file open in Layers (repository-relative). */
  file: Record<string, string>;
  /**
   * A layer the reader asked to tour from Layers: the Tour view jumps to its
   * first stop once the stops are in, then clears it. Not persisted — it is a
   * request, not a place.
   */
  focusLayer: Record<string, string | undefined>;
  setView: (subject: string, view: ExplainView) => void;
  setOpenQuestion: (subject: string, id: string) => void;
  setLayer: (subject: string, layerId: string) => void;
  setFile: (subject: string, path: string) => void;
  setFocusLayer: (subject: string, layerId: string | undefined) => void;
}

export const useRepoExplain = create<RepoExplainState>()(
  persist(
    (set) => ({
      views: {},
      openQuestion: {},
      layer: {},
      file: {},
      focusLayer: {},
      setView: (subject, view) => set((s) => ({ views: { ...s.views, [subject]: view } })),
      setOpenQuestion: (subject, id) =>
        set((s) => ({ openQuestion: { ...s.openQuestion, [subject]: id } })),
      setLayer: (subject, layerId) => set((s) => ({ layer: { ...s.layer, [subject]: layerId } })),
      setFile: (subject, path) => set((s) => ({ file: { ...s.file, [subject]: path } })),
      setFocusLayer: (subject, layerId) =>
        set((s) => ({ focusLayer: { ...s.focusLayer, [subject]: layerId } })),
    }),
    {
      name: "reviewly.repo-explain",
      storage: sqlStorage<RepoExplainState>(),
      partialize: (s) =>
        ({
          views: s.views,
          openQuestion: s.openQuestion,
          layer: s.layer,
          file: s.file,
        }) as RepoExplainState,
    },
  ),
);
