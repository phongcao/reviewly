import { isTestFile } from "@/lib/focus";
import {
  CATEGORY_LABEL,
  REST_LAYER_ID,
  classifyFile,
  heuristicLayers,
  isPlanStale,
  layerStats,
  parseLayers,
  reconcileLayers,
} from "@/lib/layers";
import type { LayerPlan } from "@/lib/layers";
import type { PullFile } from "@/lib/tauri";
import { describe, expect, it } from "vitest";

/**
 * Characterization tests: these pin down what `layers.ts` does TODAY, before
 * Review Plan v2 changes the schema underneath it. A failure here after a
 * refactor means behaviour moved — decide deliberately, don't just update the
 * expectation.
 */

/** A changed file with only the fields these functions actually read. */
function file(filename: string, extra: Partial<PullFile> = {}): PullFile {
  return {
    sha: null,
    filename,
    status: "modified",
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: "@@ -1 +1 @@\n-a\n+b",
    previous_filename: null,
    ...extra,
  };
}

const plan = (layers: LayerPlan["layers"]): LayerPlan => ({
  summary: "s",
  strategy: "t",
  layers,
});

const layer = (id: string, files: string[]): LayerPlan["layers"][number] => ({
  id,
  title: id,
  intent: "",
  focus: [],
  risk: "medium",
  files,
});

describe("reconcileLayers", () => {
  it("keeps every changed file exactly once", () => {
    const files = [file("a.ts"), file("b.ts"), file("c.ts")];
    const out = reconcileLayers(
      plan([layer("l1", ["a.ts"]), layer("l2", ["b.ts", "c.ts"])]),
      files,
    );

    const all = out.layers.flatMap((l) => l.files);
    expect(all.sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(new Set(all).size).toBe(all.length);
  });

  it("gives a doubly-claimed file to the first layer that lists it", () => {
    const out = reconcileLayers(plan([layer("l1", ["a.ts"]), layer("l2", ["a.ts", "b.ts"])]), [
      file("a.ts"),
      file("b.ts"),
    ]);

    expect(out.layers[0].files).toEqual(["a.ts"]);
    expect(out.layers[1].files).toEqual(["b.ts"]);
  });

  it("drops paths that are not in the PR", () => {
    const out = reconcileLayers(plan([layer("l1", ["a.ts", "ghost.ts"])]), [file("a.ts")]);
    expect(out.layers[0].files).toEqual(["a.ts"]);
  });

  it("normalizes ./, a/, b/ and leading-slash prefixes from raw diff headers", () => {
    const files = [file("src/a.ts"), file("src/b.ts"), file("src/c.ts"), file("src/d.ts")];
    const out = reconcileLayers(
      plan([layer("l1", ["./src/a.ts", "a/src/b.ts", "b/src/c.ts", "/src/d.ts"])]),
      files,
    );

    expect(out.layers[0].files).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]);
  });

  it("resolves a case slip back to the real path", () => {
    const out = reconcileLayers(plan([layer("l1", ["SRC/App.TS"])]), [file("src/app.ts")]);
    expect(out.layers[0].files).toEqual(["src/app.ts"]);
  });

  it("sweeps uncovered files into a trailing catch-all layer", () => {
    const out = reconcileLayers(plan([layer("l1", ["a.ts"])]), [file("a.ts"), file("new.ts")]);

    expect(out.layers).toHaveLength(2);
    const rest = out.layers[1];
    expect(rest.id).toBe(REST_LAYER_ID);
    expect(rest.files).toEqual(["new.ts"]);
  });

  it("drops layers left empty and preserves planner order for the rest", () => {
    const out = reconcileLayers(
      plan([layer("l1", ["gone.ts"]), layer("l2", ["b.ts"]), layer("l3", ["a.ts"])]),
      [file("a.ts"), file("b.ts")],
    );

    expect(out.layers.map((l) => l.id)).toEqual(["l2", "l3"]);
  });

  it("is stable when re-run on its own output", () => {
    const files = [file("a.ts"), file("b.ts")];
    const once = reconcileLayers(plan([layer("l1", ["a.ts"])]), files);
    const twice = reconcileLayers(once, files);
    expect(twice).toEqual(once);
  });
});

describe("isPlanStale", () => {
  it("is true when only the catch-all survived", () => {
    const out = reconcileLayers(plan([layer("l1", ["gone.ts"])]), [file("new.ts")]);
    expect(isPlanStale(out)).toBe(true);
  });

  it("is false while a real layer remains", () => {
    const out = reconcileLayers(plan([layer("l1", ["a.ts"])]), [file("a.ts"), file("new.ts")]);
    expect(isPlanStale(out)).toBe(false);
  });
});

