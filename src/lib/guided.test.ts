import { verdictDisplay } from "@/lib/guided";
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
