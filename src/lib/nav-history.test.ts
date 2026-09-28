import { describe, expect, it } from "vitest";
import { NAV_CAP, type NavEntry, emptyNav, navKey, recordNav, stepNav } from "./nav-history";

const tour: NavEntry = { view: "guided", file: null };
const file = (f: string, view: NavEntry["view"] = "unified"): NavEntry => ({ view, file: f });

function visit(...entries: NavEntry[]) {
  return entries.reduce(recordNav, emptyNav("pr"));
}

describe("navKey", () => {
  it("treats the tour as one place whatever file is open", () => {
    expect(navKey({ view: "guided", file: "a.ts" })).toBe(navKey(tour));
  });
  it("treats unified and split on one file as one place", () => {
    expect(navKey(file("a.ts", "split"))).toBe(navKey(file("a.ts")));
  });
});

describe("recordNav", () => {
  it("appends visits and points at the newest", () => {
    const s = visit(tour, file("a.ts"), file("b.ts"));
    expect(s.entries.map(navKey)).toEqual(["guided", "file:a.ts", "file:b.ts"]);
    expect(s.index).toBe(2);
  });

  it("collapses a repeat of the current place, keeping its latest layout", () => {
    const s = visit(file("a.ts"), file("a.ts", "split"));
    expect(s.entries).toEqual([file("a.ts", "split")]);
  });

  it("drops forward history when a new place is visited after going back", () => {
    const back = stepNav(visit(tour, file("a.ts"), file("b.ts")), -2);
    if (!back) throw new Error("expected to go back");
    const s = recordNav(back, file("c.ts"));
    expect(s.entries.map(navKey)).toEqual(["guided", "file:c.ts"]);
    expect(s.index).toBe(1);
  });

  it("keeps only the newest entries past the cap", () => {
    const many = Array.from({ length: NAV_CAP + 5 }, (_, i) => file(`f${i}.ts`));
    const s = visit(...many);
    expect(s.entries).toHaveLength(NAV_CAP);
    expect(s.entries[0]).toEqual(file("f5.ts"));
    expect(s.index).toBe(NAV_CAP - 1);
  });
});

describe("stepNav", () => {
  it("moves within bounds and refuses past either end", () => {
    const s = visit(tour, file("a.ts"));
    expect(stepNav(s, 1)).toBeNull();
    const back = stepNav(s, -1);
    expect(back?.index).toBe(0);
    if (!back) return;
    expect(stepNav(back, -1)).toBeNull();
    expect(stepNav(back, 1)?.index).toBe(1);
  });
});
