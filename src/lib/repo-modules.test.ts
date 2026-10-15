import type { RepoFile } from "@/lib/repo-files";
import { ROOT_MODULE, detectModules, skippedTotal } from "@/lib/repo-modules";
import { describe, expect, it } from "vitest";

const f = (path: string, lines: number, kind: RepoFile["kind"] = "source"): RepoFile => ({
  path,
  lines,
  bytes: lines * 30,
  lang: path.endsWith(".py") ? "python" : "typescript",
  kind,
});

const ids = (files: RepoFile[]) =>
  detectModules(files)
    .map((m) => m.id)
    .sort();

describe("detectModules", () => {
  it("keeps a small-enough top-level directory whole", () => {
    expect(ids([f("src/a.ts", 300), f("src/b/c.ts", 300)])).toEqual(["src"]);
  });

  it("splits a directory over 8,000 lines into its children", () => {
    const files = [f("src/a/x.ts", 5000), f("src/b/y.ts", 5000), f("src/main.ts", 300)];
    expect(ids(files)).toEqual(["src", "src/a", "src/b"]);
  });

  it("splits a directory over 60 files into its children", () => {
    const files = [
      ...Array.from({ length: 40 }, (_, i) => f(`lib/a/f${i}.ts`, 10)),
      ...Array.from({ length: 40 }, (_, i) => f(`lib/b/f${i}.ts`, 10)),
    ];
    expect(ids(files)).toEqual(["lib/a", "lib/b"]);
  });

  it("merges a child under 200 lines into its parent", () => {
    const files = [f("src/a/x.ts", 9000), f("src/tiny/y.ts", 50), f("src/main.ts", 300)];
    const mods = detectModules(files);
    expect(mods.map((m) => m.id).sort()).toEqual(["src", "src/a"]);
    expect(mods.find((m) => m.id === "src")?.files).toEqual(["src/main.ts", "src/tiny/y.ts"]);
  });

  it("puts root-level files and small top-level dirs in (root)", () => {
    const mods = detectModules([
      f("README.md", 40, "doc"),
      f("scripts/x.sh", 30),
      f("src/a.ts", 500),
    ]);
    const root = mods.find((m) => m.id === ROOT_MODULE);
    expect(root?.dir).toBe("");
    expect(root?.files).toEqual(["README.md", "scripts/x.sh"]);
  });

  it("leaves generated and binary files out, and counts them as skipped", () => {
    const files = [
      f("src/a.ts", 500),
      f("bun.lock", 9000, "generated"),
      f("logo.png", 0, "binary"),
    ];
    expect(detectModules(files).flatMap((m) => m.files)).toEqual(["src/a.ts"]);
    expect(skippedTotal(files)).toEqual({ files: 2, lines: 9000 });
  });

  it("descends through a directory that only wraps another", () => {
    const files = [f("pkg/inner/a/x.py", 5000), f("pkg/inner/b/y.py", 5000)];
    expect(ids(files)).toEqual(["pkg/inner/a", "pkg/inner/b"]);
  });

  it("records languages and tests", () => {
    const [m] = detectModules([f("app/a.py", 400), f("app/test_a.py", 100, "test")]);
    expect(m.langs).toEqual(["python"]);
    expect(m.hasTests).toBe(true);
    expect(m.lines).toBe(500);
  });
});
