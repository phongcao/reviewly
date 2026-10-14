import { parsePatch } from "@/lib/diff";
import type { CompareCommit, CompareResult, PullFile, Review } from "@/lib/tauri";

/**
 * "What changed since my last review?"
 *
 * The baseline is the head commit of the viewer's newest submitted review —
 * GitHub records it on every review, so nothing is stored locally. The
 * comparison then takes one of two shapes:
 *
 *  - incremental: the new head builds on the reviewed one ("ahead"). The range
 *    diff `reviewed...head` shows exactly what was pushed since, so the diff
 *    view can show it directly. Files the range touches but the PR doesn't
 *    (a merge from the base branch) are dropped.
 *  - rebased: history was rewritten (force-push, rebase). The range diff would
 *    be full of base-branch changes, so instead we compare the PR's own patch
 *    per file, before and after, ignoring line numbers. Only files whose PR
 *    changes really differ count as changed.
 */

/** Review states that mean the viewer actually looked at the code. */
const MEANINGFUL = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED"]);

/** The viewer's newest submitted review, or null. */
export function lastReview(
  reviews: Review[],
  viewerLogin: string | null | undefined,
): Review | null {
  if (!viewerLogin) return null;
  let best: Review | null = null;
  for (const r of reviews) {
    if (r.user.login !== viewerLogin || !MEANINGFUL.has(r.state)) continue;
    if (!best || +new Date(r.submitted_at ?? 0) > +new Date(best.submitted_at ?? 0)) best = r;
  }
  return best;
}

/** The commit the viewer last reviewed: their newest review that has one. */
export function lastReviewedSha(
  reviews: Review[],
  viewerLogin: string | null | undefined,
): string | null {
  if (!viewerLogin) return null;
  let best: Review | null = null;
  for (const r of reviews) {
    if (r.user.login !== viewerLogin || !MEANINGFUL.has(r.state) || !r.commit_id) continue;
    if (!best || +new Date(r.submitted_at ?? 0) > +new Date(best.submitted_at ?? 0)) best = r;
  }
  return best?.commit_id ?? null;
}

/** gone: GitHub no longer has the reviewed commit. error: the request failed. */
export type UnavailableReason = "gone" | "truncated" | "error";

export type SinceReview =
  /** No baseline, or nothing pushed since it. */
  | { mode: "none" }
  /** Waiting on a comparison. */
  | { mode: "pending"; baseSha: string }
  | {
      mode: "incremental";
      baseSha: string;
      /** PR files that changed since the review, with the range patch. */
      files: PullFile[];
      changed: ReadonlySet<string>;
      commits: CompareCommit[];
      totalCommits: number;
    }
  | {
      mode: "rebased";
      baseSha: string;
      changed: ReadonlySet<string>;
      /** In the PR at the reviewed commit, no longer in it. */
      dropped: string[];
    }
  | { mode: "unavailable"; baseSha: string; reason: UnavailableReason };

export interface SinceReviewInput {
  baseSha: string | null;
  headSha: string | null | undefined;
  prFiles: PullFile[];
  /** `baseSha...headSha`. undefined while loading, null when GitHub can't compare. */
  range: CompareResult | null | undefined;
  /**
   * The PR's own changes as they were at `baseSha` (`pr.base...baseSha`). Only
   * needed when history was rewritten. undefined while loading.
   */
  oldPrFiles?: CompareResult | null;
}

/** Whether `sinceReview` needs the PR's old file list to finish. */
export function needsOldPrFiles(range: CompareResult | null | undefined): boolean {
  return !!range && (range.status === "diverged" || range.status === "behind");
}

export function sinceReview(input: SinceReviewInput): SinceReview {
  const { baseSha, headSha, prFiles, range } = input;
  if (!baseSha || !headSha || baseSha === headSha) return { mode: "none" };
  if (range === undefined) return { mode: "pending", baseSha };
  if (range === null) return { mode: "unavailable", baseSha, reason: "gone" };
  if (range.status === "identical") return { mode: "none" };
  if (range.files_truncated) return { mode: "unavailable", baseSha, reason: "truncated" };

  if (range.status === "ahead") {
    const inPr = new Set(prFiles.map((f) => f.filename));
    const files = range.files.filter((f) => inPr.has(f.filename));
    return {
      mode: "incremental",
      baseSha,
      files,
      changed: new Set(files.map((f) => f.filename)),
      commits: range.commits,
      totalCommits: range.total_commits,
    };
  }

  const old = input.oldPrFiles;
  if (old === undefined) return { mode: "pending", baseSha };
  if (old === null) return { mode: "unavailable", baseSha, reason: "gone" };
  if (old.files_truncated) return { mode: "unavailable", baseSha, reason: "truncated" };
  return { mode: "rebased", baseSha, ...rebasedChanges(prFiles, old.files) };
}

/**
 * Per-file "did the PR's change differ" between two versions of the PR.
 * Same blob → unchanged. Otherwise compare only the +/- lines, so a rebase
 * that shifts line numbers (or changes surrounding context) is not a change.
 */
export function rebasedChanges(
  prFiles: PullFile[],
  oldPrFiles: PullFile[],
): { changed: Set<string>; dropped: string[] } {
  const oldByName = new Map(oldPrFiles.map((f) => [f.filename, f]));
  const changed = new Set<string>();
  const seen = new Set<string>();
  for (const f of prFiles) {
    const o =
      oldByName.get(f.filename) ??
      (f.previous_filename ? oldByName.get(f.previous_filename) : undefined);
    if (o) seen.add(o.filename);
    if (!o) {
      changed.add(f.filename);
      continue;
    }
    if (f.sha && o.sha && f.sha === o.sha) continue;
    if (f.patch == null || o.patch == null || normalizePatch(f.patch) !== normalizePatch(o.patch)) {
      changed.add(f.filename);
    }
  }
  const dropped = oldPrFiles.filter((f) => !seen.has(f.filename)).map((f) => f.filename);
  return { changed, dropped };
}

/** The +/- lines of a patch, without hunk headers, context or line numbers. */
export function normalizePatch(patch: string): string {
  return patch
    .split("\n")
    .filter(
      (l) =>
        (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---"),
    )
    .join("\n");
}

/**
 * New-file lines a PR patch shows. GitHub only accepts a review comment on
 * these, so a range diff may offer comments only here.
 */
export function commentableNewLines(patch: string | null | undefined): Set<number> {
  const out = new Set<number>();
  for (const h of parsePatch(patch)) {
    for (const l of h.lines) {
      if (l.newLine != null && (l.kind === "add" || l.kind === "context")) out.add(l.newLine);
    }
  }
  return out;
}
