import { IconButton } from "@/components/icon-button";
import {
  type BehaviorDiff,
  CHANGE_LABEL,
  CHANGE_SIGN,
  CHANGE_STYLE,
  isPureRefactor,
} from "@/lib/behavior";
import { cn } from "@/lib/utils";
import { GitCompare, X } from "lucide-react";

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

export function BehaviorPanel({ diff, onClose }: { diff: BehaviorDiff; onClose: () => void }) {
  const refactor = isPureRefactor(diff);
  const both = diff.before.length > 0 && diff.after.length > 0;
  const onlySide: "before" | "after" | null =
    diff.after.length > 0 ? "after" : diff.before.length > 0 ? "before" : null;
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
          <BehaviorList label="Before" items={diff.before} />
          <BehaviorList label="After" items={diff.after} />
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

      {diff.changes.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-hairline pt-2.5">
          {diff.changes.map((c) => (
            <li key={`${c.type}:${c.text}`} className="flex gap-2 text-xs">
              <span
                aria-hidden
                className={cn("w-2 shrink-0 text-center font-bold", CHANGE_STYLE[c.type])}
              >
                {CHANGE_SIGN[c.type]}
              </span>
              <span className="min-w-0 flex-1 text-foreground/90">
                <Prose text={c.text} />
              </span>
              <span className={cn("shrink-0 text-2xs", CHANGE_STYLE[c.type])}>
                {CHANGE_LABEL[c.type]}
              </span>
            </li>
          ))}
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
}: {
  label: string;
  items: string[];
  /** Shown under the label — what the missing other side means. */
  note?: string;
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
            <li key={`${i}:${t}`} className="flex gap-1.5 text-xs text-foreground/85">
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
