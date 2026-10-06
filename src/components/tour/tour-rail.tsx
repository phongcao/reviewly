import type { KindLabels } from "@/components/tour/kinds";
import type { TourProgress } from "@/components/tour/progress";
import { RailStop } from "@/components/tour/rail-stop";
import type { GuidedStep, TourLayer, TourLayerIndex } from "@/lib/guided";
import { cn } from "@/lib/utils";
import { Check, ChevronRight, ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { Fragment, type ReactNode } from "react";

/** Stable empty set, so a tour with no collapse support doesn't hand the rail a
 * fresh `Set` identity on every render. */
const NO_COLLAPSE: ReadonlySet<string> = new Set();

/**
 * The tour's timeline spine: every visible stop, grouped by layer, with read
 * state and the cursor. It carries progress on its own — nodes fill in up to
 * the active one, which glows — so there's no separate progress bar. Layers
 * fold away when the caller supports it (`collapse`). Hidden below `lg`, where
 * the reading pane needs the width; the stepper still navigates there.
 */
export function TourRail({
  steps,
  index,
  layerDone,
  pos,
  active,
  seen,
  activeLayer,
  layerPos,
  collapse,
  onJump,
  kindLabels,
  layerAction,
  title = "The tour",
}: {
  steps: GuidedStep[];
  index: TourLayerIndex;
  /** Read stops per layer (`layerReadCounts`). */
  layerDone: ReadonlyMap<string, number>;
  /** The cursor's position in the visible list, and its original index. */
  pos: number;
  active: number;
  seen: ReadonlySet<number>;
  activeLayer?: TourLayer;
  layerPos: number;
  collapse?: TourProgress["collapse"];
  onJump: (index: number) => void;
  kindLabels?: KindLabels;
  /** Extra control on a layer heading (the PR tour's "Check layer"). */
  layerAction?: (layer: TourLayer, hasCursor: boolean) => ReactNode;
  title?: string;
}) {
  const { groups, layerCounts, collapsibleIds } = index;
  const collapsedIds = collapse?.collapsed ?? NO_COLLAPSE;
  return (
    <aside className="hidden w-60 shrink-0 overflow-y-auto border-r border-hairline px-3 py-4 lg:block">
      <div className="mb-2 flex items-center gap-1 px-2">
        <p className="min-w-0 flex-1 text-3xs font-medium uppercase tracking-wide text-muted-foreground/50">
          {title}
        </p>
        {/* With a single layer the per-heading chevron is enough, and the
            pair would just be noise. Two buttons rather than one toggle:
            a toggle has to invent a meaning for "3 of 7 folded". */}
        {collapse && collapsibleIds.length > 1 && (
          <div className="-mr-1 flex shrink-0 items-center">
            <button
              type="button"
              onClick={() => collapse.setAll(collapsibleIds, true)}
              aria-label="Collapse all layers"
              title="Collapse all"
              className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
            >
              <ChevronsDownUp className="size-3.5" strokeWidth={2} />
            </button>
            <button
              type="button"
              onClick={() => collapse.setAll(collapsibleIds, false)}
              aria-label="Expand all layers"
              title="Expand all"
              className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
            >
              <ChevronsUpDown className="size-3.5" strokeWidth={2} />
            </button>
          </div>
        )}
      </div>
      <div className="flex flex-col">
        {groups.map((g, gi) => {
          const layer = g.layer;
          const folded = !!layer && !!collapse && collapsedIds.has(layer.id);
          // Only the run the cursor is actually in takes the accent, even
          // though the fold belongs to the layer as a whole.
          const hasCursor = !!layer && layer.id === activeLayer?.id && g.items.includes(active);
          const n = layer ? (layerCounts.get(layer.id) ?? g.items.length) : g.items.length;
          const readN = layer ? (layerDone.get(layer.id) ?? 0) : 0;

          // Kept mounted (display:none) so `aria-controls` points at a
          // real node. Must be the `hidden` CLASS, not the attribute: the
          // author-level `display:flex` below would outrank the UA
          // sheet's `[hidden] { display: none }` and still render.
          const rows = (
            <div
              id={layer ? `tour-layer-${layer.id}` : undefined}
              className={folded ? "hidden" : "flex flex-col"}
            >
              {g.items.map((i, q) => {
                const p = g.start + q;
                return (
                  <RailStop
                    key={i}
                    step={steps[i]}
                    active={p === pos}
                    // Read state, not position: a layer that lands ahead
                    // of the cursor must not inherit the checkmarks of the
                    // stops it was inserted behind.
                    done={seen.has(i) && p !== pos}
                    first={q === 0}
                    last={q === g.items.length - 1}
                    aboveFilled={p <= pos}
                    belowFilled={p < pos}
                    onClick={() => onJump(i)}
                    kindLabels={kindLabels}
                  />
                );
              })}
            </div>
          );

          if (!layer) return <Fragment key="ungrouped">{rows}</Fragment>;
          return (
            <div key={`${layer.id}@${g.start}`} className={cn(gi > 0 && "mt-3")}>
              <div className="group mb-1 flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => collapse?.toggle(layer.id)}
                  disabled={!collapse}
                  aria-expanded={!folded}
                  aria-controls={`tour-layer-${layer.id}`}
                  title={`Layer ${layer.index} of ${layer.total} — ${layer.title} · ${readN} of ${n} read${
                    hasCursor ? ` · you're on stop ${Math.max(1, layerPos)}` : ""
                  }`}
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors",
                    collapse && "hover:bg-foreground/[0.04]",
                    folded && hasCursor && "bg-foreground/[0.05]",
                  )}
                >
                  {collapse && (
                    <ChevronRight
                      aria-hidden
                      strokeWidth={2}
                      className={cn(
                        "size-3 shrink-0 text-muted-foreground/50 transition-transform duration-200 motion-reduce:transition-none",
                        !folded && "rotate-90",
                      )}
                    />
                  )}
                  {/* Abbreviated because the chevron and the state chunk now
                      share this row — the full text is in the title. */}
                  <span className="shrink-0 text-3xs font-medium uppercase tracking-wide text-muted-foreground/50">
                    L{layer.index}/{layer.total}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-2xs font-medium",
                      folded && hasCursor ? "text-foreground" : "text-foreground/70",
                    )}
                  >
                    {layer.title}
                  </span>
                  {/* A folded layer has to report itself — how much of it is
                      read, and whether the cursor is inside it, since the
                      active row it would show is hidden. The count is always
                      read progress; the dot only marks the cursor's layer
                      (its position is in the toolbar's "L1 · 3 / 22"). */}
                  <span
                    className={cn(
                      "flex shrink-0 items-center gap-1 text-2xs tabular-nums",
                      hasCursor ? "text-foreground/75" : "text-muted-foreground/50",
                    )}
                  >
                    {hasCursor && (
                      <span aria-hidden className="size-1.5 rounded-full bg-foreground/70" />
                    )}
                    {readN >= n ? <Check className="size-3" strokeWidth={3} /> : `${readN}/${n}`}
                  </span>
                </button>
                {layerAction?.(layer, hasCursor)}
              </div>
              {rows}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
