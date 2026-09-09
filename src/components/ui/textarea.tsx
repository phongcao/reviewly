"use client";

import { getCaretCoordinates } from "@/lib/caret";
import { type EmojiMatch, searchEmoji } from "@/lib/emoji";
import { cn } from "@/lib/utils";
import * as React from "react";
import { createPortal } from "react-dom";

/** One row of the `@` autocomplete (e.g. a changed file in the PR). */
export interface MentionItem {
  id: string;
  label: string;
  hint?: string;
}

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  /** Accepted for compat with coss/ui input-group; ignored here. */
  unstyled?: boolean;
  /** Disable the `:shortcode:` emoji autocomplete (on by default). */
  noEmoji?: boolean;
  /**
   * Enable an `@`-triggered autocomplete. `onPick` returns the literal text to
   * splice in place of the `@token` — return nothing to just remove it (the
   * caller is presumably showing the picked item some other way, e.g. a chip).
   */
  mentions?: {
    search: (query: string) => MentionItem[];
    onPick: (item: MentionItem) => string | void;
  };
};

/** A trigger char immediately after start/whitespace, plus its query. */
function detectToken(
  value: string,
  caret: number,
  re: RegExp,
): { query: string; from: number } | null {
  const m = value.slice(0, caret).match(re);
  if (!m) return null;
  const query = m[2];
  return { query, from: caret - query.length - 1 };
}

