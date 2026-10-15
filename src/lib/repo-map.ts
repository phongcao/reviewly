/**
 * The codebase map: a repository's modules, the import links between them, a
 * computed reading order, and the layers a planner groups them into.
 *
 * The split of labor is deliberate. Structure (modules) and dependency order
 * (edges, then a topological sort) are computed — they are facts about the
 * files, and a model asked for them would guess. The AI only names and
 * groups: it sees the computed order and is told to keep it unless it says
 * why. `reconcileRepoMap` then holds whatever it returns to the modules that
 * exist, and `heuristicRepoMap` is the whole map with no model at all.
 */
import { extractObjects, firstString, stripFence, toArray, toStringArray } from "@/lib/ai/json";
import type { Aliases } from "@/lib/imports";
import { type EdgePlan, type LayerEdge, layerEdges } from "@/lib/layer-edges";
import { type ReviewLayer, toRisk } from "@/lib/layers";
import type { RepoModule } from "@/lib/repo-modules";

export interface RepoEntryPoint {
  path: string;
  why: string;
}

export type RepoLayer = Omit<ReviewLayer, "files"> & { modules: string[] };

export interface RepoMap {
  summary: string;
  strategy: string;
  entryPoints: RepoEntryPoint[];
  layers: RepoLayer[];
}

/** Background-task key for a map run — a namespace of its own, for the
 * reason `TOUR_KEY_PREFIX` gives. */
export const REPO_MAP_KEY_PREFIX = "repo-map:";
export const repoMapKey = (repo: string): string => `${REPO_MAP_KEY_PREFIX}${repo}`;
/** Store key for a repository subject: `repo:owner/repo`. */
export const repoSubject = (owner: string, repo: string): string => `repo:${owner}/${repo}`;

/** The trailing layer for modules the planner didn't place. */
export const OTHER_LAYER_ID = "other";

/**
 * Import links between modules, from file heads (`read_file_heads`). Reuses
 * the layer machinery with each module as a "layer": same direction (from the
 * imported module to the importer), same count and example cap.
 */
export function moduleEdges(
  modules: RepoModule[],
  heads: ReadonlyMap<string, string>,
  aliases?: Aliases,
): LayerEdge[] {
  const plan: EdgePlan = {
    layers: modules.map((m) => ({ id: m.id, title: m.id, risk: "low", files: m.files })),
  };
  return layerEdges(plan, heads, aliases);
}

/**
 * Reading order over modules: strongly connected components (Tarjan) in
 * topological order, foundations first. A cycle can't be ordered, so it is
 * one unit. Ties — components with no order between them — go largest first.
 *
 * Inside a unit the members are still listed foundation-first by import
 * weight (see `cycleOrder`). Real applications cycle at module level all the
 * time — a router in `lib` importing routes that import `lib` — and a unit
 * listed in arbitrary order would make the whole front end one shapeless blob.
 */
export function moduleOrder(modules: RepoModule[], edges: LayerEdge[]): string[][] {
  const ids = modules.map((m) => m.id);
  const lines = new Map(modules.map((m) => [m.id, m.lines]));
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) if (out.has(e.from) && out.has(e.to)) out.get(e.from)?.push(e.to);

  // Tarjan, iterative so a deep chain can't overflow the stack.
  let next = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const comps: string[][] = [];
  for (const start of ids) {
    if (index.has(start)) continue;
    const work: { v: string; i: number }[] = [{ v: start, i: 0 }];
    index.set(start, next);
    low.set(start, next++);
    stack.push(start);
    onStack.add(start);
    while (work.length > 0) {
      const top = work[work.length - 1];
      const succ = out.get(top.v) ?? [];
      if (top.i < succ.length) {
        const w = succ[top.i++];
        if (!index.has(w)) {
          index.set(w, next);
          low.set(w, next++);
          stack.push(w);
          onStack.add(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(top.v, Math.min(low.get(top.v) ?? 0, index.get(w) ?? 0));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.v, Math.min(low.get(parent.v) ?? 0, low.get(top.v) ?? 0));
      if (low.get(top.v) === index.get(top.v)) {
        const comp: string[] = [];
        let w: string | undefined;
        do {
          w = stack.pop();
          if (w === undefined) break;
          onStack.delete(w);
          comp.push(w);
        } while (w !== top.v);
        comps.push(comp);
      }
    }
  }

  // Kahn's algorithm over the condensation, largest ready component first.
  const compOf = new Map<string, number>();
  comps.forEach((c, i) => {
    for (const v of c) compOf.set(v, i);
  });
  const size = comps.map((c) => c.reduce((n, v) => n + (lines.get(v) ?? 0), 0));
  const indeg = comps.map(() => 0);
  const succs = comps.map(() => new Set<number>());
  for (const [v, ws] of out) {
    for (const w of ws) {
      const a = compOf.get(v) ?? -1;
      const b = compOf.get(w) ?? -1;
      if (a !== b && !succs[a].has(b)) {
        succs[a].add(b);
        indeg[b]++;
      }
    }
  }
  const ready = comps.map((_, i) => i).filter((i) => indeg[i] === 0);
  const order: string[][] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => size[b] - size[a] || comps[a][0].localeCompare(comps[b][0]));
    const c = ready.shift() as number;
    order.push(cycleOrder(comps[c], edges, lines));
    for (const d of succs[c]) if (--indeg[d] === 0) ready.push(d);
  }
  return order;
}

