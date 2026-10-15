import { stepId } from "@/lib/deep-tour";
import { SNIPPET_MAX, buildReviewReport, reportFilename, stepSnippet } from "@/lib/report";
import { SAMPLE_FILES, SAMPLE_INPUT, SAMPLE_STEPS } from "@/lib/report.fixture";
import type { PullFile } from "@/lib/tauri";
import { describe, expect, it } from "vitest";

describe("buildReviewReport", () => {
  const r = buildReviewReport(SAMPLE_INPUT);

  it("joins grades, checks, and trust to the right steps by stepId", () => {
    expect(r.steps.map((s) => s.id)).toEqual(SAMPLE_STEPS.map(stepId));
    expect(r.steps.map((s) => s.evidence.grade)).toEqual([
      "exact",
      "strong",
      "exact",
      "strong",
      "heuristic",
    ]);
    expect(r.steps.map((s) => s.trust)).toEqual([
      "verified",
      "contradicted",
      "verified",
      "unchecked",
      "unanchored",
    ]);
    expect(r.steps[0].check?.type).toBe("claims");
    expect(r.steps[2].check?.type).toBe("concern");
    expect(r.steps[3].check).toBeUndefined();
  });

  it("marks the tour stale when the head SHAs differ", () => {
    expect(r.tour.stale).toBe(true);
    const same = buildReviewReport({
      ...SAMPLE_INPUT,
      tour: { ...SAMPLE_INPUT.tour, headSha: SAMPLE_INPUT.pr.headSha },
    });
    expect(same.tour.stale).toBe(false);
  });

  it("keeps dismissed stops and flags them", () => {
    expect(r.steps).toHaveLength(SAMPLE_STEPS.length);
    expect(r.steps.map((s) => s.dismissed)).toEqual([false, false, false, true, false]);
  });

  it("reports pending files as pending on a partial deep tour, not unexamined", () => {
    const bucket = (p: string) => r.coverage.files.find((f) => f.path === p)?.bucket;
    expect(bucket("src/ui/cart.tsx")).toBe("pending");
    expect(bucket("src/auth/permissions.ts")).toBe("unexamined");
    expect(r.coverage.atRisk).toEqual(["src/auth/permissions.ts"]);
    expect(r.tour.layersToured).toEqual({ done: 1, total: 2 });
    expect(r.layers?.map((l) => l.toured)).toEqual([true, false]);
  });

  it("labels a deep tour's summary as the layer planner's", () => {
    expect(r.tour.summarySource).toBe("layer-planner");
    const classic = buildReviewReport({
      ...SAMPLE_INPUT,
      tour: { ...SAMPLE_INPUT.tour, type: "classic" },
    });
    expect(classic.tour.summarySource).toBe("tour");
  });

  it("grades with the clone lookup the tour pane used", () => {
    const steps = [{ ...SAMPLE_STEPS[0], detail: "`total` reads `.gitignore`." }];
    const input = { ...SAMPLE_INPUT, plan: { ...SAMPLE_INPUT.plan, steps } };
    expect(buildReviewReport(input).steps[0].evidence.grade).toBe("heuristic");
    const withClone = buildReviewReport({ ...input, cloneNames: new Set(["gitignore"]) });
    expect(withClone.steps[0].evidence.grade).toBe("strong");
  });
});

describe("stepSnippet", () => {
  const lines = Array.from({ length: 80 }, (_, i) => `+line ${i + 1}`);
  const big: PullFile[] = [
    { ...SAMPLE_FILES[0], filename: "big.ts", patch: `@@ -0,0 +1,80 @@\n${lines.join("\n")}` },
  ];

  it("includes the anchor with its diff prefix and line numbers", () => {
    const s = stepSnippet(SAMPLE_FILES, "src/billing/price.ts", 13);
    expect(s.lines).toContain("+    if (item.quantity <= 0) {");
    expect(s.lines.every((l) => /^[+\- ]/.test(l))).toBe(true);
    expect(s.numbers).toHaveLength(s.lines.length);
    expect(s.numbers[s.lines.indexOf("+    if (item.quantity <= 0) {")]).toBe(12);
    expect(s.omitted).toBe(0);
  });

  it("numbers a deleted line as null", () => {
    const s = stepSnippet(SAMPLE_FILES, "src/auth/session.ts", 2);
    expect(s.numbers[s.lines.findIndex((l) => l.startsWith("-"))]).toBeNull();
  });

  it("over the cap, keeps the head of a long range and counts the rest", () => {
    const s = stepSnippet(big, "big.ts", 20, 75);
    expect(s.lines).toHaveLength(SNIPPET_MAX);
    expect(s.lines[0]).toBe("+line 20");
    expect(s.lines.at(-1)).toBe("+line 49");
    expect(s.omitted).toBe(56 - SNIPPET_MAX);
  });

  it("over the cap, trims context rather than the range", () => {
    // 27-line range plus 4 lines of context each side: 35 rows.
    const s = stepSnippet(big, "big.ts", 20, 46);
    expect(s.lines).toHaveLength(SNIPPET_MAX);
    expect(s.lines).toContain("+line 20");
    expect(s.lines).toContain("+line 46");
    expect(s.omitted).toBe(0);
  });

  it("is empty when the anchor misses every hunk", () => {
    expect(stepSnippet(SAMPLE_FILES, "src/billing/price.ts", 900)).toEqual({
      lines: [],
      numbers: [],
      omitted: 0,
    });
  });
});

describe("buildReviewReport pr", () => {
  it("trims the PR title", () => {
    const r = buildReviewReport({
      ...SAMPLE_INPUT,
      pr: { ...SAMPLE_INPUT.pr, title: " Fix it  " },
    });
    expect(r.pr.title).toBe("Fix it");
  });
});

describe("reportFilename", () => {
  it("names the PR and the short head", () => {
    expect(reportFilename(buildReviewReport(SAMPLE_INPUT))).toBe(
      "reviewly-acme-shop-42-bbbbbbb.html",
    );
  });
});
