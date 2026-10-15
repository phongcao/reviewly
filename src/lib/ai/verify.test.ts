import {
  citedIdentifiers,
  groundInClone,
  namesToLookUp,
  prCorpus,
  verifyStep,
  verifySteps,
} from "@/lib/ai/verify";
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

describe("a hoisted corpus", () => {
  // The tour pane renders every stop at once and re-verifies them together, so
  // it joins the PR's diff once and passes it in rather than letting each stop
  // rebuild it. That is only safe while the two paths grade identically.
  const withSibling = [...files, file("workers/job.py", "@@ -1,1 +1,2 @@\n+class JobWorker:")];
  const steps = [
    step(),
    step({ path: "gone.py" }),
    step({ line: 13 }),
    step({ detail: "Mirrors the check in `JobWorker`." }),
    step({ detail: "Delegates to `OrderValidator`." }),
  ];

  it("grades every stop exactly as verifying each one alone does", () => {
    const corpus = prCorpus(withSibling);
    for (const s of steps) {
      expect(verifyStep(s, withSibling, corpus)).toEqual(verifyStep(s, withSibling));
    }
  });

  it("still finds a sibling's identifier — the corpus is the whole PR, not one file", () => {
    const s = step({ detail: "Mirrors the check in `JobWorker`." });
    expect(verifyStep(s, withSibling, prCorpus(withSibling)).grade).toBe("exact");
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
    expect(citedIdentifiers("Guards against `KeyError` and `ValueError`.")).toEqual([]);
  });

  it("still catches a fabricated domain symbol", () => {
    const out = citedIdentifiers("Raises `ValidationFailure` when `Unauthorized`.");
    expect(out.sort()).toEqual(["Unauthorized", "ValidationFailure"]);
  });

  it("tokenizes expressions and ignores keywords and short tokens", () => {
    const out = citedIdentifiers(
      "`if (quantity <= 0) return null` and `db` and `ValidationFailure`",
    );
    expect(out.sort()).toEqual(["ValidationFailure", "quantity"]);
  });

  it("ignores a date-format placeholder", () => {
    expect(citedIdentifiers("Dates must match `YYYY-MM-DD` and `MMM yyyy`.")).toEqual([]);
  });

  it("reads unbackticked prose as narration, not as a claim", () => {
    expect(citedIdentifiers("This calls OrderValidator.")).toEqual([]);
  });
});

describe("groundInClone", () => {
  const named = verifyStep(step({ detail: "`.gitignore` lists `item` paths." }), files);

  it("records why a stop is unverified", () => {
    expect(named.cause).toBe("names");
    expect(verifyStep(step({ line: 400 }), files).cause).toBe("line");
    expect(verifyStep(step({ path: "gone.py" }), files).cause).toBe("file");
  });

  it("raises a stop to strong when every missing name is in the clone", () => {
    const e = groundInClone(named, new Set(["gitignore"]));
    expect(e.grade).toBe("strong");
    expect(e.inClone).toEqual(["gitignore"]);
    expect(e.reason).toContain("your local clone");
  });

  it("keeps it unverified, naming what is still missing, when only some are found", () => {
    const two = verifyStep(step({ detail: "`.gitignore` and `OrderValidator`." }), files);
    const e = groundInClone(two, new Set(["gitignore"]));
    expect(e.grade).toBe("heuristic");
    expect(e.ungrounded).toEqual(["OrderValidator"]);
    expect(e.reason).toContain("OrderValidator");
    expect(e.reason).not.toContain("gitignore");
  });

  it("never rescues a missing line or file", () => {
    const line = verifyStep(step({ line: 400, detail: "`.gitignore`" }), files);
    expect(groundInClone(line, new Set(["gitignore"]))).toBe(line);
    const file = verifyStep(step({ path: "gone.py", detail: "`.gitignore`" }), files);
    expect(groundInClone(file, new Set(["gitignore"]))).toBe(file);
  });

  it("leaves a stop alone with no clone", () => {
    expect(groundInClone(named, undefined)).toBe(named);
    expect(groundInClone(named, new Set())).toBe(named);
  });

  it("asks only for names from stops that failed on a name", () => {
    const out = namesToLookUp([
      named,
      verifyStep(step({ line: 400, detail: "`Elsewhere`" }), files),
      verifyStep(step(), files),
    ]);
    expect(out).toEqual(["gitignore"]);
  });
});
