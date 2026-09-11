import { blindSpots, fileRisks, tourCoverage } from "@/lib/coverage";
import type { GuidedStep } from "@/lib/guided";
import type { PullFile } from "@/lib/tauri";
import { describe, expect, it } from "vitest";

const f = (filename: string, o: Partial<PullFile> = {}): PullFile => ({
  sha: "a",
  filename,
  status: "modified",
  additions: 10,
  deletions: 0,
  changes: 10,
  patch: "@@ -1,1 +1,2 @@\n context\n+added line",
  previous_filename: null,
  ...o,
});

const step = (path: string): GuidedStep => ({
  path,
  line: 2,
  kind: "orient",
  title: "t",
  detail: "d",
});

describe("tourCoverage", () => {
  it("buckets a file with a stop as toured", () => {
    const r = tourCoverage([step("src/a.ts")], [f("src/a.ts")]);
    expect(r.counts.toured).toBe(1);
    expect(r.files[0].stops).toBe(1);
  });

  it("counts a changed, unexplained file as the real gap", () => {
    const r = tourCoverage([], [f("src/a.ts")]);
    expect(r.counts.unexamined).toBe(1);
    expect(r.churn.unexamined).toBe(10);
    expect(blindSpots(r).map((b) => b.file.filename)).toEqual(["src/a.ts"]);
  });

  it("excuses lockfiles and generated output instead of indicting them", () => {
    const r = tourCoverage([], [f("bun.lock"), f("dist/app.js"), f("api.generated.ts")]);
    expect(r.counts.skippable).toBe(3);
    expect(r.counts.unexamined).toBe(0);
    expect(r.files[0].hidden).toBe("lockfile");
  });

  it("separates tests from genuine blind spots", () => {
    const r = tourCoverage([], [f("src/a.test.ts"), f("tests/test_x.py"), f("src/b.ts")]);
    expect(r.counts.tests).toBe(2);
    expect(r.counts.unexamined).toBe(1);
  });

  it("does not indict a layer that hasn't been toured yet", () => {
    const files = [f("src/a.ts"), f("src/b.ts")];
    const pending = new Set(["src/b.ts"]);
    const r = tourCoverage([], files, pending);
    expect(r.counts.pending).toBe(1);
    expect(r.counts.unexamined).toBe(1);
    expect(blindSpots(r).map((b) => b.file.filename)).toEqual(["src/a.ts"]);
  });

  it("lets a stop win over a pending layer", () => {
    const r = tourCoverage([step("src/b.ts")], [f("src/b.ts")], new Set(["src/b.ts"]));
    expect(r.counts.toured).toBe(1);
    expect(r.counts.pending).toBe(0);
  });

  it("ranks blind spots by churn, biggest first", () => {
    const r = tourCoverage(
      [],
      [f("small.ts", { changes: 3 }), f("big.ts", { changes: 900 }), f("mid.ts", { changes: 40 })],
    );
    expect(blindSpots(r).map((b) => b.file.filename)).toEqual(["big.ts", "mid.ts", "small.ts"]);
  });

  it("surfaces an unexamined sensitive file above the rest", () => {
    const r = tourCoverage([], [f("src/plain.ts", { changes: 500 }), f("src/auth/session.ts")]);
    expect(r.atRisk.map((a) => a.file.filename)).toEqual(["src/auth/session.ts"]);
  });

  it("does not flag a sensitive file the tour actually stopped on", () => {
    const r = tourCoverage([step("src/auth/session.ts")], [f("src/auth/session.ts")]);
    expect(r.atRisk).toEqual([]);
  });
});

describe("fileRisks", () => {
  it("reads the path for auth, migrations and money", () => {
    expect(fileRisks(f("src/auth/login.ts"))).toContain("auth");
    expect(fileRisks(f("db/migrations/004_add.sql"))).toContain("migration");
    expect(fileRisks(f("billing/invoice.rb"))).toContain("money");
  });

  it("catches a sensitive change in an innocently named file", () => {
    const file = f("src/util.ts", {
      patch: "@@ -1,1 +1,2 @@\n ctx\n+  if (!hasPermission(user)) return null;",
    });
    expect(fileRisks(file)).toContain("auth");
  });

  it("reads only changed lines, not surrounding context", () => {
    const file = f("src/util.ts", {
      patch: "@@ -1,2 +1,2 @@\n DROP TABLE users;\n+const x = 1;",
    });
    expect(fileRisks(file)).toEqual([]);
  });

  it("flags a destructive statement regardless of filename", () => {
    const file = f("scripts/cleanup.ts", {
      patch: "@@ -1,1 +1,2 @@\n ctx\n+  await db.raw('TRUNCATE TABLE events');",
    });
    expect(fileRisks(file)).toContain("destructive");
  });

  it("leaves ordinary code unflagged", () => {
    const file = f("src/ui/button.tsx", {
      patch: "@@ -1,1 +1,2 @@\n ctx\n+  const label = props.label ?? 'OK';",
    });
    expect(fileRisks(file)).toEqual([]);
  });
});
