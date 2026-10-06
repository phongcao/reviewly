import { stepId } from "@/lib/deep-tour";
import type { GuidedPlan, GuidedStep } from "@/lib/guided";
import type { RepoMap } from "@/lib/repo-map";
import {
  type MapSnapshot,
  buildRepoTourJobs,
  mergeRepoTour,
  parseRepoTourKey,
  pendingLayers,
  repoTourKey,
  repoTourPlan,
} from "@/lib/repo-tour";
import { useRepoTour } from "@/stores/repo-tour";
import { beforeEach, describe, expect, it } from "vitest";

const map: RepoMap = {
  summary: "A review app.",
  strategy: "Lib first.",
  entryPoints: [],
  layers: [
    { id: "l1", title: "Core", intent: "", focus: [], risk: "high", modules: ["src/lib"] },
    { id: "l2", title: "UI", intent: "", focus: [], risk: "low", modules: ["src/ui"] },
    { id: "l3", title: "Shell", intent: "", focus: [], risk: "low", modules: ["src-tauri"] },
  ],
};
const snap: MapSnapshot = {
  map,
  modules: [
    {
      id: "src/lib",
      dir: "src/lib",
      files: ["src/lib/a.ts"],
      lines: 3000,
      langs: [],
      hasTests: false,
    },
    {
      id: "src/ui",
      dir: "src/ui",
      files: ["src/ui/b.tsx"],
      lines: 200,
      langs: [],
      hasTests: false,
    },
    {
      id: "src-tauri",
      dir: "src-tauri",
      files: ["src-tauri/main.rs"],
      lines: 50,
      langs: [],
      hasTests: false,
    },
  ],
  edges: [{ from: "src/lib", to: "src/ui", count: 4, examples: [] }],
};

const step = (o: Partial<GuidedStep>): GuidedStep => ({
  path: "src/lib/a.ts",
  line: 1,
  kind: "orient",
  title: "t",
  detail: "d",
  ...o,
});
const batch = (steps: GuidedStep[], generatedAt = 1) => ({
  plan: { summary: "", tour: "", steps } as GuidedPlan,
  provider: "claude",
  generatedAt,
});

describe("mergeRepoTour", () => {
  it("folds layers in map order, not arrival order, and stamps layer ids", () => {
    const merged = mergeRepoTour({
      mapSnapshot: snap,
      byLayer: {
        l2: batch([step({ path: "src/ui/b.tsx", title: "UI stop" })], 1),
        l1: batch([step({ title: "Core stop" })], 2),
      },
    });
    expect(merged.steps.map((s) => [s.layerId, s.title])).toEqual([
      ["l1", "Core stop"],
      ["l2", "UI stop"],
    ]);
    expect(merged.summary).toBe("A review app.");
    expect(merged.layers?.map((l) => [l.index, l.total])).toEqual([
      [1, 3],
      [2, 3],
    ]);
  });

  it("de-duplicates by step id", () => {
    const s = step({ title: "Same" });
    const merged = mergeRepoTour({ mapSnapshot: snap, byLayer: { l1: batch([s, { ...s }]) } });
    expect(merged.steps).toHaveLength(1);
    expect(stepId(merged.steps[0])).toBe(stepId({ ...s, layerId: "l1" }));
  });

  it("reports a partial tour's untoured layers as pending", () => {
    const e = { mapSnapshot: snap, byLayer: { l1: batch([step({})]) } };
    expect(pendingLayers(e)).toEqual(["l2", "l3"]);
    expect(mergeRepoTour(e).layers).toHaveLength(1);
  });
});

describe("repoTourPlan", () => {
  it("drops verdicts and suggestions and turns praise into orientation", () => {
    const p = repoTourPlan({
      summary: "s",
      tour: "t",
      verdict: "approve",
      verdictReason: "r",
      steps: [step({ kind: "praise", suggestion: "post this" }), step({ kind: "concern" })],
    });
    expect(p.verdict).toBeUndefined();
    expect(p.steps.map((s) => s.kind)).toEqual(["orient", "concern"]);
    expect(p.steps[0].suggestion).toBeUndefined();
  });
});

describe("repo tour keys and jobs", () => {
  it("round-trips the key", () => {
    expect(parseRepoTourKey(repoTourKey("l2", "acme/shop"))).toEqual({
      layerId: "l2",
      repo: "acme/shop",
    });
    expect(parseRepoTourKey("tour:l2@acme/shop#1")).toBeNull();
  });

  it("builds one job per layer, with neighbours and a size-based budget", () => {
    const jobs = buildRepoTourJobs(snap);
    expect(jobs.map((j) => j.layerId)).toEqual(["l1", "l2", "l3"]);
    expect(jobs[0].prompt).toContain("Used by: UI");
    expect(jobs[1].prompt).toContain("This layer uses: Core");
    expect(jobs[0].prompt).toContain("src/lib/a.ts");
    expect(jobs[0].prompt).toContain("3 to 6 stops"); // 4 + 3000/1500 = 6
    expect(buildRepoTourJobs(snap, ["l3"]).map((j) => j.layerId)).toEqual(["l3"]);
  });
});

describe("useRepoTour", () => {
  beforeEach(() => useRepoTour.setState({ byRepo: {} }));

  it("keeps landed layers when resumed on the same head and layers", () => {
    const s = useRepoTour.getState();
    s.begin("repo:a/b", snap, "h1");
    s.setBatch("repo:a/b", "l1", batch([step({})]).plan, { headSha: "h1", provider: "claude" });
    s.begin("repo:a/b", snap, "h1");
    expect(Object.keys(useRepoTour.getState().byRepo["repo:a/b"].byLayer)).toEqual(["l1"]);
  });

  it("starts over on a new head, and drops a batch from a stale head", () => {
    const s = useRepoTour.getState();
    s.begin("repo:a/b", snap, "h1");
    s.setBatch("repo:a/b", "l1", batch([step({})]).plan, { headSha: "h1", provider: "claude" });
    s.begin("repo:a/b", snap, "h2");
    expect(useRepoTour.getState().byRepo["repo:a/b"].byLayer).toEqual({});
    s.setBatch("repo:a/b", "l1", batch([step({})]).plan, { headSha: "h1", provider: "claude" });
    expect(useRepoTour.getState().byRepo["repo:a/b"].byLayer).toEqual({});
  });
});
