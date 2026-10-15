import { parseSynthesis } from "@/lib/ai/deep-synthesis";
import { STE_STYLE_CLAUSE, buildDeepSummarySystem } from "@/lib/ai/prompts";
import {
  SYNTH_KEY_PREFIX,
  allLayersToured,
  deepSummaryInput,
  mergeDeepTour,
  parseSynthKey,
  synthKey,
  synthesisBasis,
  synthesisFresh,
} from "@/lib/deep-tour";
import { TOUR_KEY_PREFIX } from "@/lib/guided";
import { LAYERS_KEY_PREFIX } from "@/lib/layers";
import type { PullFile } from "@/lib/tauri";
import type { DeepTourEntry } from "@/stores/deep-tour";
import { describe, expect, it } from "vitest";

const PATCH = "@@ -1,1 +1,2 @@\n const a = 1;\n+const SECRET_PATCH_LINE = 2;";
const file = (filename: string): PullFile => ({
  sha: "x",
  filename,
  status: "modified",
  additions: 1,
  deletions: 0,
  changes: 1,
  patch: PATCH,
  previous_filename: null,
});
const files = [file("a.ts"), file("b.ts")];

const entry = (o: Partial<DeepTourEntry> = {}): DeepTourEntry => ({
  plan: {
    summary: "Planner sentence from the file list.",
    strategy: "Core first.",
    layers: [
      { id: "l1", title: "Core", intent: "The model.", focus: [], risk: "high", files: ["a.ts"] },
      { id: "l2", title: "UI", intent: "The view.", focus: [], risk: "low", files: ["b.ts"] },
    ],
  },
  byLayer: {
    l1: {
      plan: {
        summary: "Core adds `SECRET_PATCH_LINE`.",
        tour: "",
        verdict: "request_changes",
        verdictReason: "The constant is unused.",
        steps: [
          { path: "a.ts", line: 2, kind: "concern", title: "Unused constant", detail: "d" },
          { path: "a.ts", line: 2, kind: "orient", title: "Orient title", detail: "d" },
        ],
      },
      provider: "claude",
      generatedAt: 10,
    },
    l2: {
      plan: { summary: "UI is unchanged.", tour: "", verdict: "approve", steps: [] },
      provider: "claude",
      generatedAt: 20,
    },
  },
  headSha: "h1",
  generatedAt: 1,
  dismissed: [],
  ...o,
});

describe("deep summary prompt", () => {
  const input = deepSummaryInput(entry());

  it("carries each layer's summary, verdict, reason, and concern titles", () => {
    expect(input).toContain("Core adds `SECRET_PATCH_LINE`.");
    expect(input).toContain("UI is unchanged.");
    expect(input).toContain("Verdict: request_changes");
    expect(input).toContain("The constant is unused.");
    expect(input).toContain("- Unused constant");
    expect(input).toContain("# Combined verdict\nrequest_changes");
  });

  it("carries no patch text and no non-concern stops", () => {
    expect(input).not.toContain("const a = 1");
    expect(input).not.toContain("+const");
    expect(input).not.toContain("Orient title");
  });

  it("applies the STE clause and forbids new facts", () => {
    const sys = buildDeepSummarySystem();
    expect(sys).toContain(STE_STYLE_CLAUSE);
    expect(sys).toContain("Add no new facts");
  });
});

describe("mergeDeepTour with a synthesis", () => {
  const e = entry();
  const synth = {
    summary: "Synthesized sentence.",
    verdictReason: "Core blocks: the constant is unused.",
    headSha: "h1",
    generatedAt: 30,
    basis: synthesisBasis(e.byLayer),
  };

  it("prefers a synthesis that matches the head and the batches", () => {
    const m = mergeDeepTour({ ...e, synthesis: synth }, files);
    expect(m.summary).toBe("Synthesized sentence.");
    expect(m.verdictReason).toBe("Core blocks: the constant is unused.");
    expect(m.verdict).toBe("request_changes");
  });

  it("ignores a synthesis from another head", () => {
    const m = mergeDeepTour({ ...e, synthesis: { ...synth, headSha: "h0" } }, files);
    expect(m.summary).toBe("Planner sentence from the file list.");
  });

  it("ignores a synthesis written before a layer was regenerated", () => {
    const regenerated = {
      ...e.byLayer,
      l2: { ...e.byLayer.l2, generatedAt: 99 },
    };
    expect(synthesisFresh({ ...e, byLayer: regenerated, synthesis: synth })).toBeNull();
    const m = mergeDeepTour({ ...e, byLayer: regenerated, synthesis: synth }, files);
    expect(m.summary).toBe("Planner sentence from the file list.");
  });

  it("uses the planner sentence when there is no synthesis", () => {
    expect(mergeDeepTour(e, files).summary).toBe("Planner sentence from the file list.");
  });
});

describe("synthesis keys and readiness", () => {
  it("round-trips and stays disjoint from the other namespaces", () => {
    expect(parseSynthKey(synthKey("o/r#1"))).toBe("o/r#1");
    expect(parseSynthKey("o/r#1")).toBeNull();
    for (const p of [TOUR_KEY_PREFIX, LAYERS_KEY_PREFIX]) {
      expect(SYNTH_KEY_PREFIX.startsWith(p) || p.startsWith(SYNTH_KEY_PREFIX)).toBe(false);
    }
  });

  it("is ready only when every layer has landed", () => {
    expect(allLayersToured(entry())).toBe(true);
    const { l2: _, ...partial } = entry().byLayer;
    expect(allLayersToured(entry({ byLayer: partial }))).toBe(false);
  });

  it("parses a reply and rejects one with no summary", () => {
    expect(parseSynthesis('```json\n{"summary":"S.","verdictReason":"R."}\n```')).toEqual({
      summary: "S.",
      verdictReason: "R.",
    });
    expect(parseSynthesis("sorry")).toBeNull();
  });
});