/**
 * Members of one cycle, foundation-first: repeatedly take the member whose
 * imports OUT to the rest of the cycle (others depend on it) most outweigh
 * the imports IN (it depends on them), counting each edge by its import
 * count. A greedy feedback-arc heuristic — the back edges it leaves are the
 * light ones, which is the honest reading of "mostly a foundation".
 */
function cycleOrder(
  members: string[],
  edges: LayerEdge[],
  lines: ReadonlyMap<string, number>,
): string[] {
  if (members.length < 2) return [...members];
  const left = new Set(members);
  const inner = edges.filter((e) => left.has(e.from) && left.has(e.to));
  const out: string[] = [];
  while (left.size > 0) {
    let best = "";
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const v of left) {
      let score = 0;
      for (const e of inner) {
        if (!left.has(e.from) || !left.has(e.to)) continue;
        if (e.from === v) score += e.count;
        if (e.to === v) score -= e.count;
      }
      const better =
        score > bestScore ||
        (score === bestScore && (lines.get(v) ?? 0) > (lines.get(best) ?? 0)) ||
        (score === bestScore && (lines.get(v) ?? 0) === (lines.get(best) ?? 0) && v < best);
      if (better) {
        best = v;
        bestScore = score;
      }
    }
    out.push(best);
    left.delete(best);
  }
  return out;
}

/** Parse the planner's reply. Shape only; `reconcileRepoMap` checks content. */
export function parseRepoMap(content: string): RepoMap | null {
  const s = stripFence(content);
  const obj = [...extractObjects(s)]
    .reverse()
    .find(
      (o) =>
        !!o && typeof o === "object" && toArray((o as Record<string, unknown>).layers).length > 0,
    ) as Record<string, unknown> | undefined;
  if (!obj) return null;
  const layers: RepoLayer[] = [];
  for (const raw of toArray(obj.layers)) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const modules = toStringArray(o.modules);
    if (modules.length === 0) continue;
    layers.push({
      id: `l${layers.length + 1}`,
      title:
        typeof o.title === "string" && o.title.trim()
          ? o.title.trim()
          : `Layer ${layers.length + 1}`,
      intent: typeof o.intent === "string" ? o.intent.trim() : "",
      focus: toStringArray(o.focus).slice(0, 4),
      risk: toRisk(o.risk),
      modules,
    });
  }
  if (layers.length === 0) return null;
  const entryPoints = toArray(obj.entryPoints)
    .map((e) => {
      if (!e || typeof e !== "object") return null;
      const r = e as Record<string, unknown>;
      return typeof r.path === "string" && r.path.trim()
        ? {
            path: r.path.trim().replace(/^\.\//, ""),
            why: typeof r.why === "string" ? r.why.trim() : "",
          }
        : null;
    })
    .filter((e): e is RepoEntryPoint => !!e);
  return {
    summary: (typeof obj.summary === "string" ? obj.summary : firstString(s, "summary")).trim(),
    strategy: (typeof obj.strategy === "string" ? obj.strategy : "").trim(),
    entryPoints,
    layers,
  };
}

/**
 * Hold a planned map to the modules that exist: unknown module ids are
 * dropped, a module named twice stays in its first layer, empty layers go,
 * entry points that aren't tracked files go, and every module the planner
 * left out lands in a trailing "Other" layer — so the map always covers the
 * whole repository, whatever the model returned.
 */
