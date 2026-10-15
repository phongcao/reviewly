import { detectLanguage, highlightLine } from "@/lib/lang";
import { cn } from "@/lib/utils";
import { useEffect, useRef } from "react";

/**
 * Read-only, line-numbered source renderer. Presentational only — callers fetch
 * the text however suits them (`read_file` from a clone, `gh_get_file_content`
 * from the PR head) and hand it over.
 *
 * Split out of the repo browser's `CodeView` so the review context pane can
 * show a file beside the diff without a second, subtly-different renderer —
 * the same reason `PatchView` is shared by Changes and History.
 */
export function SourceView({
  path,
  content,
  anchorLine,
  anchorNonce,
  highlightLines,
  className,
}: {
  path: string;
  content: string;
  /** 1-based line to scroll to and mark, if any. */
  anchorLine?: number | null;
  /** Bump to re-run the scroll when the same line is requested again. */
  anchorNonce?: number;
  /** 1-based lines to tint — e.g. the ranges this PR touched. */
  highlightLines?: Set<number>;
  className?: string;
}) {
  const lang = detectLanguage(path);
  const lines = content.split("\n");
  const rootRef = useRef<HTMLDivElement>(null);

  // Defer a frame so the rows exist before we scroll to one of them.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on nonce even when the line repeats
  useEffect(() => {
    if (anchorLine == null) return;
    const raf = requestAnimationFrame(() => {
      rootRef.current
        ?.querySelector<HTMLElement>(`[data-src-line="${anchorLine}"]`)
        ?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(raf);
  }, [anchorLine, anchorNonce, path]);

  return (
    <div
      ref={rootRef}
      className={cn("overflow-x-auto py-2 font-mono text-xs leading-[1.5]", className)}
    >
      {lines.map((l, i) => {
        const n = i + 1;
        const touched = highlightLines?.has(n);
        return (
          <div
            key={n}
            data-src-line={n}
            className={cn(
              "flex",
              touched && "bg-success/[0.07]",
              anchorLine === n && "bg-primary/15",
            )}
          >
            <span className="w-12 shrink-0 select-none bg-foreground/[0.02] px-2 text-right text-muted-foreground/75 tabular-nums">
              {n}
            </span>
            <pre
              className="min-w-0 flex-1 whitespace-pre-wrap break-words pr-4 text-foreground/90"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: Prism-highlighted
              dangerouslySetInnerHTML={{ __html: highlightLine(l, lang) || "&nbsp;" }}
            />
          </div>
        );
      })}
    </div>
  );
}