describe("parseLayers", () => {
  const two = `{"summary":"sum","strategy":"strat","layers":[
    {"title":"One","intent":"i","focus":["f"],"risk":"high","files":["a.ts"]},
    {"title":"Two","intent":"j","focus":["g"],"risk":"low","files":["b.ts"]}]}`;

  it("reads a fenced reply and assigns sequential ids", () => {
    const out = parseLayers(`\`\`\`json\n${two}\n\`\`\``);
    expect(out?.summary).toBe("sum");
    expect(out?.strategy).toBe("strat");
    expect(out?.layers.map((l) => l.id)).toEqual(["l1", "l2"]);
    expect(out?.layers[0].risk).toBe("high");
  });

  it("survives trailing prose after the JSON", () => {
    const out = parseLayers(`${two}\n\nHope that helps!`);
    expect(out?.layers).toHaveLength(2);
  });

  it("accepts files given as objects instead of strings", () => {
    const out = parseLayers(`{"layers":[
      {"title":"One","files":[{"path":"a.ts"}]},
      {"title":"Two","files":[{"filename":"b.ts"}]}]}`);

    expect(out?.layers[0].files).toEqual(["a.ts"]);
    expect(out?.layers[1].files).toEqual(["b.ts"]);
  });

  it("maps near-miss risk values and defaults the unknown to medium", () => {
    const out = parseLayers(`{"layers":[
      {"title":"a","risk":"critical","files":["a.ts"]},
      {"title":"b","risk":"med","files":["b.ts"]},
      {"title":"c","risk":"banana","files":["c.ts"]}]}`);

    expect(out?.layers.map((l) => l.risk)).toEqual(["high", "medium", "medium"]);
  });

  it("returns null when fewer than two layers survive — that is not a layering", () => {
    expect(parseLayers(`{"layers":[{"title":"only","files":["a.ts"]}]}`)).toBeNull();
    expect(parseLayers("not json at all")).toBeNull();
  });

  it("drops a layer carrying no usable files rather than the whole plan", () => {
    const out = parseLayers(`{"layers":[
      {"title":"One","files":["a.ts"]},
      {"title":"Empty","files":[]},
      {"title":"Two","files":["b.ts"]}]}`);

    expect(out?.layers.map((l) => l.title)).toEqual(["One", "Two"]);
  });
});

describe("heuristicLayers", () => {
  it("orders buckets by reading rank, not by input order", () => {
    const out = heuristicLayers([
      file("README.md"),
      file("src/components/Button.tsx"),
      file("db/migrations/001.sql"),
      file("src/engine.ts"),
      file("src/types/user.ts"),
    ]);

    expect(out.layers.map((l) => l.id)).toEqual(["data", "types", "core", "ui", "docs"]);
  });

  it("classifies a representative file into each bucket", () => {
    const cases: [string, string][] = [
      ["db/migrations/001.sql", "data"],
      ["src/types/user.ts", "types"],
      ["src/engine.ts", "core"],
      ["src/api/handler.ts", "api"],
      ["src/components/Button.tsx", "ui"],
      [".github/workflows/ci.yml", "config"],
      ["src/engine.test.ts", "tests"],
      ["README.md", "docs"],
      ["bun.lock", "generated"],
    ];

    for (const [path, bucket] of cases) {
      const out = heuristicLayers([file(path)]);
      expect(out.layers[0]?.id, `${path} should land in ${bucket}`).toBe(bucket);
    }
  });

  // Deliberate current behaviour, not an oversight: `focus.ts` treats `.d.ts` as
  // generated ("declarations are often generated"), and the `generated` bucket is
  // matched before `types`. So a hand-written declaration file is classified as
  // generated and reads as low-risk. Pinned here so the tradeoff is visible; changing
  // it is a product decision, not a refactor.
  it("classifies .d.ts as generated, ahead of types", () => {
    const out = heuristicLayers([file("src/types/api.d.ts")]);
    expect(out.layers[0].id).toBe("generated");
  });

  it("covers every file exactly once", () => {
    const files = [file("a.ts"), file("b.test.ts"), file("c.md"), file("d.json")];
    const all = heuristicLayers(files).layers.flatMap((l) => l.files);
    expect(all.sort()).toEqual(["a.ts", "b.test.ts", "c.md", "d.json"]);
  });
});

describe("layerStats", () => {
  it("sums churn and counts viewed files", () => {
    const files = [
      file("a.ts", { additions: 10, deletions: 2 }),
      file("b.ts", { additions: 3, deletions: 1 }),
    ];
    const stats = layerStats(layer("l1", ["a.ts", "b.ts"]), files, { "a.ts": true });

    expect(stats).toMatchObject({ files: 2, additions: 13, deletions: 3, viewed: 1, done: false });
  });

  it("is done only when every file in the layer is viewed", () => {
    const files = [file("a.ts")];
    expect(layerStats(layer("l1", ["a.ts"]), files, { "a.ts": true }).done).toBe(true);
  });

  it("an empty layer is never done", () => {
    expect(layerStats(layer("l1", []), [], {}).done).toBe(false);
  });
});

