import { IconButton } from "@/components/icon-button";
import { TooltipFor } from "@/components/tooltip-for";
import { TrustChip } from "@/components/tour/claim-rows";
import { CodeSpans } from "@/components/tour/code-spans";
import { type KindLabels, kindMeta } from "@/components/tour/kinds";
import type { Trust } from "@/lib/claim-check";
import type { GuidedStep } from "@/lib/guided";
import { cn } from "@/lib/utils";
import { FileCode, X } from "lucide-react";
import type { ReactNode } from "react";

/**
 * A stop's sticky header — the current stop stays pinned while you read it.
 * Opaque so the code scrolls cleanly *under* it (no bleed-through). The
 * pinning itself marks "where you are", so the row stays neutral.
 */
export function StepHeader({
  index,
  step,
  trust,
  showTrust,
  openLabel,
  onOpenFile,
  onDismiss,
  kindLabels,
  grade,
}: {
  index: number;
  step: Pick<GuidedStep, "kind" | "title" | "path" | "line" | "endLine">;
  trust: Trust;
  showTrust: boolean;
  /** Tooltip and accessible name of the path button. */
  openLabel: string;
  onOpenFile: (path: string, line?: number) => void;
  onDismiss?: () => void;
  kindLabels?: KindLabels;
  /** The stop's grade label (`GradeLabel`), shown after the kind. */
  grade?: ReactNode;
}) {
  const kind = kindMeta(step.kind, kindLabels);
  const Icon = kind.icon;
  return (
    <div className="sticky top-0 z-20 -mx-5 flex items-center gap-2 border-b border-b-hairline bg-background px-5 py-2 shadow-sm">
      <span aria-hidden className={cn("absolute inset-y-0 left-0 w-0.5", kind.dot)} />
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-2xs font-medium tabular-nums text-muted-foreground">
        {index + 1}
      </span>
      <span
        className={cn("inline-flex shrink-0 items-center gap-1 text-xs font-medium", kind.text)}
      >
        <Icon className="size-3.5" />
        {kind.label}
      </span>
      {grade}
      {showTrust && trust !== "unchecked" && <TrustChip trust={trust} />}
      <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
        <CodeSpans text={step.title} />
      </h3>
      {/* Full path, not just the basename — `__init__.py` or `README.md`
          can exist in several folders. The directory gives way first when
          the header is tight; hover shows all of it. */}
      <TooltipFor label={openLabel} align="end">
        <button
          type="button"
          onClick={() => onOpenFile(step.path, step.line)}
          aria-label={openLabel}
          className="group/path inline-flex min-w-0 max-w-[50%] items-center gap-1.5 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <FileCode className="size-3.5 shrink-0" />
          <span className="flex min-w-0">
            {step.path.includes("/") && (
              <span className="min-w-0 truncate text-muted-foreground/60 group-hover/path:text-muted-foreground">
                {step.path.slice(0, step.path.lastIndexOf("/") + 1)}
              </span>
            )}
            <span className="shrink-0">
              {step.path.split("/").pop()}:{step.line}
              {step.endLine ? `-${step.endLine}` : ""}
            </span>
          </span>
        </button>
      </TooltipFor>
      {onDismiss && (
        <IconButton
          label="Dismiss this stop"
          icon={X}
          size="icon-xs"
          onClick={onDismiss}
          className="shrink-0 text-muted-foreground/60 hover:text-foreground"
        />
      )}
    </div>
  );
}
