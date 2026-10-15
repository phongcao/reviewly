import {
  BundleError,
  type ReviewDataBundle,
  applyBundle,
  bundleStats,
  parseBundle,
} from "@/lib/review-data";
import { useDeepTour } from "@/stores/deep-tour";
import { useGuided } from "@/stores/guided";
import { useLayers } from "@/stores/layers";
import { useStepChecks } from "@/stores/step-checks";
import { useViewedFiles } from "@/stores/viewed-files";
import { beforeEach, describe, expect, it } from "vitest";

/** A minimal but structurally real deep-tour entry. */
function deepEntry(generatedAt: number, stepTitle = "look here") {
  return {
    plan: { layers: [{ id: "l1", title: "Core", intent: "", focus: [], files: ["a.ts"] }] },
    byLayer: {
      l1: {
        plan: { summary: "s", tour: "t", steps: [{ title: stepTitle, path: "a.ts" }] },
        provider: "claude",
        generatedAt,
      },
    },
    headSha: "abc123",
    generatedAt,
    dismissed: [],
  } as never;
}

function bundle(prs: ReviewDataBundle["prs"]): ReviewDataBundle {
  return { kind: "reviewly.review-data", version: 1, exportedAt: 1, app: "test", prs };
}

beforeEach(() => {
  useDeepTour.setState({ byPr: {} });
  useLayers.setState({ byPr: {} });
  useGuided.setState({ byPr: {} });
  useViewedFiles.setState({ viewed: {} });
  useStepChecks.setState({ byKey: {} });
});

describe("parseBundle", () => {
  it("rejects anything that isn't a Reviewly bundle", () => {
    expect(() => parseBundle("not json")).toThrow(BundleError);
    expect(() => parseBundle("[]")).toThrow(BundleError);
    expect(() => parseBundle(JSON.stringify({ kind: "something-else" }))).toThrow(BundleError);
  });

  it("refuses a bundle from a future Reviewly rather than half-reading it", () => {
    const raw = JSON.stringify({ ...bundle({}), version: 99 });
    expect(() => parseBundle(raw)).toThrow(/newer than this Reviewly/);
  });

  it("drops a tour missing the partition it hangs on, instead of importing a broken row", () => {
    const raw = JSON.stringify(
      bundle({
        "o/r#1": { deepTour: { headSha: "x", generatedAt: 1, byLayer: {} } as never },
        "o/r#2": { deepTour: deepEntry(2) },
      }),
    );
    const parsed = parseBundle(raw);
    expect(Object.keys(parsed.prs)).toEqual(["o/r#2"]);
  });

  it("keeps only PR-shaped keys, so `__proto__` can't swap the result's prototype", () => {
    // JSON.parse makes `__proto__` an own key; a plain object literal wouldn't.
    const raw = JSON.stringify(bundle({ "o/r#2": { deepTour: deepEntry(2) } })).replace(
      '"prs":{',
      `"prs":{"__proto__":{"deepTour":${JSON.stringify(deepEntry(3))}},"not a key":{"deepTour":${JSON.stringify(deepEntry(4))}},`,
    );
    expect(raw).toContain('"__proto__"');
    const parsed = parseBundle(raw);
    expect(Object.keys(parsed.prs)).toEqual(["o/r#2"]);
    expect(Object.getPrototypeOf(parsed.prs)).toBe(Object.prototype);
  });

  it("throws when nothing usable survives, so the UI can say why", () => {
    const raw = JSON.stringify(bundle({ "o/r#1": {} }));
    expect(() => parseBundle(raw)).toThrow(/no usable review data/);
  });
});

