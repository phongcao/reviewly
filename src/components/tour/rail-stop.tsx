import { CodeSpans } from "@/components/tour/code-spans";
import { type KindLabels, kindMeta } from "@/components/tour/kinds";
import type { GuidedStep } from "@/lib/guided";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";

/**
 * One stop on the tour rail.
 *
 * `first`/`last` are GROUP-local, so the spine breaks where a layer does — and
 * so folding a layer away leaves no dangling segment on its neighbours.
 * `aboveFilled`/`belowFilled` stay global: how far the reviewer has got is a
 * fact about the whole tour, not about one layer.
 */
export function RailStop({
  step,
  active,
  done,
  first,
  last,
  aboveFilled,
  belowFilled,
  onClick,
  kindLabels,
}: {
  step: GuidedStep;
  active: boolean;
  done: boolean;
  first: boolean;
  last: boolean;
  aboveFilled: boolean;
  belowFilled: boolean;
  onClick: () => void;
  kindLabels?: KindLabels;
}) {
  const K = kindMeta(step.kind, kindLabels);
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group flex w-full gap-2.5 rounded-lg px-2 text-left transition-colors hover:bg-foreground/[0.04]",
        active && "bg-foreground/[0.05]",
      )}
    >
      <span className="relative flex w-4 shrink-0 flex-col items-center self-stretch">
        <span
          className={cn(
            "w-px flex-1",
            first ? "bg-transparent" : aboveFilled ? "bg-foreground/35" : "bg-foreground/12",
          )}
        />
        <span className="relative flex size-3.5 items-center justify-center">
          {active && (
            <span
              aria-hidden
              className="absolute inline-flex size-full rounded-full bg-foreground opacity-20 motion-safe:animate-ping"
            />
          )}
          {/* Fill encodes STATE (done/current = accent, ahead = hollow).
            The kind shows in the row heading, not on the node. */}
          <span
            className={cn(
              "relative flex size-3.5 items-center justify-center rounded-full",
              done && "bg-foreground/55 text-background",
              active && "bg-foreground/75 text-background ring-4 ring-foreground/10",
              !done && !active && "border-[1.5px] border-foreground/25 bg-background",
            )}
          >
            {done && <Check className="size-2.5" strokeWidth={3} />}
          </span>
        </span>
        <span
          className={cn(
            "w-px flex-1",
            last ? "bg-transparent" : belowFilled ? "bg-foreground/35" : "bg-foreground/12",
          )}
        />
      </span>
      <span className="min-w-0 flex-1 py-2.5">
        <span
          className={cn(
            "mb-1 block text-3xs font-medium uppercase leading-none tracking-wide",
            K.text,
            !active && "opacity-55",
          )}
        >
          {K.label}
        </span>
        <span
          className={cn(
            "block truncate text-xs leading-snug",
            active
              ? "font-medium text-foreground"
              : done
                ? "text-muted-foreground"
                : "text-muted-foreground/55",
          )}
        >
          <CodeSpans text={step.title} />
        </span>
      </span>
    </button>
  );
}
