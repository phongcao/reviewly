import { TooltipFor } from "@/components/tooltip-for";
import { CodeSpans } from "@/components/tour/code-spans";
import type { Evidence } from "@/lib/ai/verify";
import { cn } from "@/lib/utils";

/**
 * How a grade looks — one source for the per-stop label and its explanation.
 * `heuristic` is the code's word; the UI says "unverified", like the stop's
 * "Couldn't verify" note and the header's "unverified" filter.
 */
export const GRADE_STYLE: Record<Evidence, { label: string; text: string; dot: string }> = {
  exact: { label: "exact", text: "text-success", dot: "bg-success" },
  strong: { label: "strong", text: "text-foreground/65", dot: "bg-foreground/45" },
  heuristic: { label: "unverified", text: "text-warning", dot: "bg-warning" },
};

/** What each grade means on a PR tour, where stops are graded against the diff. */
export const PR_GRADE_HELP: Record<Evidence, string> = {
  exact: "On a line this PR adds, and every name it cites is in the diff.",
  strong: "On unchanged lines next to the change, or citing names found only in your local clone.",
  heuristic: "Its line, or a name it cites, couldn't be found in the diff (or in your clone).",
};

/** What each grade means on a codebase tour, graded against the file at `HEAD`. */
export const REPO_GRADE_HELP: Record<Evidence, string> = {
  exact: "Every name it cites is at the anchored lines (±3 lines).",
  strong: "A name it cites exists in the repository, but not at the anchored lines.",
  heuristic: "Its file, its line, or a name it cites couldn't be found in the repository.",
};

/** The grade on one stop, with why it got that grade on hover. */
export function GradeLabel({
  grade,
  help,
  reason,
}: {
  grade: Evidence;
  help: Record<Evidence, string>;
  /** This stop's own reason (e.g. which name was missing), when there is one. */
  reason?: string;
}) {
  const g = GRADE_STYLE[grade];
  return (
    <TooltipFor
      label={
        <span className="block max-w-xs">
          <span className="font-medium">{g.label}</span> — {help[grade]}
          {reason && (
            <span className="mt-1 block opacity-80">
              <CodeSpans text={reason} />
            </span>
          )}
        </span>
      }
    >
      <span
        className={cn("inline-flex shrink-0 cursor-default items-center gap-1 text-2xs", g.text)}
        aria-label={`Grade: ${g.label}`}
      >
        <span aria-hidden className={cn("size-1.5 rounded-full", g.dot)} />
        {g.label}
      </span>
    </TooltipFor>
  );
}
