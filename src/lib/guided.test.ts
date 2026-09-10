import { type GuidedStep, type TourLayer, groupTourStops, verdictDisplay } from "@/lib/guided";
import { describe, expect, it } from "vitest";

/**
 * These pin a safety property, not a preference: Reviewly must never pre-set a
 * reviewer's verdict to APPROVE off the back of a tour that has only read part
 * of the PR. A failure here means the app is nudging toward approving code
 * nobody has looked at.
 */
describe("verdictDisplay", () => {
  const full = { done: 12, total: 12 };
  const partial = { done: 1, total: 12 };

  it("shows nothing when the tour reached no verdict", () => {
    expect(verdictDisplay(undefined)).toEqual({ kind: "none", partial: null, seed: false });
    expect(verdictDisplay(undefined, partial)).toEqual({
      kind: "none",
      partial: null,
      seed: false,
    });
  });

  it("treats a tour with no coverage info as complete — a single-pass tour saw everything", () => {
    expect(verdictDisplay("approve")).toEqual({ kind: "verdict", partial: null, seed: true });
  });

  it("shows an unqualified verdict once every layer has landed", () => {
    for (const v of ["approve", "request_changes", "comment"] as const) {
      expect(verdictDisplay(v, full), v).toEqual({ kind: "verdict", partial: null, seed: true });
    }
  });

  it("WITHHOLDS approve while layers are still untoured, and refuses to seed it", () => {
    const d = verdictDisplay("approve", partial);
    expect(d.kind).toBe("withheld");
    expect(d.seed).toBe(false);
    expect(d.partial).toEqual(partial);
  });

  it("still trusts request_changes on partial coverage — one objecting layer is enough", () => {
    const d = verdictDisplay("request_changes", partial);
    expect(d.kind).toBe("verdict");
    expect(d.seed).toBe(true);
    // ...but says how much was read.
    expect(d.partial).toEqual(partial);
  });

  it("scopes comment the same way it scopes request_changes", () => {
    expect(verdictDisplay("comment", partial)).toEqual({
      kind: "verdict",
      partial,
      seed: true,
    });
  });

  it("approves only at full coverage, across every boundary", () => {
    expect(verdictDisplay("approve", { done: 11, total: 12 }).kind).toBe("withheld");
    expect(verdictDisplay("approve", { done: 12, total: 12 }).kind).toBe("verdict");
    // A tour that somehow overcounts must not be treated as partial.
    expect(verdictDisplay("approve", { done: 13, total: 12 }).kind).toBe("verdict");
  });

  it("never seeds a verdict it withheld", () => {
    for (const done of [0, 1, 5, 11]) {
      expect(verdictDisplay("approve", { done, total: 12 }).seed, `${done}/12`).toBe(false);
    }
  });
});

/**
 * These pin the tour rail's grouping: the rail folds a layer away by hiding one
 * group, so a group must hold exactly its layer's visible stops and remember
 * where it sits in the whole tour. Getting `start` wrong makes the spine's
 * progress fill disagree with the cursor.
 */
describe("groupTourStops", () => {
  const step = (layerId?: string): GuidedStep => ({
    path: "a.ts",
    line: 1,
    kind: "orient",
    title: "t",
    detail: "d",
    ...(layerId ? { layerId } : {}),
  });
  const layer = (id: string, index: number): TourLayer => ({
    id,
    title: id,
    index,
    total: 3,
    steps: 2,
  });
  const layers = [layer("l1", 1), layer("l2", 2), layer("l3", 3)];
  // Two stops per layer, in plan order — what `mergeDeepTour` produces.
  const steps = [step("l1"), step("l1"), step("l2"), step("l2"), step("l3"), step("l3")];
  const all = [0, 1, 2, 3, 4, 5];

  it("puts a classic tour's stops in one unlabeled, never-collapsible group", () => {
    const groups = groupTourStops(
      all,
      all.map(() => step()),
      undefined,
    );
    expect(groups).toEqual([{ layer: null, items: all, start: 0 }]);
  });

  it("returns nothing when every stop is filtered or dismissed away", () => {
    expect(groupTourStops([], steps, layers)).toEqual([]);
    expect(groupTourStops([], [], undefined)).toEqual([]);
  });

  it("splits a merged deep tour one group per layer, with global start offsets", () => {
    const groups = groupTourStops(all, steps, layers);
    expect(groups.map((g) => g.layer?.id)).toEqual(["l1", "l2", "l3"]);
    expect(groups.map((g) => g.items)).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
    ]);
    expect(groups.map((g) => g.start)).toEqual([0, 2, 4]);
  });

  it("keeps start indexing the FILTERED list when a filter empties a middle layer", () => {
    // A kind filter dropped both of l2's stops: l3 now starts at visible position 2.
    const groups = groupTourStops([0, 1, 4, 5], steps, layers);
    expect(groups.map((g) => g.layer?.id)).toEqual(["l1", "l3"]);
    expect(groups.map((g) => g.start)).toEqual([0, 2]);
  });

  it("heads a layer that a filter reduced to a single stop", () => {
    const groups = groupTourStops([1, 2, 5], steps, layers);
    expect(groups.map((g) => g.layer?.id)).toEqual(["l1", "l2", "l3"]);
    expect(groups.map((g) => g.items)).toEqual([[1], [2], [5]]);
    expect(groups.map((g) => g.start)).toEqual([0, 1, 2]);
  });

  it("merges stops with an unknown layer id into ONE unlabeled group, adding no spine break", () => {
    // A batch whose layer left the partition: no heading exists, so the rail
    // must not break between these two stops.
    const orphans = [step("gone"), step("other")];
    const groups = groupTourStops([0, 1], orphans, layers);
    expect(groups).toEqual([{ layer: null, items: [0, 1], start: 0 }]);
  });

  it("separates an unlabeled run from a labeled one", () => {
    const mixed = [step("l1"), step("gone"), step("l2")];
    const groups = groupTourStops([0, 1, 2], mixed, layers);
    expect(groups.map((g) => g.layer?.id ?? null)).toEqual(["l1", null, "l2"]);
    expect(groups.map((g) => g.start)).toEqual([0, 1, 2]);
  });
});
