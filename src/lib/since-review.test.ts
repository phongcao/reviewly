import {
  commentableNewLines,
  lastReview,
  lastReviewedSha,
  needsOldPrFiles,
  normalizePatch,
  rebasedChanges,
  sinceReview,
} from "@/lib/since-review";
import type { CompareResult, PullFile, Review } from "@/lib/tauri";
import { describe, expect, it } from "vitest";

const file = (filename: string, patch: string | null, o: Partial<PullFile> = {}): PullFile => ({
  sha: null,
  filename,
  status: "modified",
  additions: 1,
  deletions: 0,
  changes: 1,
  patch,
  previous_filename: null,
  ...o,
});

const review = (login: string, state: string, at: string, commit: string | null): Review => ({
  id: Math.random(),
  user: { login, avatar_url: "", html_url: "", id: 1 },
  body: null,
  state,
  html_url: "",
  submitted_at: at,
  commit_id: commit,
});

const compare = (
  status: string,
  files: PullFile[],
  o: Partial<CompareResult> = {},
): CompareResult => ({
  status,
  ahead_by: 2,
  behind_by: 0,
  total_commits: 2,
  commits: [],
  files,
  files_truncated: false,
  ...o,
});

describe("lastReviewedSha", () => {
  const reviews = [
    review("me", "COMMENTED", "2026-10-01T00:00:00Z", "aaa1111"),
    review("me", "CHANGES_REQUESTED", "2026-10-03T00:00:00Z", "bbb2222"),
    review("me", "PENDING", "2026-10-05T00:00:00Z", "ccc3333"),
    review("someone", "APPROVED", "2026-10-06T00:00:00Z", "ddd4444"),
  ];

  it("takes the viewer's newest submitted review", () => {
    expect(lastReviewedSha(reviews, "me")).toBe("bbb2222");
    expect(lastReview(reviews, "me")?.state).toBe("CHANGES_REQUESTED");
  });

  it("ignores pending reviews and other people", () => {
    expect(lastReviewedSha(reviews, "nobody")).toBeNull();
    expect(lastReviewedSha(reviews, null)).toBeNull();
  });

  it("skips a newer review with no commit", () => {
    const r = [...reviews, review("me", "COMMENTED", "2026-10-07T00:00:00Z", null)];
    expect(lastReviewedSha(r, "me")).toBe("bbb2222");
    expect(lastReview(r, "me")?.commit_id).toBeNull();
  });
});

describe("sinceReview", () => {
  const prFiles = [file("src/a.ts", "+a"), file("src/b.ts", "+b")];
  const base = { baseSha: "aaa1111", headSha: "bbb2222", prFiles };

  it("is none without a baseline or when nothing was pushed", () => {
    expect(sinceReview({ ...base, baseSha: null, range: undefined }).mode).toBe("none");
    expect(sinceReview({ ...base, headSha: "aaa1111", range: undefined }).mode).toBe("none");
    expect(sinceReview({ ...base, range: compare("identical", []) }).mode).toBe("none");
  });

  it("waits for the comparison", () => {
    expect(sinceReview({ ...base, range: undefined }).mode).toBe("pending");
  });

  it("keeps only PR files from an incremental range, dropping merge-from-base noise", () => {
    const range = compare("ahead", [file("src/a.ts", "+fix"), file("vendor/main-only.ts", "+x")]);
    const r = sinceReview({ ...base, range });
    expect(r.mode).toBe("incremental");
    if (r.mode !== "incremental") return;
    expect([...r.changed]).toEqual(["src/a.ts"]);
    expect(r.files.map((f) => f.filename)).toEqual(["src/a.ts"]);
    expect(r.totalCommits).toBe(2);
  });

  it("says why it can't compare", () => {
    expect(sinceReview({ ...base, range: null })).toMatchObject({
      mode: "unavailable",
      reason: "gone",
    });
    const big = compare("ahead", [], { files_truncated: true });
    expect(sinceReview({ ...base, range: big })).toMatchObject({
      mode: "unavailable",
      reason: "truncated",
    });
  });

  it("needs the old PR files after a force-push", () => {
    const range = compare("diverged", [file("src/a.ts", "+x")]);
    expect(needsOldPrFiles(range)).toBe(true);
    expect(needsOldPrFiles(compare("ahead", []))).toBe(false);
    expect(sinceReview({ ...base, range }).mode).toBe("pending");
    expect(sinceReview({ ...base, range, oldPrFiles: null })).toMatchObject({ reason: "gone" });
    const old = compare("ahead", [file("src/a.ts", "+a"), file("src/b.ts", "+old b")]);
    const r = sinceReview({ ...base, range, oldPrFiles: old });
    expect(r.mode).toBe("rebased");
    if (r.mode === "rebased") expect([...r.changed]).toEqual(["src/b.ts"]);
  });
});

describe("rebasedChanges", () => {
  const before = ["@@ -10,3 +10,4 @@ fn", " ctx", "-old", "+new", " ctx"].join("\n");
  // The same change after a rebase: shifted line numbers, different context.
  const shifted = ["@@ -42,3 +42,4 @@ other", " moved ctx", "-old", "+new", " more"].join("\n");
  const edited = ["@@ -10,3 +10,4 @@ fn", " ctx", "-old", "+newer", " ctx"].join("\n");

  it("treats a rebase that only moves the change as unchanged", () => {
    const r = rebasedChanges([file("a.ts", shifted)], [file("a.ts", before)]);
    expect(r.changed.size).toBe(0);
  });

  it("flags a real edit, a file new to the PR, and a dropped file", () => {
    const r = rebasedChanges(
      [file("a.ts", edited), file("new.ts", "+n")],
      [file("a.ts", before), file("gone.ts", "+g")],
    );
    expect([...r.changed].sort()).toEqual(["a.ts", "new.ts"]);
    expect(r.dropped).toEqual(["gone.ts"]);
  });

  it("matches a renamed file to its old name", () => {
    const r = rebasedChanges(
      [file("b.ts", before, { previous_filename: "a.ts", status: "renamed" })],
      [file("a.ts", before)],
    );
    expect(r.changed.size).toBe(0);
    expect(r.dropped).toEqual([]);
  });

  it("trusts an identical blob even without a patch, and flags a missing patch otherwise", () => {
    const same = rebasedChanges(
      [file("bin", null, { sha: "x" })],
      [file("bin", null, { sha: "x" })],
    );
    expect(same.changed.size).toBe(0);
    const differ = rebasedChanges(
      [file("bin", null, { sha: "y" })],
      [file("bin", null, { sha: "x" })],
    );
    expect([...differ.changed]).toEqual(["bin"]);
  });

  it("normalizes to the +/- lines only", () => {
    expect(normalizePatch(before)).toBe("-old\n+new");
  });
});

describe("commentableNewLines", () => {
  it("collects added and context lines across hunks, not deleted ones", () => {
    const patch = [
      "@@ -1,2 +1,2 @@",
      " keep",
      "-gone",
      "+here",
      "@@ -20,1 +20,2 @@",
      " ctx",
      "+added",
    ].join("\n");
    expect([...commentableNewLines(patch)].sort((a, b) => a - b)).toEqual([1, 2, 20, 21]);
    expect(commentableNewLines(null).size).toBe(0);
  });
});
