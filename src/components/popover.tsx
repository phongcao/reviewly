import { cn } from "@/lib/utils";
import { Check, type LucideIcon } from "lucide-react";
import {
  type MouseEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

/**
 * The app's standard floating panel + click-outside backdrop. Use inside a
 * `relative` container, gated by your own `open` state:
 *   {open && <PopoverPanel onClose={() => setOpen(false)}>…</PopoverPanel>}
 * Canonical spacing/bg/shadow so every dropdown in the app matches.
 */
export function PopoverPanel({
  onClose,
  align = "right",
  side = "bottom",
  width = "w-64",
  className,
  children,
  portal = false,
}: {
  onClose: () => void;
  align?: "left" | "right";
  side?: "top" | "bottom";
  width?: string;
  className?: string;
  children: ReactNode;
  /**
   * Render the panel in a `document.body` portal with fixed positioning,
   * anchored to its trigger. Use when an ancestor would otherwise clip or
   * stack-trap the panel — e.g. a collapsing header with `overflow-hidden` +
   * a transform (the PR header's metadata row). Off by default so every other
   * dropdown keeps its simple in-flow `absolute` placement.
   */
  portal?: boolean;
}) {
  // Capture the trigger on open; restore focus to it when the panel closes so
  // keyboard users aren't dumped to the top of the page after any dropdown.
  const triggerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    triggerRef.current = document.activeElement as HTMLElement | null;
    return () => triggerRef.current?.focus?.();
  }, []);
  // Escape closes the panel — matches every other overlay in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Portal mode: a zero-size in-flow anchor lets us measure the trigger
  // container, then we position the floating panel with `fixed` coords and
  // keep them in sync on scroll/resize.
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [coords, setCoords] = useState<{
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
  } | null>(null);
  useLayoutEffect(() => {
    if (!portal) return;
    const place = () => {
      const host = anchorRef.current?.parentElement;
      if (!host) return;
      const r = host.getBoundingClientRect();
      setCoords({
        top: side === "bottom" ? r.bottom + 4 : undefined,
        bottom: side === "top" ? window.innerHeight - r.top + 4 : undefined,
        left: align === "left" ? r.left : undefined,
        right: align === "right" ? window.innerWidth - r.right : undefined,
      });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [portal, side, align]);

  const backdrop = (
    <button
      type="button"
      aria-hidden
      tabIndex={-1}
      onClick={onClose}
      className="fixed inset-0 cursor-default"
      style={portal ? { zIndex: 59 } : undefined}
    />
  );
  const panel = (
    <div
      className={cn(
        "rounded-lg border border-hairline bg-popover/90 p-2 shadow-xl backdrop-blur-xl",
        portal ? "fixed" : "absolute z-30",
        !portal && (side === "top" ? "bottom-full mb-1" : "top-full mt-1"),
        !portal && (align === "right" ? "right-0" : "left-0"),
        width,
        className,
      )}
      style={portal ? { zIndex: 60, ...coords } : undefined}
    >
      {children}
    </div>
  );

  if (portal) {
    return (
      <>
        <span ref={anchorRef} className="hidden" aria-hidden />
        {createPortal(
          <>
            {backdrop}
            {coords && panel}
          </>,
          document.body,
        )}
      </>
    );
  }

  return (
    <>
      <button
        type="button"
        aria-hidden
        tabIndex={-1}
        onClick={onClose}
        className="fixed inset-0 z-20 cursor-default"
      />
      {panel}
    </>
  );
}

/** A titled group inside a popover. */
export function PopoverSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="py-1">
      <p className="px-2 pb-0.5 text-2xs font-medium text-muted-foreground/60">{title}</p>
      {children}
    </div>
  );
}

/** A standard selectable row inside a popover/menu. */
export function PopoverItem({
  icon: Icon,
  checked,
  count,
  onClick,
  className,
  children,
}: {
  icon?: LucideIcon;
  /** Show a trailing check slot (true = checked, false = reserved space). */
  checked?: boolean;
  count?: number;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-foreground/[0.05]",
        className,
      )}
    >
      {Icon && <Icon className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.5} />}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {count != null && (
        <span className="shrink-0 tabular-nums text-muted-foreground">{count}</span>
      )}
      {checked != null && (
        <Check className={cn("size-3 shrink-0", checked ? "text-primary" : "opacity-0")} />
      )}
    </button>
  );
}

/**
 * A quiet "Filter" / "Display" style menu: a 28px trigger button (icon + label,
 * optional active count) that opens a `PopoverPanel`. Children may be a render
 * function receiving `close` so items can dismiss the menu.
 */
export function Menu({
  label,
  icon: Icon,
  count = 0,
  width = "w-64",
  align = "right",
  children,
}: {
  label: string;
  icon: LucideIcon;
  count?: number;
  width?: string;
  align?: "left" | "right";
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs transition-colors",
          count > 0 || open
            ? "bg-foreground/[0.06] text-foreground"
            : "text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground",
        )}
      >
        <Icon className="size-3.5" />
        {label}
        {count > 0 && (
          <span className="rounded-full bg-primary/20 px-1 text-3xs font-medium tabular-nums text-primary">
            {count}
          </span>
        )}
      </button>
      {open && (
        <PopoverPanel onClose={close} align={align} width={width}>
          {typeof children === "function" ? children(close) : children}
        </PopoverPanel>
      )}
    </div>
  );
}
