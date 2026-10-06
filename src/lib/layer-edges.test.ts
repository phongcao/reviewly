import {
  type EdgePlan,
  layerEdges,
  layerMermaid,
  mermaidLabel,
  orderViolations,
  patchText,
} from "@/lib/layer-edges";
import { describe, expect, it } from "vitest";

const plan: EdgePlan = {
  layers: [
    { id: "types", title: "Types", risk: "low", files: ["src/types.ts"] },
    { id: "logic", title: "Logic", risk: "high", files: ["src/logic.ts", "src/logic2.ts"] },
    { id: "ui", title: "UI", risk: "medium", files: ["src/ui.tsx"] },
  ],
};

const texts = new Map([
  ["src/types.ts", "export type T = 1;"],
  ["src/logic.ts", 'import type { T } from "./types";\nimport { b } from "./logic2";'],
  [
    "src/logic2.ts",
    'import type { T } from "@/types";\nimport x from "./types";\nimport y from "react";',
  ],
  [
    "src/ui.tsx",
    'import { a } from "./logic";\nimport { b } from "./logic2";\nimport { t } from "./types";',
  ],
]);

describe("layerEdges", () => {
  const edges = layerEdges(plan, texts);

  it("points from the imported layer to the importing one, with counts", () => {
    expect(edges.map((e) => [e.from, e.to, e.count])).toEqual([
      ["types", "logic", 3],
      ["types", "ui", 1],
      ["logic", "ui", 2],
    ]);
  });

  it("drops self-edges", () => {
    expect(edges.some((e) => e.from === e.to)).toBe(false);
  });

  it("keeps at most 3 examples per edge", () => {
    const many = new Map([
      ["src/types.ts", ""],
      [
        "src/ui.tsx",
        Array.from({ length: 6 }, (_, i) => `import a${i} from "./logic";`).join("\n"),
      ],
      ["src/logic.ts", 'import "./types";'],
    ]);
    const e = layerEdges(plan, many).find((x) => x.from === "logic" && x.to === "ui");
    expect(e?.count).toBe(1); // one spec, deduplicated by extractImports
    const fan = new Map([
      ["src/types.ts", ""],
      [
        "src/ui.tsx",
        'import a from "./logic";\nimport b from "./logic.ts";\nimport c from "./logic2";\nimport d from "./logic2.ts";',
      ],
    ]);
    const f = layerEdges(plan, fan).find((x) => x.from === "logic" && x.to === "ui");
    expect(f?.count).toBe(4);
    expect(f?.examples).toHaveLength(3);
  });
});

describe("orderViolations", () => {
  it("flags a foundation read after its consumer", () => {
    const misordered: EdgePlan = { layers: [plan.layers[2], plan.layers[1], plan.layers[0]] };
    const edges = layerEdges(misordered, texts);
    expect(orderViolations(misordered, edges).map((e) => [e.from, e.to])).toEqual([
      ["logic", "ui"],
      ["types", "ui"],
      ["types", "logic"],
    ]);
    expect(orderViolations(plan, layerEdges(plan, texts))).toEqual([]);
  });
});

describe("layerMermaid", () => {
  it("escapes quotes and keeps an arrow in a title inside its label", () => {
    const tricky: EdgePlan = {
      layers: [
        { id: "a", title: 'Say "hi" --> now\nplease', risk: "high", files: [] },
        { id: "end", title: "End", risk: "low", files: [] },
      ],
    };
    const m = layerMermaid(tricky, [{ from: "a", to: "end", count: 2, examples: [] }]);
    expect(m).toContain('L_a["1. Say &quot;hi&quot; --&gt; now please"]');
    expect(m).toContain("L_a -->|2| L_end");
    expect(m).toContain("class L_a high");
    expect(m.startsWith("flowchart TD")).toBe(true);
    expect(mermaidLabel('a"b<c>')).toBe("a&quot;b&lt;c&gt;");
  });
});

describe("patchText", () => {
  it("keeps context and added lines, drops removed lines and headers", () => {
    const p =
      '@@ -1,2 +1,2 @@\n import a from "./a";\n-import b from "./b";\n+import c from "./c";';
    expect(patchText(p)).toBe('import a from "./a";\nimport c from "./c";');
  });
});
