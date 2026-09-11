import { type PrContextRef, buildSnippet, refFromSelection, refLocation } from "@/lib/ai/attach";
import { attachContext } from "@/lib/ai/attach-bridge";
import type { ReviewLocation } from "@/lib/review-context";
import { PanelRight, Sparkles } from "lucide-react";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface Props {
  rootRef: RefObject<HTMLDivElement | null>;
  path: string;
  patch: string | null;
  view: "unified" | "split";
  /** Conversation key, `owner/repo#number`. */
  prKey: string;
  /** HEAD file content, so a range inside an expanded context gap still resolves. */
  fileLines?: string[];
  /** Opens (or focuses) the chat once something is attached. */
  onAskAi?: () => void;
  /** Opens the selected region in the review context pane. Omitted = no button. */
  onPeek?: (loc: ReviewLocation) => void;
}

/**
 * The "Ask AI" affordance for a text selection in the diff: drag over some
 * lines and this floats above them, pinning that exact file + range to the
 * chat composer.
 *
 * Deliberately NOT driven by `selectionchange` — `DiffFindBar` uses
 * `window.find`, which programmatically selects inside the diff, and would pop
 * this open on every Cmd+F hit. Root-scoped mouseup (plus shift+arrow keyup)
 * only fires for selections the reviewer actually made.
 */
export function DiffSelectionToolbar({
  rootRef,
  path,
  patch,
  view,
  prKey,
  fileLines,
  onAskAi,
  onPeek,
}: Props) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const refRef = useRef<PrContextRef | null>(null);

  const hide = useCallback(() => {
    refRef.current = null;
    setRect(null);
  }, []);

  const sync = useCallback(() => {
    const root = rootRef.current;
    const sel = window.getSelection();
    if (!root || !sel || sel.isCollapsed || sel.rangeCount === 0) {
      hide();
      return;
    }
    const ref = refFromSelection(root, path, view, sel);
    if (!ref) {
      hide();
      return;
    }
    refRef.current = ref;
    setRect(sel.getRangeAt(0).getBoundingClientRect());
  }, [rootRef, path, view, hide]);

  // Capture the selection after the browser has finalized it.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onUp = () => setTimeout(sync, 0);
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.shiftKey) setTimeout(sync, 0);
    };
    root.addEventListener("mouseup", onUp);
    root.addEventListener("keyup", onKeyUp);
    return () => {
      root.removeEventListener("mouseup", onUp);
      root.removeEventListener("keyup", onKeyUp);
    };
  }, [rootRef, sync]);

  // Switching files invalidates whatever was selected.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on file/layout change
  useEffect(() => hide(), [path, view, hide]);

  // A selection survives scrolling, so track it rather than dismissing (which
  // is what the caret-anchored autocomplete popup does).
  useEffect(() => {
    if (!rect) return;
    let raf = 0;
    const track = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
          hide();
          return;
        }
        const r = sel.getRangeAt(0).getBoundingClientRect();
        if (r.bottom < 0 || r.top > window.innerHeight) hide();
        else setRect(r);
      });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      window.getSelection()?.removeAllRanges();
      hide();
    };
    window.addEventListener("scroll", track, true);
    window.addEventListener("resize", track);
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", track, true);
      window.removeEventListener("resize", track);
      window.removeEventListener("keydown", onKey);
    };
  }, [rect, hide]);

  if (!rect || !refRef.current) return null;
  const ref = refRef.current;
  const label =
    ref.to != null && ref.from != null && ref.to !== ref.from
      ? `Lines ${ref.from}–${ref.to}`
      : `Line ${ref.from}`;

  // Width grew with the second action, so centre against a wider bar and keep
  // the whole thing on screen.
  const width = onPeek ? 216 : 128;
  const left = Math.min(
    Math.max(rect.left + rect.width / 2 - width / 2, 8),
    Math.max(8, window.innerWidth - width - 8),
  );
  const top = rect.top > 44 ? rect.top - 34 : rect.bottom + 8;

  const clear = () => {
    window.getSelection()?.removeAllRanges();
    hide();
  };

  return createPortal(
    <div
      // Without this the mousedown collapses the selection before either
      // onClick can read it.
      onMouseDown={(e) => e.preventDefault()}
      style={{ left, top }}
      className="fixed z-[60] flex items-center gap-0.5 rounded-lg border border-border/60 bg-popover/95 p-0.5 font-sans text-2xs font-medium text-foreground shadow-xl backdrop-blur-xl"
    >
      <button
        type="button"
        onClick={() => {
          attachContext(prKey, {
            ...ref,
            code: buildSnippet(patch, ref.side ?? "RIGHT", ref.from ?? 0, ref.to ?? 0, fileLines),
          });
          clear();
          onAskAi?.();
        }}
        className="flex items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors hover:bg-primary/15"
      >
        <Sparkles className="size-3 text-primary" />
        Ask AI
      </button>
      {onPeek && (
        <button
          type="button"
          onClick={() => {
            onPeek(refLocation(ref));
            clear();
          }}
          title="Read this file beside the diff — doesn't affect review progress"
          className="flex items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors hover:bg-primary/15"
        >
          <PanelRight className="size-3 text-primary" />
          Open in context
        </button>
      )}
      <span className="px-1 text-muted-foreground/60">{label}</span>
    </div>,
    document.body,
  );
}