describe("applyBundle", () => {
  it("imports a tour into an empty store", () => {
    const r = applyBundle(bundle({ "o/r#1": { deepTour: deepEntry(100) } }));
    expect(r.deepTours).toBe(1);
    expect(useDeepTour.getState().byPr["o/r#1"].headSha).toBe("abc123");
  });

  it("never lets an older bundle undo newer local work", () => {
    applyBundle(bundle({ "o/r#1": { deepTour: deepEntry(200, "new") } }));
    const r = applyBundle(bundle({ "o/r#1": { deepTour: deepEntry(100, "old") } }));

    expect(r.deepTours).toBe(0);
    expect(r.skipped).toBe(1);
    expect(useDeepTour.getState().byPr["o/r#1"].byLayer.l1.plan.steps[0].title).toBe("new");
  });

  it("takes the bundle's copy when it is the newer one", () => {
    applyBundle(bundle({ "o/r#1": { deepTour: deepEntry(100, "old") } }));
    const r = applyBundle(bundle({ "o/r#1": { deepTour: deepEntry(200, "new") } }));

    expect(r.deepTours).toBe(1);
    expect(useDeepTour.getState().byPr["o/r#1"].byLayer.l1.plan.steps[0].title).toBe("new");
  });

  it("is idempotent — re-importing the same bundle changes nothing", () => {
    const b = bundle({ "o/r#1": { deepTour: deepEntry(100) } });
    applyBundle(b);
    const again = applyBundle(b);
    expect(again.deepTours).toBe(0);
    expect(Object.keys(useDeepTour.getState().byPr)).toHaveLength(1);
  });

  it("unions viewed marks rather than replacing them — both machines were right", () => {
    useViewedFiles.setState({ viewed: { "o/r#1@abc": { "a.ts": true } } });
    const r = applyBundle(bundle({ "o/r#1": { viewed: { "o/r#1@abc": { "b.ts": true } } } }));
    expect(r.viewedKeys).toBe(1);
    expect(useViewedFiles.getState().viewed["o/r#1@abc"]).toEqual({
      "a.ts": true,
      "b.ts": true,
    });
  });

  it("leaves unrelated PRs alone", () => {
    applyBundle(bundle({ "o/r#1": { deepTour: deepEntry(100) } }));
    applyBundle(bundle({ "o/r#2": { deepTour: deepEntry(100) } }));
    expect(Object.keys(useDeepTour.getState().byPr).sort()).toEqual(["o/r#1", "o/r#2"]);
  });
});

describe("bundleStats", () => {
  it("counts stops across layers, not just tours", () => {
    const s = bundleStats(
      bundle({
        "o/r#1": { deepTour: deepEntry(1) },
        "o/r#2": { deepTour: deepEntry(2), layers: { plan: { layers: [] } } as never },
      }),
    );
    expect(s).toMatchObject({ prs: 2, deepTours: 2, layerPlans: 1, deepStops: 2 });
  });
});

describe("checks in a bundle", () => {
  const record = (checkedAt: number) => ({
    type: "claims" as const,
    result: "supported" as const,
    claims: [{ text: "x", verdict: "supported" as const, path: "a.ts", line: 1, note: "" }],
    checkedAt,
    provider: "claude",
  });

  it("round-trips through parse and apply", () => {
    const raw = JSON.stringify(
      bundle({
        "o/r#1": {
          deepTour: deepEntry(100),
          checks: { "o/r#1@abc123": { "#a.ts:1:t": record(5) } },
        },
      }),
    );
    const parsed = parseBundle(raw);
    expect(parsed.prs["o/r#1"].checks?.["o/r#1@abc123"]["#a.ts:1:t"].checkedAt).toBe(5);
    const r = applyBundle(parsed);
    expect(r.checks).toBe(1);
    expect(useStepChecks.getState().byKey["o/r#1@abc123"]["#a.ts:1:t"]).toEqual(record(5));
  });

  it("keeps a newer local check over an older imported one", () => {
    useStepChecks.getState().set("o/r#1@abc123", "#a.ts:1:t", record(9));
    const r = applyBundle(
      bundle({ "o/r#1": { checks: { "o/r#1@abc123": { "#a.ts:1:t": record(5) } } } }),
    );
    expect(r.checks).toBe(0);
    expect(useStepChecks.getState().byKey["o/r#1@abc123"]["#a.ts:1:t"].checkedAt).toBe(9);
  });

  it("still imports a bundle written before checks existed", () => {
    const raw = JSON.stringify(bundle({ "o/r#1": { deepTour: deepEntry(100) } }));
    const r = applyBundle(parseBundle(raw));
    expect(r.deepTours).toBe(1);
    expect(r.checks).toBe(0);
  });
});
