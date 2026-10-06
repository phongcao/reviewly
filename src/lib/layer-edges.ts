/**
 * Import links between the layers of a plan.
 *
 * A layer plan is an ordered list, and a diagram drawn from it alone is a
 * straight line of boxes that says nothing the list doesn't. The links here
 * are computed — no model call — from the imports in each layer's files, so
 * the diagram shows which layer actually builds on which, and the reading
 * order can be checked against it.
 */
import { type Aliases, defaultAliases, extractImports, resolveImport } from "@/lib/imports";
import type { LayerRisk } from "@/lib/layers";

/** Imports from one layer into another. `from` is the layer of the IMPORTED
 * file (the foundation), `to` the layer of the file that imports it. */
export interface LayerEdge {
  from: string;
  to: string;
  count: number;
  /** At most 3, for the UI and the report. */
  examples: { file: string; spec: string }[];
}

/** The fields edges and diagrams need from a plan — a PR's `LayerPlan`, or a
 * repository map whose layers hold modules rather than files. */
export interface EdgePlan {
  layers: { id: string; title: string; risk: LayerRisk; files: string[] }[];
}

const MAX_EXAMPLES = 3;

/**
 * Edges between the plan's layers, from the imports in `texts` (path → text).
 * A file missing from `texts` contributes nothing; a self-edge (a layer
 * importing itself) is dropped, since it says nothing about order.
 */
export function layerEdges(
  plan: EdgePlan,
  texts: ReadonlyMap<string, string>,
  aliases?: Aliases,
): LayerEdge[] {
  const layerOf = new Map<string, string>();
  for (const l of plan.layers) for (const f of l.files) layerOf.set(f, l.id);
  const known = new Set(layerOf.keys());
  const alias = aliases ?? defaultAliases(known);

  const edges = new Map<string, LayerEdge>();
  for (const layer of plan.layers) {
    for (const file of layer.files) {
      const text = texts.get(file);
      if (!text) continue;
      for (const spec of extractImports(file, text)) {
        const target = resolveImport(file, spec, known, alias);
        const from = target ? layerOf.get(target) : undefined;
        if (!from || from === layer.id) continue;
        const key = `${from}\u0000${layer.id}`;
        let e = edges.get(key);
        if (!e) {
          e = { from, to: layer.id, count: 0, examples: [] };
          edges.set(key, e);
        }
        e.count++;
        if (e.examples.length < MAX_EXAMPLES) e.examples.push({ file, spec });
      }
    }
  }
  // Stable: plan order of the consumer, then of the foundation.
  const pos = new Map(plan.layers.map((l, i) => [l.id, i]));
  return [...edges.values()].sort(
    (a, b) =>
      (pos.get(a.to) ?? 0) - (pos.get(b.to) ?? 0) ||
      (pos.get(a.from) ?? 0) - (pos.get(b.from) ?? 0),
  );
}

/** Edges whose foundation is read AFTER its consumer — the reader meets a
 * name before the layer that defines it. Advisory: the planner's order may be
 * deliberate, so nothing is reordered. */
export function orderViolations(plan: EdgePlan, edges: LayerEdge[]): LayerEdge[] {
  const pos = new Map(plan.layers.map((l, i) => [l.id, i]));
  return edges.filter((e) => (pos.get(e.from) ?? -1) > (pos.get(e.to) ?? -1));
}

/** A mermaid node id for a layer. Prefixed and restricted so an id like
 * `end` (a mermaid keyword) or one with punctuation can't break the chart. */
const nodeId = (id: string): string => `L_${id.replace(/[^A-Za-z0-9_]/g, "_")}`;

/**
 * A layer title as a mermaid label: newlines removed, and `"`, `<`, `>` as
 * HTML entities. Not mermaid's own `#quot;`: mermaid 12 under
 * `securityLevel: "strict"` renders that as mojibake, while `&quot;` comes out
 * as a quote — checked in a browser. `<` must be escaped too, or the
 * sanitizer drops a `<b>`-like run from the title. An arrow (`-->`) inside the
 * quoted label is harmless.
 */
export const mermaidLabel = (s: string): string =>
  s
    .replace(/[\r\n]+/g, " ")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/** `flowchart TD` of the layers, foundations pointing at their consumers,
 * each edge labeled with its import count. High-risk layers get a class. */
export function layerMermaid(plan: EdgePlan, edges: LayerEdge[]): string {
  const lines = ["flowchart TD"];
  plan.layers.forEach((l, i) => {
    lines.push(`  ${nodeId(l.id)}["${mermaidLabel(`${i + 1}. ${l.title}`)}"]`);
  });
  for (const e of edges) lines.push(`  ${nodeId(e.from)} -->|${e.count}| ${nodeId(e.to)}`);
  const high = plan.layers.filter((l) => l.risk === "high").map((l) => nodeId(l.id));
  if (high.length > 0) {
    lines.push("  classDef high fill:#fde7c8,stroke:#c2700a,color:#1f2328");
    lines.push(`  class ${high.join(",")} high`);
  }
  return lines.join("\n");
}

/** Patch text a link can be read from without a clone: context and added
 * lines, as the new file has them. Misses imports the PR didn't touch. */
export function patchText(patch: string | null | undefined): string {
  if (!patch) return "";
  return patch
    .split("\n")
    .filter((l) => !l.startsWith("@@") && !l.startsWith("-"))
    .map((l) => (l.startsWith("+") || l.startsWith(" ") ? l.slice(1) : l))
    .join("\n");
}
