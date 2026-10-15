import { identifiersToLookUp, verifyRepoStep } from "@/lib/ai/verify-repo";
import type { GuidedStep } from "@/lib/guided";
import { describe, expect, it } from "vitest";

/** 12 lines; `retry` is defined on line 5, `MAX_RETRIES` on line 1. */
const FILE = [
  "export const MAX_RETRIES = 3;", // 1
  "", // 2
  "", // 3
  "/** Retries the request. */", // 4
  "export function retry(fn: () => void) {", // 5
  "  for (let i = 0; i < MAX_RETRIES; i++) fn();", // 6
  "}", // 7
  "", // 8
  "", // 9
  "", // 10
  "", // 11
  "export const DONE = true;", // 12
  "",
].join("\n");

const step = (o: Partial<GuidedStep> = {}): GuidedStep => ({
  path: "src/retry.ts",
  line: 5,
  kind: "orient",
  title: "Retry loop",
  detail: "`retry` calls `fn` up to `MAX_RETRIES` times.",
  ...o,
});

const ctx = (known: string[] = []) => ({
  trackedPaths: new Set(["src/retry.ts", "src/other.ts"]),
  fileText: FILE,
  knownIdentifiers: new Set(known),
});

describe("verifyRepoStep", () => {
  it("is exact when every cited name is in the anchored range ±3 lines", () => {
    // `MAX_RETRIES` is on line 1 and line 6, both within 5±3.
    expect(verifyRepoStep(step(), ctx()).grade).toBe("exact");
  });

  it("uses a ±3-line window, not the whole file", () => {
    // Line 12 is 7 lines from `retry` on line 5.
    const s = step({ line: 12, detail: "`DONE` follows `retry`." });
    const e = verifyRepoStep(s, ctx());
    expect(e.grade).toBe("strong");
    expect(e.reason).toContain("retry");
    // …and line 8 is exactly 3 below line 5's `retry` definition.
    expect(verifyRepoStep(step({ line: 8, detail: "Ends `retry`." }), ctx()).grade).toBe("exact");
    expect(verifyRepoStep(step({ line: 9, detail: "Ends `retry`." }), ctx()).grade).toBe("strong");
  });

  it("is strong when a name is found only elsewhere in the repo", () => {
    const s = step({ detail: "`retry` is called by `JobRunner`." });
    expect(verifyRepoStep(s, ctx(["JobRunner"])).grade).toBe("strong");
  });

  it("is heuristic when a name exists nowhere", () => {
    const s = step({ detail: "`retry` is called by `JobRunner`." });
    const e = verifyRepoStep(s, ctx());
    expect(e.grade).toBe("heuristic");
    expect(e.ungrounded).toEqual(["JobRunner"]);
  });

  it("is heuristic when the line is past the end of the file", () => {
    const e = verifyRepoStep(step({ line: 40 }), ctx());
    expect(e.grade).toBe("heuristic");
    expect(e.reason).toContain("past the end");
  });

  it("is heuristic when the file isn't tracked", () => {
    const e = verifyRepoStep(step({ path: "src/invented.ts" }), ctx());
    expect(e.grade).toBe("heuristic");
    expect(e.reason).toContain("isn't a tracked file");
  });

  it("can't be exact when the anchored file couldn't be read", () => {
    const e = verifyRepoStep(step(), { ...ctx(["retry", "MAX_RETRIES"]), fileText: null });
    expect(e.grade).toBe("strong");
  });
});

describe("identifiersToLookUp", () => {
  it("asks only for names the anchored file doesn't contain", () => {
    const s = step({ detail: "`retry` is called by `JobRunner`." });
    expect(identifiersToLookUp(s, FILE)).toEqual(["JobRunner"]);
  });
});
