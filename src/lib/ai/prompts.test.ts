import type { PrSize } from "@/lib/ai/budget";
import {
  CHAT_SYSTEM,
  DETAIL_STYLE_CLAUSE,
  LAYER_SCOPE_CLAUSE,
  STE_STYLE_CLAUSE,
  buildBehaviorPrompt,
  buildClaimCheckPrompt,
  buildCodebaseTourSystem,
  buildConcernCheckPrompt,
  buildGuidedSystem,
  buildLayeredSystem,
  buildRepoMapSystem,
  repoMapInput,
} from "@/lib/ai/prompts";
import type { GuidedPlan } from "@/lib/guided";
import { describe, expect, it } from "vitest";

const size: PrSize = { files: 4, churn: 120, shownFiles: 4, shownChurn: 120, coverage: 1 };
const layer = { title: "Token refresh", intent: "Adds refresh.", focus: [], index: 0, total: 3 };

describe("STE_STYLE_CLAUSE", () => {
  it("is in the guided prompt, with and without a layer", () => {
    expect(buildGuidedSystem({ steps: { min: 4, max: 8 }, size })).toContain(STE_STYLE_CLAUSE);
    expect(buildGuidedSystem({ steps: { min: 4, max: 8 }, size, layer })).toContain(
      STE_STYLE_CLAUSE,
    );
  });

  it("is in the layer planner prompt", () => {
    expect(buildLayeredSystem({ layers: { min: 2, max: 6 }, size })).toContain(STE_STYLE_CLAUSE);
  });

  it("is not in the chat or behavior prompts, which have their own register", () => {
    expect(CHAT_SYSTEM).not.toContain(STE_STYLE_CLAUSE);
    const behavior = buildBehaviorPrompt({
      path: "a.ts",
      line: 1,
      patch: "@@ -1 +1 @@",
      clone: false,
    });
    expect(behavior).not.toContain(STE_STYLE_CLAUSE);
  });

  it("comes before ## Output in the guided prompt, and the layer scope stays last", () => {
    const p = buildGuidedSystem({ steps: { min: 4, max: 8 }, size, layer });
    expect(p.indexOf(STE_STYLE_CLAUSE)).toBeLessThan(p.indexOf("## Output"));
    expect(p.endsWith(LAYER_SCOPE_CLAUSE)).toBe(true);
  });

  it("exempts the suggestion field in the guided prompt", () => {
    const p = buildGuidedSystem({ steps: { min: 4, max: 8 }, size });
    expect(p).toMatch(/Do NOT apply either style to "suggestion"/);
  });
});

describe("DETAIL_STYLE_CLAUSE", () => {
  it("governs detail in the guided prompt, in place of the strict style", () => {
    const p = buildGuidedSystem({ steps: { min: 4, max: 8 }, size });
    expect(p).toContain(DETAIL_STYLE_CLAUSE);
    expect(p).toMatch(
      /Apply this style to "summary", "tour", "verdictReason", and each step's "title"\./,
    );
    expect(p).not.toContain("at most 3 sentences");
  });

  it("allows a fact with its effect, and asks why the stop matters first", () => {
    expect(DETAIL_STYLE_CLAUSE).toContain("Up to 4 sentences");
    expect(DETAIL_STYLE_CLAUSE).toContain("cause or effect");
    expect(DETAIL_STYLE_CLAUSE).toContain("why this stop matters");
    expect(DETAIL_STYLE_CLAUSE).toContain("backticks, literal numbers, active voice, and hedges");
  });

  it("is not in the layer planner, which has no detail field", () => {
    expect(buildLayeredSystem({ layers: { min: 2, max: 6 }, size })).not.toContain(
      DETAIL_STYLE_CLAUSE,
    );
  });
});

describe("buildClaimCheckPrompt", () => {
  // A fixture tour: the check for stop 0 must see stop 0 and its patch, and
  // nothing else the tour says.
  const tour: GuidedPlan = {
    summary: "Adds a zero-quantity guard to pricing",
    tour: "Start in pricing, then the worker",
    verdict: "request_changes",
    verdictReason: "The worker drops orders silently",
    steps: [
      {
        path: "billing/price.py",
        line: 11,
        kind: "orient",
        title: "Pricing skips empty items",
        detail: "`process` skips items where `quantity <= 0`.",
      },
      {
        path: "workers/job.py",
        line: 4,
        kind: "concern",
        title: "Worker swallows failures",
        detail: "`JobWorker.run` catches every exception.",
      },
    ],
  };
  const patch = "@@ -10,2 +10,4 @@\n total = 0\n+    if item.quantity <= 0:\n+        continue";
  const s = tour.steps[0];
  const p = buildClaimCheckPrompt({ ...s, patch, clone: false });

  it("contains the patch and the step's own text", () => {
    expect(p).toContain(patch);
    expect(p).toContain(s.title);
    expect(p).toContain(s.detail);
    expect(p).toContain("billing/price.py:11");
  });

  it("contains nothing else from the tour", () => {
    expect(p).not.toContain(tour.summary);
    expect(p).not.toContain(tour.tour);
    expect(p).not.toContain(tour.verdictReason);
    expect(p).not.toContain("request_changes");
    expect(p).not.toContain(tour.steps[1].title);
    expect(p).not.toContain(tour.steps[1].detail);
  });

  it("tells the checker not to trust the explanation", () => {
    expect(p).toContain("You did not write this explanation. Do not trust it. Check it.");
  });

  it("only offers clone citations when there is a clone", () => {
    expect(p).not.toContain("read in the checkout");
    expect(buildClaimCheckPrompt({ ...s, patch, clone: true })).toContain("read in the checkout");
  });

  it("offers misplaced, and asks for a search before contradicting only with a clone", () => {
    const withClone = buildClaimCheckPrompt({ ...s, patch, clone: true });
    expect(p).toContain('"misplaced"');
    expect(withClone).toContain('"misplaced"');
    expect(withClone).toContain("search the checkout for that behavior");
    expect(p).not.toContain("search the checkout");
    expect(p).toContain('"never read"');
  });
});

