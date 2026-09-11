import { parsePatch } from "@/lib/diff";
import type { ReviewLocation } from "@/lib/review-context";
import type { PullFile } from "@/lib/tauri";

/**
 * Reviewer-attached context for an AI chat turn: a snippet dragged out of the
 * diff, or a whole file picked with `@`. These ride along with the question as
 * a "# Focused context" block so the model knows exactly what's being asked
 * about, instead of guessing from the whole-PR diff.
 *
 * A `PrContextRef` is an *attachment*, not a place: it carries a side, a range
 * and captured code because the model needs all three. Where the reviewer is
 * *looking* is `ReviewLocation` (`@/lib/review-context`), which is deliberately
 * just a path and a line. The two meet at `refLocation` below — one canonical
 * location type, projected onto from here, rather than a second one defined
 * alongside it.
 */

export type ContextSide = "LEFT" | "RIGHT";

export interface PrContextRef {
  /** Stable identity — React key, dedupe, and removal all go through this. */
  id: string;
  kind: "file" | "snippet";
  path: string;
  /** Snippet only. RIGHT = new-file line numbers, LEFT = old-file. */
  side?: ContextSide;
  from?: number;
  to?: number;
  /**
   * Snippet text captured at attach time. Deliberately NOT persisted (the
   * store strips it) — at send time it's re-derived from the PR's patch, which
   * keeps the sqlite row small and the snippet honest about the current diff.
   * Only survives in-memory, and as a fallback for ranges the patch can't
   * reproduce (expanded-context rows).
   */
  code?: string;
}

/** Shape the composer's `@` autocomplete consumes (see ui/textarea.tsx). */
export interface PathMatch {
  id: string;
  label: string;
  hint?: string;
}

/** Per-snippet / per-file caps, and the ceiling for the whole focused block. */
const SNIPPET_CHARS = 6_000;
const FILE_CHARS = 8_000;
const FOCUS_BUDGET = 12_000;
const MAX_SNIPPET_LINES = 400;
/** Unchanged lines shown either side of an attached range, for orientation. */
const CTX = 3;

/* ───────────────────── refs ───────────────────── */

export function refFromLines(
  path: string,
  side: ContextSide,
  from: number,
  to: number,
  code?: string,
): PrContextRef {
  return {
    id: `snippet:${path}:${side}:${from}-${to}`,
    kind: "snippet",
    path,
    side,
    from,
    to,
    code,
  };
}

export function refForFile(path: string): PrContextRef {
  return { id: `file:${path}`, kind: "file", path };
}

/**
 * Project an attachment onto the place it points at, for handing to the review
 * context pane.
 *
 * A whole-file ref has no line, and a snippet anchors on the first line of its
 * range: the pane shows the file from the top of the region the reviewer picked
 * out, which is where they were already reading. The `side` is dropped on
 * purpose — the pane renders the file at the PR head, where LEFT line numbers
 * don't address anything.
 */
export function refLocation(ref: PrContextRef): ReviewLocation {
  if (ref.kind === "file" || ref.side === "LEFT") return { path: ref.path };
  return ref.from != null ? { path: ref.path, line: ref.from } : { path: ref.path };
}

/** `foo.ts:120-134`, `foo.ts:120`, or plain `foo.ts` for a whole-file ref. */
export function refLabel(ref: PrContextRef): string {
  const base = ref.path.split("/").pop() || ref.path;
  if (ref.kind === "file" || ref.from == null) return base;
  return ref.to != null && ref.to !== ref.from
    ? `${base}:${ref.from}-${ref.to}`
    : `${base}:${ref.from}`;
}

/**
 * Compact echo of the attachments, prepended to the persisted user message.
 * The store holds no code, so without this a reloaded transcript would read as
 * a context-free question — and this same text is what feeds `# Conversation`
 * on later turns, keeping the model oriented after the focused block is gone.
 */
export function echoRefs(refs: PrContextRef[]): string {
  return refs.map((r) => `> 📎 \`${refPathLabel(r)}\``).join("\n");
}

/** Full-path variant of `refLabel`, for the prompt and the transcript echo. */
function refPathLabel(ref: PrContextRef): string {
  if (ref.kind === "file" || ref.from == null) return ref.path;
  return ref.to != null && ref.to !== ref.from
    ? `${ref.path}:${ref.from}-${ref.to}`
    : `${ref.path}:${ref.from}`;
}

/* ───────────────────── DOM selection → ref ───────────────────── */

function rowOf(node: Node | null): HTMLElement | null {
  let el: Node | null = node;
  while (el && el.nodeType !== Node.ELEMENT_NODE) el = el.parentNode;
  return (el as Element | null)?.closest<HTMLElement>("[data-diff-row]") ?? null;
}

