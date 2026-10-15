import { MAX_CLAIMS } from "@/lib/ai/prompts";
import {
  type CheckRecord,
  type CheckedClaim,
  checkTypeFor,
  claimsResult,
  parseCheckResult,
  parseClaimCheck,
  stepTrust,
} from "@/lib/claim-check";
import type { PullFile } from "@/lib/tauri";
import { describe, expect, it } from "vitest";

const file = (filename: string, patch: string | null): PullFile => ({
  sha: "abc",
  filename,
  status: "modified",
  additions: 1,
  deletions: 0,
  changes: 1,
  patch,
  previous_filename: null,
});

/** New-file lines 10-13; 11 and 12 are added, 10 and 13 are context. */
const PATCH = [
  "@@ -10,2 +10,4 @@ def process(order):",
  " total = 0",
  "+    if item.quantity <= 0:",
  "+        continue",
  " return total",
].join("\n");

const files = [file("billing/price.py", PATCH)];
const ctx = { step: { path: "billing/price.py" }, files, clone: false };

const reply = (claims: unknown[]) => JSON.stringify({ claims });
/** A raw claim as the checker might send it — any field may be the wrong type. */
const claim = (o: Record<string, unknown> = {}) => ({
  text: "`quantity <= 0` items are skipped",
  verdict: "supported",
  path: "billing/price.py",
  line: 11,
  note: "line 11 shows the guard",
  ...o,
});

describe("parseClaimCheck", () => {
  it("keeps a supported claim cited inside a hunk", () => {
    const r = parseClaimCheck(reply([claim()]), ctx);
    expect(r.claims[0].verdict).toBe("supported");
    expect(r.claims[0].downgraded).toBeUndefined();
    expect(r.result).toBe("supported");
  });

  it("turns an unknown verdict into unverifiable", () => {
    const r = parseClaimCheck(reply([claim({ verdict: "probably" })]), ctx);
    expect(r.claims[0].verdict).toBe("unverifiable");
  });

  it("downgrades a supported or contradicted claim with no line", () => {
    const r = parseClaimCheck(
      reply([claim({ line: undefined }), claim({ verdict: "contradicted", line: "n/a" })]),
      ctx,
    );
    expect(r.claims.map((c) => c.verdict)).toEqual(["unverifiable", "unverifiable"]);
    expect(r.claims[0].downgraded).toMatch(/no line/);
  });

  it("downgrades a citation outside every hunk when there is no clone", () => {
    const r = parseClaimCheck(reply([claim({ line: 400 })]), ctx);
    expect(r.claims[0].verdict).toBe("unverifiable");
    expect(r.claims[0].downgraded).toContain("400");
  });

  it("downgrades a citation into a file the PR doesn't touch when there is no clone", () => {
    const r = parseClaimCheck(reply([claim({ path: "billing/other.py" })]), ctx);
    expect(r.claims[0].verdict).toBe("unverifiable");
  });

  it("accepts a citation outside the diff when a clone was available", () => {
    const r = parseClaimCheck(reply([claim({ line: 400 })]), { ...ctx, clone: true });
    expect(r.claims[0].verdict).toBe("supported");
  });

  it("keeps a misplaced claim cited where the behavior actually happens", () => {
    const r = parseClaimCheck(
      reply([claim(), claim({ verdict: "misplaced", path: "billing/api.ts", line: 427 })]),
      { ...ctx, clone: true },
    );
    expect(r.claims[1]).toMatchObject({ verdict: "misplaced", path: "billing/api.ts", line: 427 });
    expect(r.result).toBe("partial");
  });

  it("downgrades a misplaced claim with no line", () => {
    const r = parseClaimCheck(reply([claim({ verdict: "misplaced", line: undefined })]), ctx);
    expect(r.claims[0].verdict).toBe("unverifiable");
  });

  it("treats a context line as inside the hunk", () => {
    const r = parseClaimCheck(reply([claim({ line: 13 })]), ctx);
    expect(r.claims[0].verdict).toBe("supported");
  });

  it("defaults the path to the stop's file", () => {
    const r = parseClaimCheck(reply([claim({ path: undefined })]), ctx);
    expect(r.claims[0].path).toBe("billing/price.py");
    expect(r.claims[0].verdict).toBe("supported");
  });

  it("cuts more than MAX_CLAIMS claims to MAX_CLAIMS", () => {
    const r = parseClaimCheck(reply(Array.from({ length: 11 }, () => claim())), ctx);
    expect(r.claims).toHaveLength(MAX_CLAIMS);
  });

  it("accepts zero claims as a valid result", () => {
    const r = parseClaimCheck(reply([]), ctx);
    expect(r.claims).toEqual([]);
    expect(r.result).toBe("partial");
    expect(r.unparsed).toBeUndefined();
  });

  it("reads a fenced, chatty reply", () => {
    const r = parseClaimCheck(`Here you go:\n\`\`\`json\n${reply([claim()])}\n\`\`\``, ctx);
    expect(r.result).toBe("supported");
  });

  it("never returns supported for junk", () => {
    for (const junk of [
      "I could not check this.",
      "{not json",
      '{"claims":"yes"}',
      reply([{ verdict: "supported" }]),
      reply([claim({ verdict: 1 })]),
      reply([null, 3, "x"]),
    ]) {
      const r = parseClaimCheck(junk, ctx);
      expect(r.result).not.toBe("supported");
      expect(r.claims.every((c) => c.verdict !== "supported")).toBe(true);
    }
    expect(parseClaimCheck("no json here", ctx).unparsed).toBe(true);
  });
});