describe("buildConcernCheckPrompt", () => {
  it("keeps the moved prompt's text", () => {
    const p = buildConcernCheckPrompt({
      path: "a.ts",
      line: 3,
      endLine: 5,
      kind: "concern",
      title: "T",
      detail: "D",
      suggestion: "S",
    });
    expect(p).toContain("Concern (concern) at a.ts:3-5");
    expect(p).toContain("Proposed review comment: S");
    expect(p).toContain('{"verdict":"resolved"|"valid"');
  });
});

describe("repo map prompt", () => {
  const input = repoMapInput({
    modules: [
      { id: "src/lib", lines: 900, files: ["src/lib/a.ts"], langs: ["typescript"] },
      { id: "src/routes", lines: 500, files: ["src/routes/r.tsx"], langs: ["typescript"] },
    ],
    edges: [{ from: "src/lib", to: "src/routes", count: 4 }],
    order: [["src/lib"], ["src/routes"]],
    readme: "# Reviewly\nA desktop PR review app.",
    manifests: [{ path: "package.json", text: '{"name":"reviewly"}' }],
  });

  it("includes the computed order and links", () => {
    expect(input).toContain("1. src/lib\n2. src/routes");
    expect(input).toContain("src/lib → src/routes (4 imports)");
  });

  it("includes the README and manifests and no other file contents", () => {
    expect(input).toContain("A desktop PR review app.");
    expect(input).toContain('{"name":"reviewly"}');
    // File names, not file bodies.
    expect(input).toContain("  - src/lib/a.ts");
    expect(input).not.toMatch(/import |export /);
  });

  it("caps the README and lists only 15 files per module", () => {
    const big = repoMapInput({
      modules: [
        {
          id: "m",
          lines: 1,
          files: Array.from({ length: 20 }, (_, i) => `m/f${i}.ts`),
          langs: [],
        },
      ],
      edges: [],
      order: [["m"]],
      readme: "x".repeat(10_000),
      manifests: [],
    });
    expect(big).toContain("… 5 more files");
    expect(big).not.toContain("x".repeat(4_001));
  });

  it("applies the STE clause and runs without asking for file reads", () => {
    const sys = buildRepoMapSystem({ layers: { min: 3, max: 8 }, modules: 20 });
    expect(sys).toContain(STE_STYLE_CLAUSE);
    expect(sys).toContain("You have not read the code.");
  });
});

describe("claim check on a repository file", () => {
  const p = buildClaimCheckPrompt({
    path: "src/retry.ts",
    line: 12,
    title: "Retry loop",
    detail: "`retry` loops `MAX_RETRIES` times.",
    patch: null,
    clone: true,
    file: { text: "const a = 1;\nfunction retry() {}", startLine: 11 },
  });

  it("numbers the file's lines from the excerpt's start", () => {
    expect(p).toContain("   11  const a = 1;");
    expect(p).toContain("   12  function retry() {}");
    expect(p).not.toContain("```diff");
  });

  it("keeps the distrust instruction and the step text", () => {
    expect(p).toContain("Do not trust it. Check it.");
    expect(p).toContain("`retry` loops `MAX_RETRIES` times.");
  });
});

describe("buildCodebaseTourSystem", () => {
  const p = buildCodebaseTourSystem({
    layer: {
      title: "Core",
      intent: "The data model.",
      focus: ["How a PR is stored"],
      index: 0,
      total: 4,
      modules: [{ id: "src/lib", files: ["src/lib/a.ts"] }],
    },
    map: { summary: "A desktop PR review app." },
    neighbors: { uses: [], usedBy: ["UI"] },
    steps: { min: 3, max: 6 },
  });

  it("is an onboarding tour, not a review", () => {
    expect(p).toContain("NOT a code review");
    expect(p).not.toContain('"verdict"');
    expect(p).not.toContain('"suggestion"');
    expect(p).toContain("PITFALL");
  });

  it("carries the layer, the map summary, the neighbours, the budget, and STE", () => {
    expect(p).toContain("src/lib/a.ts");
    expect(p).toContain("A desktop PR review app.");
    expect(p).toContain("Used by: UI");
    expect(p).toContain("3 to 6 stops");
    expect(p).toContain(STE_STYLE_CLAUSE);
    expect(p).toContain(DETAIL_STYLE_CLAUSE);
  });
});
