import { IconButton } from "@/components/icon-button";
import { prCorpus, verifyClaim } from "@/lib/ai/verify";
import {
  type BehaviorDiff,
  CHANGE_LABEL,
  CHANGE_SIGN,
  CHANGE_STYLE,
  isPureRefactor,
} from "@/lib/behavior";
import type { PullFile } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { AlertTriangle, GitCompare, X } from "lucide-react";
import { useMemo } from "react";

/**
 * Behavioral before/after for one symbol.
 *
 * Two columns, not a narrative: the value is that a reviewer can run their eye
 * down both lists and spot the difference themselves, which is exactly the
 * check a prose summary denies them. The derived change list sits underneath
 * with the spec's +/−/~ signs so the delta is skimmable on its own.
 *
 * A pure refactor gets its own framing rather than an empty change list —
 * "nothing observable changed" is a finding, and the most common one in a large
 * PR.
 */
/**
 * Render the backticked spans the model emits as actual code.
 *
 * Deliberately lighter than the app's `.prose-reviewly code` chip: these
 * bullets are written to preserve identifiers, so a single line routinely
 * carries half a dozen spans, and a bordered-and-padded chip on each turns the
 * line into a wall of boxes that wraps worse than the prose it decorates. Same
 * colour language, none of the chrome.
 *
 * A full markdown renderer would be the other option, but inline code is the
 * only markup in play and its block-level output would fight the list layout.
 */
