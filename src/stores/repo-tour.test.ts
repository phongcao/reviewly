import { useRepoTour } from "@/stores/repo-tour";
import { beforeEach, describe, expect, it } from "vitest";

const subject = "repo:o/r";
const snap = {
  map: { summary: "", strategy: "", entryPoints: [], layers: [] },
  modules: [],
  edges: [],
};
const collapsed = () => useRepoTour.getState().byRepo[subject]?.collapsedLayers;

beforeEach(() => {
  useRepoTour.setState({ byRepo: {} });
  useRepoTour.getState().begin(subject, snap, "h1");
});

describe("repo tour layer folding", () => {
  it("toggles one layer", () => {
    const s = useRepoTour.getState();
    s.toggleLayerCollapsed(subject, "l1");
    expect(collapsed()).toEqual(["l1"]);
    s.toggleLayerCollapsed(subject, "l1");
    expect(collapsed()).toEqual([]);
  });

  it("folds and unfolds in bulk, leaving the entry alone when nothing changes", () => {
    const s = useRepoTour.getState();
    s.setLayersCollapsed(subject, ["l1", "l2"], true);
    expect(collapsed()).toEqual(["l1", "l2"]);
    const before = useRepoTour.getState().byRepo[subject];
    s.setLayersCollapsed(subject, ["l1"], true);
    expect(useRepoTour.getState().byRepo[subject]).toBe(before);
    s.setLayersCollapsed(subject, ["l1", "l2"], false);
    expect(collapsed()).toEqual([]);
  });

  it("starts unfolded on a new head", () => {
    useRepoTour.getState().setLayersCollapsed(subject, ["l1"], true);
    useRepoTour.getState().begin(subject, snap, "h2");
    expect(collapsed()).toBeUndefined();
  });
});
