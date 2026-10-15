import type { LayerEdge } from "@/lib/layer-edges";
import {
  OTHER_LAYER_ID,
  heuristicRepoMap,
  moduleEdges,
  moduleOrder,
  parseRepoMap,
  reconcileRepoMap,
  repoLayerEdges,
} from "@/lib/repo-map";
import type { RepoModule } from "@/lib/repo-modules";
import { describe, expect, it } from "vitest";

const mod = (id: string, files: string[], lines = 100): RepoModule => ({
  id,
  dir: id,
  files,
  lines,
  langs: ["typescript"],
  hasTests: false,
});

const modules = [
  mod("src/lib", ["src/lib/a.ts", "src/lib/b.ts"], 900),
  mod("src/stores", ["src/stores/s.ts"], 300),
  mod("src/components", ["src/components/c.tsx"], 1200),
  mod("src/routes", ["src/routes/r.tsx"], 500),
];

const heads = new Map([
  ["src/lib/a.ts", 'import { b } from "./b";'],
  ["src/stores/s.ts", 'import { a } from "@/lib/a";'],
  ["src/components/c.tsx", 'import { a } from "@/lib/a";\nimport { s } from "@/stores/s";'],
  ["src/routes/r.tsx", 'import { C } from "@/components/c";\nimport { a } from "../lib/a";'],
]);

const edge = (from: string, to: string): LayerEdge => ({ from, to, count: 1, examples: [] });

describe("moduleEdges", () => {
  it("builds edges across modules, from the imported to the importer", () => {
    const edges = moduleEdges(modules, heads, { "@/": "src/" });
    expect(edges.map((e) => `${e.from}->${e.to}`).sort()).toEqual([
      "src/components->src/routes",
      "src/lib->src/components",
      "src/lib->src/routes",
      "src/lib->src/stores",
      "src/stores->src/components",
    ]);
  });
});

describe("moduleOrder", () => {
  it("puts foundations first", () => {
    const order = moduleOrder(modules, moduleEdges(modules, heads, { "@/": "src/" }));
    expect(order).toEqual([["src/lib"], ["src/stores"], ["src/components"], ["src/routes"]]);
  });

  it("makes a cycle one unit, ordered after its foundations", () => {
    const m = [mod("a", [], 10), mod("b", [], 20), mod("c", [], 30), mod("d", [], 5)];
    const order = moduleOrder(m, [edge("a", "b"), edge("b", "c"), edge("c", "b"), edge("c", "d")]);
    expect(order.map((u) => [...u].sort())).toEqual([["a"], ["b", "c"], ["d"]]);
  });

  it("lists a cycle's members foundation-first by import weight", () => {
    const m = [mod("lib", [], 100), mod("ui", [], 900), mod("routes", [], 500)];
    const heavy = (from: string, to: string, count: number): LayerEdge => ({
      from,
      to,
      count,
      examples: [],
    });
    const order = moduleOrder(m, [
      heavy("lib", "ui", 100),
      heavy("ui", "lib", 2),
      heavy("ui", "routes", 60),
      heavy("routes", "lib", 10),
      heavy("lib", "routes", 50),
    ]);
    expect(order).toEqual([["lib", "ui", "routes"]]);
  });

  it("breaks ties by line count, largest first", () => {
    const m = [mod("small", [], 10), mod("big", [], 900), mod("mid", [], 100)];
    expect(moduleOrder(m, [])).toEqual([["big"], ["mid"], ["small"]]);
  });

  it("orders every module exactly once", () => {
    const order = moduleOrder(modules, [
      edge("src/lib", "src/routes"),
      edge("src/routes", "src/lib"),
    ]);
    expect(order.flat().sort()).toEqual(modules.map((x) => x.id).sort());
  });
});

describe("parseRepoMap and reconcileRepoMap", () => {
  const reply = JSON.stringify({
    summary: "A review app.",
    strategy: "Lib first.",
    entryPoints: [
      { path: "src/routes/r.tsx", why: "The route table." },
      { path: "src/main.tsx", why: "Invented." },
    ],
    layers: [
      { title: "Core", intent: "i", focus: ["f"], risk: "high", modules: ["src/lib", "src/ghost"] },
      { title: "State", modules: ["src/stores", "src/lib"] },
      { title: "Empty", modules: ["src/nothing"] },
    ],
  });
  const tracked = new Set(modules.flatMap((m) => m.files));

  it("drops unknown module ids and fake entry points, and adds an Other layer", () => {
    const parsed = parseRepoMap(`\`\`\`json\n${reply}\n\`\`\``);
    expect(parsed).not.toBeNull();
    const map = reconcileRepoMap(parsed as NonNullable<typeof parsed>, modules, tracked);
    expect(map.layers.map((l) => [l.title, l.modules])).toEqual([
      ["Core", ["src/lib"]],
      ["State", ["src/stores"]],
      ["Other", ["src/components", "src/routes"]],
    ]);
    expect(map.layers[2].id).toBe(OTHER_LAYER_ID);
    expect(map.entryPoints).toEqual([{ path: "src/routes/r.tsx", why: "The route table." }]);
    expect(map.layers[0].risk).toBe("high");
  });

  it("returns null for a reply with no layers", () => {
    expect(parseRepoMap("I can't do that.")).toBeNull();
  });
});

describe("heuristicRepoMap", () => {
  it("covers every module, in order, with no summary or entry points", () => {
    const many = Array.from({ length: 23 }, (_, i) => mod(`m${i}`, [], 100 + i * 10));
    const order = moduleOrder(many, []);
    const map = heuristicRepoMap(many, order);
    expect(map.layers.flatMap((l) => l.modules)).toEqual(order.flat());
    expect(map.layers.length).toBeGreaterThan(1);
    expect(map.layers.length).toBeLessThanOrEqual(8);
    expect(map.summary).toBe("");
    expect(map.entryPoints).toEqual([]);
  });

  it("splits a cycle bigger than a layer's share", () => {
    const many = Array.from({ length: 12 }, (_, i) => mod(`m${i}`, [], 100));
    const order = [many.slice(0, 10).map((x) => x.id), ["m10"], ["m11"]];
    const map = heuristicRepoMap(many, order);
    expect(map.layers.length).toBeGreaterThan(1);
    expect(map.layers.flatMap((l) => l.modules)).toEqual(order.flat());
  });

  it("handles a single module", () => {
    const map = heuristicRepoMap([mod("only", [], 10)], [["only"]]);
    expect(map.layers.map((l) => l.modules)).toEqual([["only"]]);
  });
});

describe("repoLayerEdges", () => {
  it("folds module edges up to layers and drops edges inside a layer", () => {
    const map = heuristicRepoMap(modules, [
      ["src/lib", "src/stores"],
      ["src/components"],
      ["src/routes"],
    ]);
    const layers = {
      ...map,
      layers: [
        { ...map.layers[0], id: "a", modules: ["src/lib", "src/stores"] },
        { ...map.layers[0], id: "b", modules: ["src/components", "src/routes"] },
      ],
    };
    const out = repoLayerEdges(layers, moduleEdges(modules, heads, { "@/": "src/" }));
    expect(out.map((e) => [e.from, e.to, e.count])).toEqual([["a", "b", 3]]);
  });
});