function Prose({ text }: { text: string }) {
  const parts = text.split(/`([^`]+)`/g);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <code
            key={`${i}:${part}`}
            className="rounded-sm bg-primary/8 px-0.5 font-mono text-[0.92em] text-primary/90 [overflow-wrap:anywhere]"
          >
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

export function BehaviorPanel({
  diff,
  path,
  files,
  onGoToLine,
  onClose,
}: {
  diff: BehaviorDiff;
  /** File the explained symbol lives in — what the claims are checked against. */
  path: string;
  /** The PR's files, for the same grounding check tour stops get. */
  files: PullFile[];
  /** Jump to a new-file line. Omitted = line refs render but don't navigate. */
  onGoToLine?: (line: number) => void;
  onClose: () => void;
}) {
  const refactor = isPureRefactor(diff);
  const both = diff.before.length > 0 && diff.after.length > 0;
  const onlySide: "before" | "after" | null =
    diff.after.length > 0 ? "after" : diff.before.length > 0 ? "before" : null;
  // Steps the model worded identically on both sides — i.e. behavior that did
  // NOT change. Dimming them is what turns two lists into a comparison: the
  // unchanged steps recede and the eye lands on the rows that differ, which is
  // the whole reason these are shown side by side rather than as one summary.
  // Every change statement gets the same grounding check a tour stop gets.
  // Without it this panel would be the one surface in the app where the model
  // asserts things nobody checks — which is exactly what the verifier exists to
  // prevent, and the panel is far more assertive than a tour stop.
  const graded = useMemo(() => {
    const corpus = prCorpus(files);
    return diff.changes.map((c) => ({
      change: c,
      evidence: verifyClaim(
        { path, line: c.ranges[0]?.line ?? 0, endLine: c.ranges[0]?.endLine, text: c.text },
        files,
        corpus,
      ),
      // No range at all is its own failure — there is nothing to click and
      // nothing to check the anchor against.
      unanchored: c.ranges.length === 0,
    }));
  }, [diff.changes, files, path]);

  const unchanged = useMemo(() => {
    const after = new Set(diff.after);
    return new Set(diff.before.filter((b) => after.has(b)));
  }, [diff.before, diff.after]);
  return (
    <div className="mt-3 rounded-lg border border-hairline bg-foreground/[0.02] p-3">
      <div className="flex items-center gap-2">
        <GitCompare className="size-3.5 shrink-0 text-info" />
        {/* Wrap rather than truncate: the model occasionally answers with a
            qualified name or a short scope note, and an ellipsis would hide
            exactly the part that disambiguates it. */}
        <span className="min-w-0 flex-1 break-words font-mono text-xs font-medium text-foreground/90 [overflow-wrap:anywhere]">
          {diff.symbol || "Behavior"}
        </span>
        {refactor && (
          <span className="shrink-0 rounded-full bg-foreground/8 px-2 py-0.5 text-2xs font-medium text-muted-foreground">
            no behavior change detected
          </span>
        )}
        <IconButton
          label="Close behavior summary"
          icon={X}
          size="icon-xs"
          onClick={onClose}
          className="shrink-0 text-muted-foreground/60 hover:text-foreground"
        />
      </div>

      {/* An ADDED symbol has no "before" and a DELETED one has no "after".
          Rendering the empty side as a half-width column spends half the panel
          on two words — and in a PR of new files that is every panel. So a
          one-sided change gets the full width and a one-line note instead. */}
      {both ? (
        <div className="mt-2.5 grid gap-3 sm:grid-cols-2">
          <BehaviorList label="Before" items={diff.before} unchanged={unchanged} />
          <BehaviorList label="After" items={diff.after} unchanged={unchanged} />
        </div>
      ) : (
        onlySide && (
          <div className="mt-2.5">
            <BehaviorList
              label={onlySide === "after" ? "Behavior" : "Behavior before removal"}
              items={onlySide === "after" ? diff.after : diff.before}
              note={
                onlySide === "after" ? "New — did not exist before." : "Removed by this change."
              }
            />
          </div>
        )
      )}

      {graded.length > 0 && (
        <ul className="mt-3 space-y-1.5 border-t border-hairline pt-2.5">
          {graded.map(({ change: c, evidence, unanchored }) => {
            const weak = unanchored || evidence.grade === "heuristic";
            return (
              <li key={`${c.type}:${c.text}`} className="flex gap-2 text-xs">
                <span
                  aria-hidden
                  className={cn("w-2 shrink-0 text-center font-bold", CHANGE_STYLE[c.type])}
                >
                  {CHANGE_SIGN[c.type]}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="text-foreground/90">
                    <Prose text={c.text} />
                  </span>{" "}
                  {/* The evidence, inline. A behavioral claim the reviewer
                      can't jump to is the "unverifiable AI prose" this whole
                      surface is supposed to avoid being. */}
                  {c.ranges.map((r) => (
                    <button
                      key={`${r.line}:${r.endLine ?? ""}`}
                      type="button"
                      disabled={!onGoToLine}
                      onClick={() => onGoToLine?.(r.line)}
                      className="ml-1 rounded bg-foreground/5 px-1 font-mono text-2xs text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground disabled:cursor-default disabled:hover:bg-foreground/5 disabled:hover:text-muted-foreground"
                    >
                      L{r.line}
                      {r.endLine ? `-${r.endLine}` : ""}
                    </button>
                  ))}
                  {weak && (
                    <span
                      title={
                        unanchored
                          ? "The model cited no line for this claim."
                          : (evidence.reason ?? "")
                      }
                      className="ml-1 inline-flex items-center gap-0.5 rounded bg-warning/12 px-1 text-2xs text-warning"
                    >
                      <AlertTriangle className="size-2.5" />
                      unverified
                    </span>
                  )}
                </span>
                <span className={cn("shrink-0 text-2xs", CHANGE_STYLE[c.type])}>
                  {CHANGE_LABEL[c.type]}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <p className="mt-2.5 text-2xs text-muted-foreground/70">
        AI-generated from the diff — the code above is the source of truth.
      </p>
    </div>
  );
}

function BehaviorList({
  label,
  items,
  note,
  unchanged,
}: {
  label: string;
  items: string[];
  /** Shown under the label — what the missing other side means. */
  note?: string;
  /** Bullets present verbatim on both sides; drawn back so the deltas lead. */
  unchanged?: ReadonlySet<string>;
}) {
  return (
    <div className="min-w-0">
      <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground/60">
        {label}
      </p>
      {note && <p className="mt-0.5 text-2xs italic text-muted-foreground">{note}</p>}
      {items.length === 0 ? (
        <p className="mt-1 text-xs italic text-muted-foreground">Nothing stated.</p>
      ) : (
        <ol className="mt-1 space-y-0.5">
          {items.map((t, i) => (
            <li
              key={`${i}:${t}`}
              className={cn(
                "flex gap-1.5 text-xs",
                unchanged?.has(t) ? "text-muted-foreground/55" : "text-foreground/85",
              )}
            >
              <span aria-hidden className="text-muted-foreground/40">
                •
              </span>
              <span className="min-w-0 flex-1">
                <Prose text={t} />
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