function num(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** True when the selection covers some non-blank *code* on this row.
 *
 * Measured against the row's <pre>, not the row: `Range.toString()` ignores
 * `user-select: none`, so the gutter's line numbers would otherwise count as
 * selected text and a drag that merely stops at a row's left edge would claim
 * that whole line. */
function hasSelectedText(range: Range, row: HTMLElement): boolean {
  const rowRange = document.createRange();
  rowRange.selectNodeContents(row.querySelector("pre") ?? row);
  const clamped = range.cloneRange();
  try {
    if (clamped.compareBoundaryPoints(Range.START_TO_START, rowRange) < 0) {
      clamped.setStart(rowRange.startContainer, rowRange.startOffset);
    }
    if (clamped.compareBoundaryPoints(Range.END_TO_END, rowRange) > 0) {
      clamped.setEnd(rowRange.endContainer, rowRange.endOffset);
    }
  } catch {
    return false;
  }
  return !clamped.collapsed && clamped.toString().trim().length > 0;
}

/**
 * Map a text selection inside a rendered diff back to a file + line range.
 *
 * Reads the `data-diff-row` / `data-side` / `data-new-line` / `data-old-line`
 * attributes rather than the selected *text*, which is contaminated by syntax
 * highlighting, word-diff spans and the whitespace badge — and, in split view,
 * by the other column entirely.
 */
export function refFromSelection(
  root: HTMLElement,
  path: string,
  view: "unified" | "split",
  sel: Selection | null,
): PrContextRef | null {
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  if (!root.contains(sel.anchorNode) && !root.contains(sel.focusNode)) return null;
  const range = sel.getRangeAt(0);

  let touched = Array.from(root.querySelectorAll<HTMLElement>("[data-diff-row]")).filter((r) =>
    sel.containsNode(r, true),
  );

  if (view === "split") {
    // The split grid interleaves LEFT/RIGHT halves per row in DOM order, so a
    // drag down one column "contains" every half of every row it passes. The
    // endpoints are what actually say which column the reviewer dragged in.
    const startSide = rowOf(range.startContainer)?.dataset.side;
    const endSide = rowOf(range.endContainer)?.dataset.side;
    const side = startSide && startSide === endSide ? startSide : "RIGHT";
    touched = touched.filter((r) => r.dataset.side === side);
  }

  // Drop endpoint rows the selection only grazes (a drag that stops exactly on
  // a row boundary otherwise picks up a phantom extra line).
  while (touched.length > 1 && !hasSelectedText(range, touched[0])) touched.shift();
  while (touched.length > 1 && !hasSelectedText(range, touched[touched.length - 1])) touched.pop();
  if (touched.length === 0) return null;

  const attr = view === "split" && touched[0].dataset.side === "LEFT" ? "oldLine" : "newLine";
  let side: ContextSide = attr === "oldLine" ? "LEFT" : "RIGHT";
  let nums = touched.map((r) => num(r.dataset[attr])).filter((n): n is number => n != null);

  // Unified: a pure-deletion selection has no new-file lines to bound with, so
  // fall back to old-file numbering. (A mixed selection keeps new-file bounds;
  // the deleted lines still show up in the snippet, they just don't move them.)
  if (nums.length === 0 && attr === "newLine") {
    side = "LEFT";
    nums = touched.map((r) => num(r.dataset.oldLine)).filter((n): n is number => n != null);
  }
  if (nums.length === 0) return null;

  return refFromLines(path, side, Math.min(...nums), Math.max(...nums));
}

/* ───────────────────── snippet text ───────────────────── */

function prefixFor(kind: string): string {
  if (kind === "add") return "+";
  if (kind === "del") return "-";
  return " ";
}

/**
 * Render the attached range as a small diff excerpt, built from the parsed
 * patch (never from the DOM). Falls back to the HEAD file content for ranges
 * that only exist because the reviewer expanded a context gap, and says so
 * plainly when the range isn't reachable at all.
 */
export function buildSnippet(
  patch: string | null | undefined,
  side: ContextSide,
  from: number,
  to: number,
  fileLines?: string[],
): string {
  // Keep each row's hunk index: the context padding must not spill into a
  // neighbouring hunk, whose lines are unrelated code from elsewhere in the file.
  const rows = parsePatch(patch).flatMap((h, hunk) =>
    h.lines.filter((l) => l.kind !== "hunk").map((line) => ({ line, hunk })),
  );
  const inRange = ({ line: l }: (typeof rows)[number]) => {
    const n = side === "RIGHT" ? l.newLine : l.oldLine;
    return n != null && n >= from && n <= to;
  };

  const first = rows.findIndex(inRange);
  let last = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (inRange(rows[i])) {
      last = i;
      break;
    }
  }

  if (first < 0) {
    // Not in any hunk — this is an expanded-context range, whose rows come from
    // the HEAD file content rather than the patch.
    if (side === "RIGHT" && fileLines && from >= 1 && from <= fileLines.length) {
      const slice = fileLines.slice(from - 1, Math.min(to, fileLines.length));
      return cap(slice.map((t, i) => ` ${from + i}\t${t}`).join("\n"));
    }
    return "(this range isn't present in the file's diff)";
  }

  let lo = first;
  while (lo > 0 && first - lo < CTX && rows[lo - 1].hunk === rows[first].hunk) lo--;
  let hi = last;
  while (hi < rows.length - 1 && hi - last < CTX && rows[hi + 1].hunk === rows[last].hunk) hi++;

  const out: string[] = [];
  let prev: number | null = null;
  for (const { line: l } of rows.slice(lo, hi + 1)) {
    const n = l.newLine ?? l.oldLine;
    // Hunk boundaries leave a gap in the numbering — mark it rather than
    // implying the lines are adjacent.
    if (prev != null && n != null && n > prev + 1) out.push("…");
    if (n != null) prev = n;
    out.push(`${prefixFor(l.kind)}${n ?? ""}\t${l.text}`);
    if (out.length >= MAX_SNIPPET_LINES) {
      out.push("… (truncated)");
      break;
    }
  }
  return cap(out.join("\n"));
}

