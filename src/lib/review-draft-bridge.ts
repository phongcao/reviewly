import { parsePatch } from "@/lib/diff";
import { type DraftComment, type PullFile, subscribe } from "@/lib/tauri";
import { type PRKey, useReviewDraft } from "@/stores/review-draft";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";

/**
 * Routes AI-drafted inline comments into the pending review.
 *
 * The main window owns the review draft: it renders the pending comments and
 * submits them. A detached chat window is a separate webview with its own
 * zustand instance, and `sqlStorage` only reads at hydration — so a comment it
 * added locally would be invisible in the main window, and its stale copy of
 * the store would later be persisted over the main window's newer drafts. The
 * chat window therefore never touches the draft store; it sends the addition
 * to the main window as a delta, which `useReviewDraftBridge` applies.
 */

const EVENT = "review-draft:add";

interface AddPayload {
  key: PRKey;
  /** An inline comment on a line in the diff. */
  comment?: DraftComment;
  /** A note appended to the review body (for a line GitHub can't anchor to). */
  note?: string;
}

/** True when `line` is in `path`'s diff on `side` (new file for RIGHT, old for
 * LEFT) — the only lines a review comment can anchor to; anything else 422s
 * the whole review submit. A file with no patch (a pure rename, binary, too
 * large) has no such lines. */
export function isCommentableLine(
  files: PullFile[],
  path: string,
  line: number,
  side: "LEFT" | "RIGHT" = "RIGHT",
): boolean {
  const target = files.find((f) => f.filename === path);
  return (
    !!target?.patch &&
    parsePatch(target.patch).some((h) =>
      h.lines.some((l) => l.kind !== "hunk" && (side === "LEFT" ? l.oldLine : l.newLine) === line),
    )
  );
}

/**
 * Whether GitHub will accept this pending comment in a review. A file missing
 * from `files` (not loaded yet) is given the benefit of the doubt, so an
 * unloaded file list never strips every comment from a submit.
 */
export function canAnchor(files: PullFile[], c: DraftComment): boolean {
  if (c.line == null || !files.some((f) => f.filename === c.path)) return true;
  const side = (s: string | null | undefined) => (s === "LEFT" ? "LEFT" : "RIGHT");
  return (
    isCommentableLine(files, c.path, c.line, side(c.side)) &&
    (c.start_line == null ||
      isCommentableLine(files, c.path, c.start_line, side(c.start_side ?? c.side)))
  );
}

/** A comment that can't sit on a line, as review-body text that keeps its location. */
export function locatedNote(c: { path: string; line?: number | null; body: string }): string {
  return `**${c.line == null ? c.path : `${c.path}:${c.line}`}**\n\n${c.body}`;
}

function isChatWindow(): boolean {
  try {
    return getCurrentWindow().label.startsWith("chat-");
  } catch {
    return false;
  }
}

function apply({ key, comment, note }: AddPayload): void {
  const draft = useReviewDraft.getState();
  if (comment) draft.addComment(key, comment);
  if (note) {
    const body = draft.get(key).body.trim();
    draft.setBody(key, body ? `${body}\n\n${note}` : note);
  }
}

/**
 * Add an inline comment to the pending review. A line outside the diff can't
 * carry one, so it lands in the review body instead (with its `path:line`), still
 * editable before submit. Resolves to where it went.
 */
export async function addToPendingReview(
  key: PRKey,
  files: PullFile[],
  c: { path: string; line: number; side: "LEFT" | "RIGHT"; body: string },
): Promise<"comment" | "body"> {
  const payload: AddPayload = isCommentableLine(files, c.path, c.line, c.side)
    ? { key, comment: { path: c.path, line: c.line, side: c.side, body: c.body } }
    : { key, note: locatedNote(c) };
  if (isChatWindow()) await emit(EVENT, payload);
  else apply(payload);
  return payload.comment ? "comment" : "body";
}

/** Mount once in the main window: applies additions sent by a detached chat. */
export function useReviewDraftBridge(): void {
  useEffect(() => {
    let unsub: (() => void) | undefined;
    (async () => {
      unsub = await subscribe<AddPayload>(EVENT, (e) => apply(e.payload));
    })();
    return () => unsub?.();
  }, []);
}
