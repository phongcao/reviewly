import { cn } from "@/lib/utils";

/**
 * The stops that still need the reviewer, by what they need. The sets don't
 * overlap: each is one trust value (`contradicted`, `unanchored`,
 * `unchecked`), and the rest of the tour is backed by a check.
 */
export type StopFilterKind = "disputed" | "unverified" | "unchecked";

const STYLE: Record<StopFilterKind, { label: string; text: string; dot: string; help: string }> = {
  disputed: {
    label: "disputed",
    text: "text-destructive",
    dot: "rounded-full bg-destructive",
    help: "An AI check found code that disagrees with these stops. Read them first.",
  },
  unverified: {
    label: "unverified",
    text: "text-warning",
    dot: "rounded-full bg-warning",
    help: "Their line, or a name they cite, couldn't be found in the diff or your clone.",
  },
  unchecked: {
    label: "unchecked",
    text: "text-muted-foreground",
    dot: "rounded-full border border-current",
    help: "No AI check backs every claim yet: never checked, or the check came back partial.",
  },
};

/** Most urgent first. */
const ORDER: StopFilterKind[] = ["disputed", "unverified", "unchecked"];

/**
 * The tour header's filters. A count shows only while it is above zero (or
 * selected), so a tour with nothing to chase shows nothing. Clicking a count
 * shows only those stops; clicking it again shows all.
 */
export function StopFilters({
  counts,
  active,
  onChange,
}: {
  counts: Record<StopFilterKind, number>;
  active: StopFilterKind | null;
  onChange: (kind: StopFilterKind | null) => void;
}) {
  const shown = ORDER.filter((k) => counts[k] > 0 || active === k);
  if (shown.length === 0) return null;
  return (
    <span className="flex min-w-0 items-center gap-0.5 text-2xs tabular-nums">
      {shown.map((kind) => {
        const s = STYLE[kind];
        const on = active === kind;
        return (
          <button
            key={kind}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? null : kind)}
            title={on ? "Show all stops" : `${s.help} Click to show only these.`}
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 transition-colors",
              on
                ? "bg-foreground/[0.09] text-foreground"
                : cn("hover:bg-foreground/[0.05]", s.text),
            )}
          >
            <span aria-hidden className={cn("size-1.5", s.dot)} />
            {counts[kind]} {s.label}
          </button>
        );
      })}
    </span>
  );
}
