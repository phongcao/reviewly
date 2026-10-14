import { Segmented, type SegmentedOption } from "@/components/segmented";
import { relativeTime } from "@/lib/format";
import type { SinceReview } from "@/lib/since-review";
import type { Review } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { AlertTriangle, GitCompareArrows, MessageSquareText } from "lucide-react";

export type SinceDiff = "range" | "full";

/**
 * Which files the review loop shows and which diff each one gets:
 * range — changed files, only the new commits' diff;
 * full — changed files, the PR's whole diff;
 * all — every file, the PR's whole diff.
 */
export type SinceView = SinceDiff | "all";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * "N commits since your review" — sits above the file panes. Owns no state:
 * the view mode lives with the PR view.
 */
export function SinceReviewBanner({
  state,
  review,
  view,
  onView,
  inLayer,
  myThreads,
  onCheckComments,
}: {
  state: SinceReview;
  review: Review | null;
  view: SinceView;
  onView: (v: SinceView) => void;
  /** Changed files inside the active layer; null outside layered review. */
  inLayer: number | null;
  /** Threads the viewer started; the follow-up button shows only when > 0. */
  myThreads: number;
  onCheckComments: () => void;
}) {
  if (state.mode === "none") return null;
  const sha = <code className="font-mono">{state.baseSha.slice(0, 7)}</code>;
  const when = review?.submitted_at ? ` ${relativeTime(review.submitted_at)}` : "";
  const commentsButton =
    myThreads > 0 ? (
      <button
        type="button"
        onClick={onCheckComments}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-foreground transition-colors hover:bg-foreground/[0.07]"
      >
        <MessageSquareText className="size-3.5" />
        Check my comments ({myThreads})
      </button>
    ) : null;

  if (state.mode === "pending") {
    return <Bar muted>Comparing with your last review ({sha})…</Bar>;
  }

  if (state.mode === "unavailable") {
    const why =
      state.reason === "gone"
        ? "GitHub no longer has the commit you reviewed"
        : state.reason === "truncated"
          ? "too many files changed to compare"
          : "the comparison failed";
    return (
      <Bar warn>
        <span className="min-w-0">
          Can't compare with your last review ({sha}): {why}. Showing the full PR.
        </span>
        <span className="ml-auto">{commentsButton}</span>
      </Bar>
    );
  }

  const files = state.changed.size;
  // The tree shows changed files ∩ layer, so say how many that is — "60 files
  // changed" over a 7-file tree otherwise reads as a broken filter.
  const layerNote =
    inLayer == null ? null : (
      <> · {inLayer === 0 ? "none" : inLayer === files ? "all" : inLayer} in this layer</>
    );
  const viewOptions: SegmentedOption<SinceView>[] = [
    ...(state.mode === "incremental"
      ? [
          {
            value: "range" as const,
            label: "Since review",
            title: "Changed files, showing only what the new commits changed",
          },
          {
            value: "full" as const,
            label: "Changed · full diff",
            title: "Changed files, showing the PR's whole diff for each",
          },
        ]
      : [
          {
            value: "full" as const,
            label: "Changed files",
            title: "Files whose changes differ since your review, with the PR's diff",
          },
        ]),
    { value: "all", label: "All files", title: "Every file in the PR, with the PR's diff" },
  ];
  // A rebase has no range diff to show, so "range" falls back to "full".
  const shown: SinceView = state.mode === "rebased" && view === "range" ? "full" : view;

  return (
    <Bar warn={state.mode === "rebased"}>
      {state.mode === "rebased" ? (
        <AlertTriangle className="size-3.5 shrink-0" />
      ) : (
        <GitCompareArrows className="size-3.5 shrink-0 text-primary" />
      )}
      <span className="min-w-0">
        {state.mode === "incremental" ? (
          <>
            {plural(state.totalCommits, "commit")} since your review of {sha}
            {when} · {plural(files, "file")} changed{layerNote}
          </>
        ) : (
          <>
            History was rewritten since your review of {sha}
            {when}. {plural(files, "file")} changed in substance
            {layerNote}
            {state.dropped.length > 0 && <>, {plural(state.dropped.length, "file")} left the PR</>}
          </>
        )}
        {state.mode === "incremental" && state.commits.length > 0 && (
          <details className="mt-1 text-muted-foreground">
            <summary className="cursor-pointer select-none">Commits</summary>
            <ul className="mt-1 space-y-0.5">
              {state.commits.slice(0, 20).map((c) => (
                <li key={c.sha} className="truncate">
                  <code className="font-mono">{c.sha.slice(0, 7)}</code> {c.subject}
                  {c.author && <span className="text-muted-foreground/70"> · {c.author}</span>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        <Segmented value={shown} onChange={onView} options={viewOptions} />
        {commentsButton}
      </span>
    </Bar>
  );
}

function Bar({
  children,
  warn,
  muted,
}: {
  children: React.ReactNode;
  warn?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="border-b border-hairline px-5 py-2">
      <div
        className={cn(
          "flex items-start gap-2 rounded-md px-2 py-1.5 text-xs",
          warn
            ? "bg-warning/10 text-warning"
            : muted
              ? "text-muted-foreground"
              : "bg-primary/[0.06] text-foreground",
        )}
      >
        {children}
      </div>
    </div>
  );
}
