import {
  EMPTY_HISTORY,
  canGoBack,
  canGoForward,
  currentLocation,
  goBack,
  goForward,
  pushLocation,
  rankPaths,
  sameLocation,
} from "@/lib/review-context";
import { describe, expect, it } from "vitest";

const at = (path: string, line?: number) => ({ path, line });
const open = (...locs: { path: string; line?: number }[]) =>
  locs.reduce(pushLocation, EMPTY_HISTORY);

describe("context history", () => {
  it("starts empty and reports nothing in view", () => {
    expect(currentLocation(EMPTY_HISTORY)).toBeNull();
    expect(canGoBack(EMPTY_HISTORY)).toBe(false);
    expect(canGoForward(EMPTY_HISTORY)).toBe(false);
  });

  it("walks back and forward across opened locations", () => {
    const h = open(at("a.ts"), at("b.ts"), at("c.ts"));
    expect(currentLocation(h)).toEqual(at("c.ts"));

    const back1 = goBack(h);
    expect(currentLocation(back1)).toEqual(at("b.ts"));
    const back2 = goBack(back1);
    expect(currentLocation(back2)).toEqual(at("a.ts"));

    expect(currentLocation(goForward(back2))).toEqual(at("b.ts"));
  });

  it("stops at the ends instead of wrapping", () => {
    const h = open(at("a.ts"));
    expect(goBack(h)).toBe(h);
    expect(goForward(h)).toBe(h);
  });

  it("discards the forward entries once you navigate somewhere new", () => {
    const h = goBack(open(at("a.ts"), at("b.ts"), at("c.ts")));
    expect(canGoForward(h)).toBe(true);

    const next = pushLocation(h, at("d.ts"));
    expect(next.entries.map((e) => e.path)).toEqual(["a.ts", "b.ts", "d.ts"]);
    expect(canGoForward(next)).toBe(false);
  });

  it("treats re-opening what is already in view as a no-op", () => {
    const h = open(at("a.ts"), at("b.ts"));
    expect(pushLocation(h, at("b.ts"))).toBe(h);
  });

  it("distinguishes the same file at a different line", () => {
    const h = open(at("a.ts", 10), at("a.ts", 99));
    expect(h.entries).toHaveLength(2);
    expect(currentLocation(goBack(h))).toEqual(at("a.ts", 10));
  });

  it("bounds the stack, keeping the most recent entries", () => {
    let h = EMPTY_HISTORY;
    for (let i = 0; i < 60; i++) h = pushLocation(h, at(`f${i}.ts`));

    expect(h.entries).toHaveLength(50);
    expect(currentLocation(h)).toEqual(at("f59.ts"));
    expect(h.entries[0]).toEqual(at("f10.ts"));
    expect(h.index).toBe(49);
  });

  it("compares locations by path and line", () => {
    expect(sameLocation(at("a.ts"), at("a.ts"))).toBe(true);
    expect(sameLocation(at("a.ts", 1), at("a.ts"))).toBe(false);
    expect(sameLocation(null, null)).toBe(true);
    expect(sameLocation(at("a.ts"), null)).toBe(false);
  });
});

describe("rankPaths", () => {
  // Chosen to hit all three tiers for the query "focus":
  //   basename prefix > basename substring > directory-only match.
  const paths = [
    "src/focus/mode.ts", // directory only
    "src/lib/use-focus.ts", // basename substring
    "src/lib/focus.ts", // basename prefix
    "src/lib/layers.ts", // no match
  ];

  it("ranks basename-prefix, then basename-substring, then path", () => {
    expect(rankPaths(paths, "focus")).toEqual([
      "src/lib/focus.ts",
      "src/lib/use-focus.ts",
      "src/focus/mode.ts",
    ]);
  });

  it("keeps input order within a tier", () => {
    const same = ["b/focus.ts", "a/focus.ts"];
    expect(rankPaths(same, "focus")).toEqual(["b/focus.ts", "a/focus.ts"]);
  });

  it("is case-insensitive and ignores surrounding space", () => {
    expect(rankPaths(paths, "  LAYERS ")).toEqual(["src/lib/layers.ts"]);
  });

  it("returns the head of the list when the query is empty", () => {
    expect(rankPaths(paths, "", 2)).toEqual(paths.slice(0, 2));
  });

  it("honours the limit", () => {
    expect(rankPaths(paths, "s", 2)).toHaveLength(2);
  });

  it("returns nothing when there is no match", () => {
    expect(rankPaths(paths, "zzzz")).toEqual([]);
  });
});
