import { Button } from "@/components/ui/button";
import type { TourLayer } from "@/lib/guided";
import { ArrowRight, ChevronLeft, ChevronRight, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The tour's counter and prev/next. Inside a layered tour the counter leads
 * with the position in the current layer ("L2 · 3 / 7"), the global one after
 * it, muted.
 */
export function TourStepper({
  activeLayer,
  layerPos,
  layerCount,
  pos,
  total,
  atFirst,
  atLast,
  onMove,
}: {
  activeLayer?: TourLayer;
  layerPos: number;
  /** Visible stops in `activeLayer`. */
  layerCount: number;
  pos: number;
  total: number;
  atFirst: boolean;
  atLast: boolean;
  onMove: (delta: number) => void;
}) {
  return (
    <>
      {activeLayer ? (
        <span className="mr-1 flex items-baseline gap-1.5 text-xs tabular-nums">
          <span
            className="font-medium text-foreground/75"
            title={`${activeLayer.title} — layer ${activeLayer.index} of ${activeLayer.total}`}
          >
            L{activeLayer.index} · {Math.max(1, layerPos)} / {layerCount}
          </span>
          <span className="text-muted-foreground/50">
            {Math.max(1, pos + 1)} / {total}
          </span>
        </span>
      ) : (
        <span className="mr-1 text-xs tabular-nums text-muted-foreground">
          {Math.max(1, pos + 1)} / {total}
        </span>
      )}
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Previous stop"
        disabled={atFirst}
        onClick={() => onMove(-1)}
      >
        <ChevronLeft className="size-4" />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Next stop"
        disabled={atLast}
        onClick={() => onMove(1)}
      >
        <ChevronRight className="size-4" />
      </Button>
    </>
  );
}

/**
 * A layer boundary in the reading pane. A merged tour is one list of stops
 * drawn from many layers; without a boundary the strata the planner chose are
 * invisible and the reader just sees the list get longer.
 */
export function LayerDivider({
  layer,
  count,
  action,
}: {
  layer: TourLayer;
  /** Visible stops in the layer. */
  count: number;
  action?: ReactNode;
}) {
  return (
    <div className="mb-3 mt-7 flex items-center gap-2.5">
      <span className="shrink-0 rounded-full bg-foreground/[0.06] px-2 py-0.5 text-3xs font-medium uppercase tracking-wide text-muted-foreground">
        Layer {layer.index} of {layer.total}
      </span>
      <span className="min-w-0 truncate text-xs font-medium text-foreground/80">{layer.title}</span>
      <span className="shrink-0 text-2xs tabular-nums text-muted-foreground/60">
        {count} stop{count === 1 ? "" : "s"}
      </span>
      <span className="h-px min-w-4 flex-1 bg-hairline" />
      {action}
    </div>
  );
}

/** The foot of the reading pane: "Next stop" until the last one, then the
 * end message; and the way back for dismissed stops. */
export function TourEnd({
  atLast,
  endMessage,
  onNext,
  dismissedCount = 0,
  onRestore,
}: {
  atLast: boolean;
  endMessage: string;
  onNext: () => void;
  dismissedCount?: number;
  onRestore?: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5 py-6">
      {atLast ? (
        <p className="text-center text-xs text-muted-foreground">{endMessage}</p>
      ) : (
        <Button size="xs" variant="ghost" onClick={onNext}>
          Next stop
          <ArrowRight className="size-3" />
        </Button>
      )}
      {dismissedCount > 0 && onRestore && (
        <Button size="xs" variant="ghost" onClick={onRestore}>
          <RotateCcw className="size-3" />
          Restore {dismissedCount} dismissed
        </Button>
      )}
    </div>
  );
}