/** `:` then ≥1 shortcode char. */
const EMOJI_RE = /(?:^|[\s(])(:)([a-z0-9_+]+)$/i;
/** `@` then any run of non-space, non-`@` chars — `*` so a bare `@` opens the
 *  list, and the class admits `/`, `.` and `-` so file paths work. */
const MENTION_RE = /(?:^|[\s(])(@)([^\s@]*)$/;

/** Set a controlled textarea's value so React's onChange fires (native setter). */
function setNativeValue(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

type Popup =
  | { kind: "emoji"; items: EmojiMatch[] }
  | { kind: "mention"; items: MentionItem[] }
  | null;

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  (
    { className, unstyled: _unstyled, noEmoji, mentions, onChange, onKeyDown, onBlur, ...props },
    ref,
  ) => {
    const innerRef = React.useRef<HTMLTextAreaElement | null>(null);
    const setRefs = (el: HTMLTextAreaElement | null) => {
      innerRef.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    };

    const [popup, setPopup] = React.useState<Popup>(null);
    const [active, setActive] = React.useState(0);
    const [pos, setPos] = React.useState<{ x: number; y: number } | null>(null);
    const fromRef = React.useRef(0);
    const open = pos !== null && popup !== null && popup.items.length > 0;

    const close = () => setPos(null);

    // The popup is fixed-positioned at coordinates captured when it opened; a
    // window scroll or resize invalidates them, so dismiss it rather than let it
    // float in the wrong place. (Capture phase catches scrolls on any ancestor.)
    React.useEffect(() => {
      if (pos === null) return;
      const onMove = () => setPos(null);
      window.addEventListener("scroll", onMove, true);
      window.addEventListener("resize", onMove);
      return () => {
        window.removeEventListener("scroll", onMove, true);
        window.removeEventListener("resize", onMove);
      };
    }, [pos]);

    function refresh(el: HTMLTextAreaElement) {
      const caret = el.selectionStart ?? el.value.length;

      // Mentions take precedence; the two triggers can never both match, so at
      // most one popup is ever open.
      let next: Popup = null;
      let from = 0;
      const mention = mentions ? detectToken(el.value, caret, MENTION_RE) : null;
      if (mention) {
        next = { kind: "mention", items: mentions?.search(mention.query) ?? [] };
        from = mention.from;
      } else if (!noEmoji) {
        const emoji = detectToken(el.value, caret, EMOJI_RE);
        if (emoji) {
          next = { kind: "emoji", items: searchEmoji(emoji.query) };
          from = emoji.from;
        }
      }

      if (!next || next.items.length === 0) {
        close();
        return;
      }
      fromRef.current = from;
      setPopup(next);
      setActive(0);
      const c = getCaretCoordinates(el, caret);
      const rect = el.getBoundingClientRect();
      setPos({
        x: rect.left + c.left - el.scrollLeft,
        y: rect.top + c.top - el.scrollTop + c.height + 4,
      });
    }

    function pick(index: number) {
      const el = innerRef.current;
      if (!el || !popup) return;
      const item = popup.items[index];
      if (!item) return;
      const caret = el.selectionStart ?? el.value.length;
      const insert =
        popup.kind === "emoji"
          ? `${(item as EmojiMatch).char} `
          : (mentions?.onPick(item as MentionItem) ?? "");
      const next = el.value.slice(0, fromRef.current) + insert + el.value.slice(caret);
      setNativeValue(el, next);
      const at = fromRef.current + insert.length;
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(at, at);
      });
      close();
    }

    function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
      if (open && popup) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setActive((i) => (i + 1) % popup.items.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setActive((i) => (i - 1 + popup.items.length) % popup.items.length);
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          e.stopPropagation();
          pick(active);
          // IMPORTANT: return without calling `onKeyDown` — that early exit is
          // what stops the AI chat composer (Enter = send) from firing off a
          // message when the user meant to pick a completion. stopPropagation
          // alone would NOT do it: both handlers sit on this same element.
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          close();
          return;
        }
        // Caret-moving keys leave the value unchanged (so `refresh` won't fire),
        // but move the caret away from the token — close so the popup can't
        // linger detached from the token it was anchored to.
        if (
          e.key === "ArrowLeft" ||
          e.key === "ArrowRight" ||
          e.key === "Home" ||
          e.key === "End"
        ) {
          close();
          // fall through so the textarea still handles the caret move
        }
      }
      onKeyDown?.(e);
    }

    function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
      onChange?.(e);
      refresh(e.currentTarget);
    }

    return (
      <>
        <textarea
          ref={setRefs}
          className={cn(
            "flex min-h-20 w-full rounded-lg border border-input bg-background dark:bg-input/32 px-3.5 py-2.5 text-sm font-mono shadow-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/24 disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onBlur={(e) => {
            close();
            onBlur?.(e);
          }}
          {...props}
        />
        {open &&
          pos &&
          popup &&
          createPortal(
            // biome-ignore lint/a11y/useKeyWithMouseEvents: keyboard handled on the textarea
            <div
              className={cn(
                "fixed z-[100] max-h-60 overflow-y-auto rounded-lg border border-border/60 bg-popover/95 p-1 text-sm shadow-xl backdrop-blur-xl",
                popup.kind === "mention" ? "w-80" : "w-56",
              )}
              style={{ left: pos.x, top: pos.y }}
              onMouseDown={(e) => e.preventDefault()}
            >
              {popup.items.map((item, i) => (
                <button
                  key={popup.kind === "emoji" ? (item as EmojiMatch).shortcode : (item as MentionItem).id}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(i);
                  }}
                  onMouseEnter={() => setActive(i)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left",
                    i === active ? "bg-primary/15 text-foreground" : "text-muted-foreground",
                  )}
                >
                  {popup.kind === "emoji" ? (
                    <>
                      <span className="text-base leading-none">{(item as EmojiMatch).char}</span>
                      <span className="truncate font-mono text-xs">
                        :{(item as EmojiMatch).shortcode}:
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="shrink-0 truncate font-mono text-xs text-foreground">
                        {(item as MentionItem).label}
                      </span>
                      {(item as MentionItem).hint && (
                        <span
                          dir="rtl"
                          className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-muted-foreground/60"
                        >
                          {(item as MentionItem).hint}
                        </span>
                      )}
                    </>
                  )}
                </button>
              ))}
            </div>,
            document.body,
          )}
      </>
    );
  },
);
Textarea.displayName = "Textarea";

export { Textarea };
