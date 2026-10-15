import type { GuidedStep } from "@/lib/guided";
import { repoCoverage } from "@/lib/repo-coverage";
import type { RepoModule } from "@/lib/repo-modules";
import { describe, expect, it } from "vitest";

const mod = (id: string, files: string[], lines: number): RepoModule => ({
  id,
  dir: id,
  files,
  lines,
  langs: [],
  hasTests: false,
});
const modules = [
  mod("src/core", ["src/core/a.ts"], 1000),
  mod("src/ui", ["src/ui/b.tsx"], 400),
  mod("src/handlers", ["src/handlers/login.ts"], 300),
  mod("src/util", ["src/util/x.ts"], 100),
  mod("tests", ["tests/a.test.ts"], 250),
  mod("vendor", ["vendor/lib.js"], 900),
];
const stop = (path: string): GuidedStep => ({
  path,
  line: 1,
  kind: "orient",
  title: "t",
  detail: "d",
});

describe("repoCoverage", () => {
  const cov = repoCoverage(
    [stop("src/core/a.ts"), stop("src/core/a.ts")],
    modules,
    new Map([["src/util/x.ts", "export function check() { return verifyToken(t); }"]]),
    new Set(["src/ui"]),
  );
  const bucket = (id: string) => cov.modules.find((m) => m.module.id === id)?.bucket;

  it("buckets modules", () => {
    expect(bucket("src/core")).toBe("toured");
    expect(bucket("src/ui")).toBe("pending");
    expect(bucket("tests")).toBe("tests");
    expect(bucket("vendor")).toBe("skippable");
    expect(bucket("src/handlers")).toBe("unexplored");
    expect(cov.modules.find((m) => m.module.id === "src/core")?.stops).toBe(2);
  });

  it("weights buckets by lines", () => {
    expect(cov.lines).toEqual({
      toured: 1000,
      pending: 400,
      skippable: 900,
      tests: 250,
      unexplored: 400,
    });
    expect(cov.counts.unexplored).toBe(2);
  });

  it("flags unexplored modules as at risk by path or by text", () => {
    // `login` by path; `verifyToken` in the file head.
    expect(cov.atRisk.map((m) => m.module.id)).toEqual(["src/handlers", "src/util"]);
    expect(cov.atRisk.every((m) => m.risks.includes("auth"))).toBe(true);
  });

  it("never reports a pending module as at risk", () => {
    const pending = repoCoverage([], modules, new Map(), new Set(["src/handlers"]));
    expect(pending.atRisk.map((m) => m.module.id)).not.toContain("src/handlers");
  });
});