function cap(text: string, limit = SNIPPET_CHARS): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… (truncated)`;
}

/* ───────────────────── prompt block ───────────────────── */

/**
 * The `# Focused context` section, prepended to the chat prompt. The whole-PR
 * context still follows it in full — this only tells the model where to look
 * first.
 */
export function buildFocusedContext(refs: PrContextRef[], files: PullFile[]): string {
  if (refs.length === 0) return "";
  const blocks: string[] = [];
  let budget = FOCUS_BUDGET;
  let dropped = 0;

  for (const ref of refs) {
    const file = files.find((f) => f.filename === ref.path);
    let body: string;
    let heading: string;
    if (ref.kind === "file") {
      heading = `## ${ref.path} (whole file)`;
      // Worth repeating even though it's in the PR diff below: that diff is
      // budget-bounded, so this exact file may have been truncated there.
      body = file?.patch ? cap(file.patch, FILE_CHARS) : "(no textual diff for this file)";
    } else {
      const label = ref.side === "LEFT" ? "old file" : "new file";
      heading = `## ${refPathLabel(ref)} (${label} lines)`;
      body = buildSnippet(file?.patch, ref.side ?? "RIGHT", ref.from ?? 0, ref.to ?? 0);
      // Re-derivation failed (an expanded-context range isn't in the patch) —
      // fall back to whatever was captured when the reviewer attached it.
      if (ref.code && body.startsWith("(this range isn't present")) body = ref.code;
    }
    const block = `${heading}\n\`\`\`diff\n${body}\n\`\`\``;
    if (block.length > budget) {
      dropped++;
      continue;
    }
    budget -= block.length;
    blocks.push(block);
  }

  const note = dropped > 0 ? `\n\n(${dropped} attachment(s) omitted for length.)` : "";
  const head =
    "# Focused context\nThe reviewer explicitly attached the region(s) below. Anchor your answer here — the full PR diff further down is background only.";
  return `${head}\n\n${blocks.join("\n\n")}${note}`;
}

/* ───────────────────── `@` path search ───────────────────── */

/**
 * Rank the PR's changed files for the composer's `@` autocomplete: basename
 * prefix beats basename substring beats path substring. Mirrors `searchEmoji`.
 */
export function searchPaths(files: PullFile[], query: string, limit = 8): PathMatch[] {
  const toItem = (f: PullFile): PathMatch => {
    const i = f.filename.lastIndexOf("/");
    return {
      id: f.filename,
      label: i < 0 ? f.filename : f.filename.slice(i + 1),
      hint: i < 0 ? undefined : f.filename.slice(0, i),
    };
  };
  const q = query.toLowerCase();
  if (!q) return files.slice(0, limit).map(toItem);

  const prefix: PathMatch[] = [];
  const sub: PathMatch[] = [];
  const pathSub: PathMatch[] = [];
  for (const f of files) {
    const item = toItem(f);
    const base = item.label.toLowerCase();
    if (base.startsWith(q)) prefix.push(item);
    else if (base.includes(q)) sub.push(item);
    else if (f.filename.toLowerCase().includes(q)) pathSub.push(item);
  }
  return [...prefix, ...sub, ...pathSub].slice(0, limit);
}
