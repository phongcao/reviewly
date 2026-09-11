import { citedIdentifiers, verifyStep, verifySteps } from "@/lib/ai/verify";
import type { GuidedStep } from "@/lib/guided";
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

const step = (o: Partial<GuidedStep> = {}): GuidedStep => ({
  path: "billing/price.py",
  line: 11,
  kind: "concern",
  title: "Zero-quantity items skipped",
  detail: "The new guard drops items.",
  ...o,
});

const files = [file("billing/price.py", PATCH)];

describe("verifyStep", () => {
  it("grades a stop anchored to an added line as exact", () => {
    const e = verifyStep(step(), files);
    expect(e.grade).toBe("exact");
    expect(e.reason).toBeUndefined();
  });

  it("downgrades — never hides — a stop naming a file the PR never touches", () => {
    const e = verifyStep(step({ path: "billing/invented.py" }), files);
    expect(e.grade).toBe("heuristic");
    expect(e.reason).toContain("billing/invented.py");
  });

  it("downgrades a stop whose line misses every hunk", () => {
    const e = verifyStep(step({ line: 400 }), files);
    expect(e.grade).toBe("heuristic");
    expect(e.reason).toContain("400");
  });

  it("downgrades a stop naming an identifier that is nowhere in the diff", () => {
    const e = verifyStep(step({ detail: "This calls `OrderValidator` before summing." }), files);
    expect(e.grade).toBe("heuristic");
    expect(e.ungrounded).toEqual(["OrderValidator"]);
    expect(e.reason).toContain("OrderValidator");
  });

  it("accepts an identifier quoted from the cited range", () => {
    const s = step({ detail: "Items where `item.quantity <= 0` are skipped." });
    expect(verifyStep(s, files).grade).toBe("exact");
  });

  it("accepts an identifier grounded in a sibling file's diff", () => {
    const s = step({ detail: "Mirrors the check in `JobWorker`." });
    const withSibling = [...files, file("workers/job.py", "@@ -1,1 +1,2 @@\n+class JobWorker:")];
    expect(verifyStep(s, withSibling).grade).toBe("exact");
    // …and is still a fabrication when that sibling isn't in the PR.
    expect(verifyStep(s, files).grade).toBe("heuristic");
  });

  it("grades a context-only anchor as strong, not exact", () => {
    const e = verifyStep(step({ line: 13, detail: "Returns the total." }), files);
    expect(e.grade).toBe("strong");
    expect(e.reason).toContain("context");
  });

  it("covers a multi-line range that reaches an added line", () => {
    expect(verifyStep(step({ line: 10, endLine: 12 }), files).grade).toBe("exact");
  });

  it("tolerates a case-only path miss", () => {
    expect(verifyStep(step({ path: "Billing/Price.py" }), files).grade).toBe("exact");
  });

  it("treats a file with no patch as unanchorable rather than absent", () => {
    const binary = [file("assets/logo.png", null)];
    const e = verifyStep(step({ path: "assets/logo.png" }), binary);
    expect(e.grade).toBe("heuristic");
    expect(e.reason).not.toContain("isn't among");
  });
});

describe("verifySteps", () => {
  it("grades every stop and keeps all of them", () => {
    const out = verifySteps([step(), step({ path: "gone.py" }), step({ line: 13 })], files);
    expect(out).toHaveLength(3);
    expect(out.map((v) => v.evidence.grade)).toEqual(["exact", "heuristic", "strong"]);
    expect(out[1].step.path).toBe("gone.py");
  });
});

describe("citedIdentifiers", () => {
  it("ignores built-in error types a summary names generically", () => {
    const s = step({ detail: "Guards against `KeyError` and `ValueError`." });
    expect(citedIdentifiers(s)).toEqual([]);
  });

  it("still catches a fabricated domain symbol", () => {
    const s = step({ detail: "Raises `ValidationFailure` when `Unauthorized`." });
    expect(citedIdentifiers(s).sort()).toEqual(["Unauthorized", "ValidationFailure"]);
  });

  it("tokenizes expressions and ignores keywords and short tokens", () => {
    const s = step({
      title: "Guard",
      detail: "`if (quantity <= 0) return null` and `db` and `ValidationFailure`",
    });
    expect(citedIdentifiers(s).sort()).toEqual(["ValidationFailure", "quantity"]);
  });

  it("reads unbackticked prose as narration, not as a claim", () => {
    expect(citedIdentifiers(step({ detail: "This calls OrderValidator." }))).toEqual([]);
  });

  it("checks the suggestion body too", () => {
    const s = step({ detail: "", suggestion: "Consider renaming `calculate_price`." });
    expect(citedIdentifiers(s)).toEqual(["calculate_price"]);
  });
});