describe("claimsResult", () => {
  const c = (verdict: CheckedClaim["verdict"]): CheckedClaim => ({ text: "x", verdict, note: "" });
  it("is contradicted when any claim is contradicted", () => {
    expect(claimsResult([c("supported"), c("contradicted")])).toBe("contradicted");
  });
  it("is supported only when every claim is supported and there is one", () => {
    expect(claimsResult([c("supported"), c("supported")])).toBe("supported");
    expect(claimsResult([])).toBe("partial");
  });
  it("is partial when some claims are unverifiable", () => {
    expect(claimsResult([c("supported"), c("unverifiable")])).toBe("partial");
  });
  it("is partial, not contradicted, when a claim is only misplaced", () => {
    expect(claimsResult([c("supported"), c("misplaced")])).toBe("partial");
  });
});

describe("stepTrust", () => {
  const claims = (result: "supported" | "contradicted" | "partial"): CheckRecord => ({
    type: "claims",
    result,
    claims: [],
    checkedAt: 1,
    provider: "claude",
  });
  const concern = (verdict: "resolved" | "valid"): CheckRecord => ({
    type: "concern",
    verdict,
    finding: "",
    checkedAt: 1,
    provider: "claude",
  });

  it.each([
    ["heuristic", undefined, "unanchored"],
    ["heuristic", claims("supported"), "unanchored"],
    ["heuristic", claims("contradicted"), "unanchored"],
    ["heuristic", concern("valid"), "unanchored"],
    ["exact", undefined, "unchecked"],
    ["strong", undefined, "unchecked"],
    ["exact", claims("supported"), "verified"],
    ["strong", claims("supported"), "verified"],
    ["exact", claims("contradicted"), "contradicted"],
    ["strong", claims("contradicted"), "contradicted"],
    ["exact", claims("partial"), "unchecked"],
    ["strong", claims("partial"), "unchecked"],
    ["exact", concern("valid"), "verified"],
    ["strong", concern("valid"), "verified"],
    ["exact", concern("resolved"), "contradicted"],
    ["strong", concern("resolved"), "contradicted"],
  ] as const)("%s + %o → %s", (grade, check, want) => {
    expect(stepTrust(grade, check)).toBe(want);
  });
});

describe("checkTypeFor", () => {
  it("sends concerns and questions to the concern check, the rest to claims", () => {
    expect(checkTypeFor("concern")).toBe("concern");
    expect(checkTypeFor("question")).toBe("concern");
    expect(checkTypeFor("orient")).toBe("claims");
    expect(checkTypeFor("praise")).toBe("claims");
  });
});

describe("parseCheckResult", () => {
  it("never auto-dismisses on ambiguity", () => {
    expect(parseCheckResult("hmm").verdict).toBe("valid");
    expect(parseCheckResult('{"verdict":"maybe"}').verdict).toBe("valid");
    expect(parseCheckResult('{"verdict":"resolved","finding":"handled"}')).toEqual({
      verdict: "resolved",
      finding: "handled",
    });
  });
});

describe("parseClaimCheck — repository file variant", () => {
  const repoCtx = {
    step: { path: "src/retry.ts" },
    files: [],
    clone: true,
    repoFile: { path: "src/retry.ts", lines: 40 },
  };
  const c = (o: Record<string, unknown>) => ({
    text: "`retry` loops",
    verdict: "supported",
    path: "src/retry.ts",
    line: 12,
    note: "",
    ...o,
  });

  it("accepts a line the file has, with no diff at all", () => {
    expect(parseClaimCheck(reply([c({})]), repoCtx).claims[0].verdict).toBe("supported");
  });

  it("downgrades a line past the end of the anchored file", () => {
    const r = parseClaimCheck(reply([c({ line: 41 })]), repoCtx);
    expect(r.claims[0].verdict).toBe("unverifiable");
    expect(r.claims[0].downgraded).toContain("past the end");
  });

  it("takes a cite into another file on trust, since the checker ran in the clone", () => {
    expect(
      parseClaimCheck(reply([c({ path: "src/other.ts", line: 999 })]), repoCtx).claims[0].verdict,
    ).toBe("supported");
  });
});