export function reconcileRepoMap(
  map: RepoMap,
  modules: RepoModule[],
  trackedPaths: ReadonlySet<string>,
): RepoMap {
  const known = new Set(modules.map((m) => m.id));
  const placed = new Set<string>();
  const layers: RepoLayer[] = [];
  for (const l of map.layers) {
    const mods = l.modules.filter((id) => known.has(id) && !placed.has(id));
    for (const id of mods) placed.add(id);
    if (mods.length > 0) layers.push({ ...l, modules: mods });
  }
  const rest = modules.map((m) => m.id).filter((id) => !placed.has(id));
  if (rest.length > 0) {
    layers.push({
      id: OTHER_LAYER_ID,
      title: "Other",
      intent: "Modules the plan did not place.",
      focus: [],
      risk: "low",
      modules: rest,
    });
  }
  return {
    ...map,
    entryPoints: map.entryPoints.filter((e) => trackedPaths.has(e.path)).slice(0, 5),
    layers,
  };
}

/**
 * The map with no model: the computed order cut into layers of about equal
 * line count. No summary and no entry points — those need reading, and a
 * heuristic that pretended otherwise would be guessing.
 *
 * Cuts fall between units where they can, but a unit (a cycle) bigger than a
 * layer's share is split along its foundation-first order rather than becoming
 * one layer that holds most of the repository.
 */
export function heuristicRepoMap(modules: RepoModule[], order: string[][]): RepoMap {
  const lines = new Map(modules.map((m) => [m.id, m.lines]));
  const total = modules.reduce((n, m) => n + m.lines, 0);
  const wanted = Math.max(1, Math.min(8, Math.ceil(modules.length / 5)));
  const share = total / wanted;
  const units = order.flatMap((unit) => {
    const unitLines = unit.reduce((n, id) => n + (lines.get(id) ?? 0), 0);
    return unitLines > share && unit.length > 1 ? unit.map((id) => [id]) : [unit];
  });
  const count = Math.min(wanted, units.length);
  const target = total / count;
  const layers: RepoLayer[] = [];
  let cur: string[] = [];
  let curLines = 0;
  units.forEach((unit, i) => {
    cur.push(...unit);
    curLines += unit.reduce((n, id) => n + (lines.get(id) ?? 0), 0);
    const left = units.length - i - 1;
    const slots = count - layers.length - 1;
    // Close the layer once it holds its share, or when every remaining unit
    // is needed to fill the remaining layers.
    if ((curLines >= target && slots > 0) || (left === slots && slots > 0)) {
      layers.push(heuristicLayer(layers.length, cur));
      cur = [];
      curLines = 0;
    }
  });
  if (cur.length > 0) layers.push(heuristicLayer(layers.length, cur));
  return {
    summary: "",
    strategy: "Computed from import links between modules: foundations first.",
    entryPoints: [],
    layers,
  };
}

function heuristicLayer(i: number, modules: string[]): RepoLayer {
  return {
    id: `h${i + 1}`,
    title: `Part ${i + 1}`,
    intent: modules.slice(0, 4).join(", ") + (modules.length > 4 ? ", …" : ""),
    focus: [],
    risk: "medium",
    modules,
  };
}

/** The map's layers as an `EdgePlan`, with each layer's files being its
 * modules' files — so `layerMermaid` and `orderViolations` work unchanged. */
export function repoEdgePlan(map: RepoMap, modules: RepoModule[]): EdgePlan {
  const byId = new Map(modules.map((m) => [m.id, m]));
  return {
    layers: map.layers.map((l) => ({
      id: l.id,
      title: l.title,
      risk: l.risk,
      files: l.modules.flatMap((id) => byId.get(id)?.files ?? []),
    })),
  };
}

/** Module edges folded up to the map's layers. */
export function repoLayerEdges(map: RepoMap, edges: LayerEdge[]): LayerEdge[] {
  const layerOf = new Map<string, string>();
  for (const l of map.layers) for (const m of l.modules) layerOf.set(m, l.id);
  const out = new Map<string, LayerEdge>();
  for (const e of edges) {
    const from = layerOf.get(e.from);
    const to = layerOf.get(e.to);
    if (!from || !to || from === to) continue;
    const key = `${from}\u0000${to}`;
    const cur = out.get(key) ?? { from, to, count: 0, examples: [] };
    cur.count += e.count;
    for (const x of e.examples) if (cur.examples.length < 3) cur.examples.push(x);
    out.set(key, cur);
  }
  const pos = new Map(map.layers.map((l, i) => [l.id, i]));
  return [...out.values()].sort(
    (a, b) =>
      (pos.get(a.to) ?? 0) - (pos.get(b.to) ?? 0) ||
      (pos.get(a.from) ?? 0) - (pos.get(b.from) ?? 0),
  );
}