describe("classifyFile", () => {
  it("gives every bucket a short label for the tree", () => {
    const ids = ["data", "types", "core", "api", "ui", "config", "tests", "docs", "generated"];
    for (const id of ids) expect(CATEGORY_LABEL[id], id).toBeTruthy();
  });

  it("agrees with the bucket heuristicLayers would pick", () => {
    const paths = [
      "db/migrations/001.sql",
      "src/types/user.ts",
      "src/engine.ts",
      "src/api/handler.ts",
      "src/components/Button.tsx",
      ".github/workflows/ci.yml",
      "src/engine.test.ts",
      "README.md",
      "bun.lock",
    ];

    for (const path of paths) {
      const f = file(path);
      expect(classifyFile(path, f).id, path).toBe(heuristicLayers([f]).layers[0].id);
    }
  });

  it("falls back to core for anything unrecognised", () => {
    expect(classifyFile("weird/thing.xyz", file("weird/thing.xyz")).id).toBe("core");
  });

  it("carries the bucket's risk and human-readable title", () => {
    expect(classifyFile("db/migrations/1.sql", file("db/migrations/1.sql"))).toMatchObject({
      id: "data",
      title: "Schema & data",
      risk: "high",
    });
  });

  it("honours a caller-supplied focus reason without re-deriving it", () => {
    const f = file("src/engine.ts");
    // Told it is generated noise, it classifies as generated even though the
    // path says core — this is the shortcut `file-tree` relies on.
    expect(classifyFile(f.filename, f, "generated").id).toBe("generated");
    expect(classifyFile(f.filename, f, null).id).toBe("core");
  });
});

describe("classifyFile — Python conventions", () => {
  // The bucket patterns were written for a JS/TS web app, so a Python repo used
  // to collapse almost entirely into the `core` fallback. These pin the
  // language-specific rules that fix that.
  const cases: [string, string][] = [
    // Config lives in modules, not just dotfiles — the generic rule matches by
    // extension, so these need a basename rule.
    ["src/app/config.py", "config"],
    ["src/app/settings.py", "config"],
    ["setup.py", "config"],
    ["pyproject.toml", "config"],
    // Django / SQLAlchemy / Pydantic keep these as modules, not directories.
    ["src/app/models.py", "data"],
    ["src/app/schemas.py", "data"],
    ["src/app/schema.py", "data"],
    ["alembic/versions/001_add_col.py", "data"],
    // `.pyi` is Python's `.d.ts`.
    ["src/app/client.pyi", "types"],
    ["src/app/types.py", "types"],
    // pytest names tests by prefix, and keeps fixtures in conftest.
    ["tests/test_agent.py", "tests"],
    ["src/app/test_agent.py", "tests"],
    ["src/app/agent_test.py", "tests"],
    ["conftest.py", "tests"],
    ["src/app/conftest.py", "tests"],
    // Genuinely core — the fallback should still catch ordinary source.
    ["src/app/agent/build_agent.py", "core"],
    ["src/app/agent/tools.py", "core"],
    ["src/app/__init__.py", "core"],
  ];

  for (const [path, expected] of cases) {
    it(`${path} -> ${expected}`, () => {
      expect(classifyFile(path, file(path)).id).toBe(expected);
    });
  }

  it("no longer collapses a whole Python package into core", () => {
    const paths = [
      "src/app/config.py",
      "src/app/models.py",
      "src/app/types.py",
      "src/app/build_agent.py",
      "tests/test_build_agent.py",
      "README.md",
    ];
    const ids = new Set(paths.map((p) => classifyFile(p, file(p)).id));
    expect(ids.size).toBeGreaterThan(3);
  });
});

describe("isTestFile — pytest naming", () => {
  it("recognises the prefix convention and conftest", () => {
    expect(isTestFile("tests/test_agent.py")).toBe(true);
    expect(isTestFile("src/app/test_agent.py")).toBe(true);
    expect(isTestFile("conftest.py")).toBe(true);
  });

  it("keeps recognising the suffix convention it already handled", () => {
    expect(isTestFile("src/app/agent_test.py")).toBe(true);
    expect(isTestFile("pkg/thing_test.go")).toBe(true);
    expect(isTestFile("src/lib/layers.test.ts")).toBe(true);
  });

  it("does not claim ordinary modules whose name merely starts with test", () => {
    expect(isTestFile("src/app/testing_utils.py")).toBe(false);
    expect(isTestFile("src/app/latest.py")).toBe(false);
  });
});
