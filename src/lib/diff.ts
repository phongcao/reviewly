import { type Change, diffArrays } from "diff";

/**
 * Tiny unified-diff parser. GitHub's `pulls/{n}/files` returns a `patch`
 * string with one or more hunks; we split it into typed lines that the
 * diff viewer can iterate over.
 */

export type LineKind = "context" | "add" | "del" | "hunk";

export interface DiffLine {
  kind: LineKind;
  oldLine: number | null;
  newLine: number | null;
  text: string;
  /**
   * Set on a context row synthesized by `ignoreLineEndings`: the del/add pair
   * it replaces differed only in its line terminator.
   */
  eolChange?: "crlf-to-lf" | "lf-to-crlf";
}

export interface Hunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export function parsePatch(patch: string | null | undefined): Hunk[] {
  if (!patch) return [];
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@")) {
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      const oldStart = m ? Number(m[1]) : 0;
      const newStart = m ? Number(m[2]) : 0;
      current = { header: raw, oldStart, newStart, lines: [] };
      current.lines.push({ kind: "hunk", oldLine: null, newLine: null, text: raw });
      hunks.push(current);
      oldLine = oldStart;
      newLine = newStart;
      continue;
    }
    if (!current) continue;
    if (raw.startsWith("+")) {
      current.lines.push({
        kind: "add",
        oldLine: null,
        newLine,
        text: raw.slice(1),
      });
      newLine++;
    } else if (raw.startsWith("-")) {
      current.lines.push({
        kind: "del",
        oldLine,
        newLine: null,
        text: raw.slice(1),
      });
      oldLine++;
    } else {
      // context (space prefix) or empty
      current.lines.push({
        kind: "context",
        oldLine,
        newLine,
        text: raw.startsWith(" ") ? raw.slice(1) : raw,
      });
      oldLine++;
      newLine++;
    }
  }

  return hunks;
}

/**
 * Group adjacent del/add lines into pairs for split view. Stand-alone
 * dels/adds become half-rows.
 */
export interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

export function toSplit(hunk: Hunk): SplitRow[] {
  const rows: SplitRow[] = [];
  const lines = hunk.lines;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.kind === "hunk") {
      rows.push({ left: l, right: l });
      i++;
      continue;
    }
    if (l.kind === "context") {
      rows.push({ left: l, right: l });
      i++;
      continue;
    }
    // collect a block of dels and adds
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].kind === "del") {
      dels.push(lines[i]);
      i++;
    }
    while (i < lines.length && lines[i].kind === "add") {
      adds.push(lines[i]);
      i++;
    }
    const max = Math.max(dels.length, adds.length);
    for (let j = 0; j < max; j++) {
      rows.push({ left: dels[j] ?? null, right: adds[j] ?? null });
    }
  }
  return rows;
}

/**
 * Split a `@@ … @@` header into its range, the new-file start line, and the
 * enclosing-symbol hint git appends.
 *
 * That suffix is git's own guess at the function or class containing the hunk —
 * free structure with no parser of our own. It is frequently EMPTY: git needs
 * preceding context matching a "function line" for the file's language, so a
 * newly added file (whose first hunk starts at line 1) almost never has one.
 * Callers must treat the symbol as a hint, never as a guarantee.
 */
export function parseHunkHeader(text: string): {
  range: string;
  symbol: string;
  newStart: number;
} {
  const m = text.match(/^(@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@)\s?(.*)$/);
  if (!m) return { range: text, symbol: "", newStart: 0 };
  return { range: m[1], symbol: m[3], newStart: Number(m[2]) };
}

/* ───────────────────── line endings ───────────────────── */

// GitHub's patch keeps a CRLF file's `\r` at the end of each line (we split on
// `\n` only), so converting a file between CRLF and LF rewrites every line —
// the whole file shows as deleted and re-added, burying any real edit.

const stripCr = (text: string) => (text.endsWith("\r") ? text.slice(0, -1) : text);

/** True when some deleted line comes back added with only its `\r` changed. */
export function hasLineEndingChanges(hunks: Hunk[]): boolean {
  for (const h of hunks) {
    const dels = new Set<string>();
    for (const l of h.lines) {
      if (l.kind === "del") dels.add(l.text);
      else if (l.kind === "add" && !dels.has(l.text)) {
        const other = l.text.endsWith("\r") ? stripCr(l.text) : `${l.text}\r`;
        if (dels.has(other)) return true;
      }
    }
  }
  return false;
}

/**
 * Re-diff each run of dels+adds with line terminators ignored, the way
 * `git diff --ignore-cr-at-eol` would. Lines that match once `\r` is stripped
 * become context rows (tagged `eolChange`) keeping both original line numbers,
 * and what remains is the real change. A proper line diff rather than
 * positional pairing, so an insertion inside a converted block doesn't shift
 * every pair after it out of alignment. Remaining lines lose their `\r` too,
 * so the word diff doesn't flag an invisible terminator.
 */
export function ignoreLineEndings(hunk: Hunk): Hunk {
  const out: DiffLine[] = [];
  const lines = hunk.lines;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind !== "del" && lines[i].kind !== "add") {
      out.push(lines[i]);
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].kind === "del") dels.push(lines[i++]);
    while (i < lines.length && lines[i].kind === "add") adds.push(lines[i++]);

    let d = 0;
    let a = 0;
    for (const part of diffArrays(
      dels.map((l) => stripCr(l.text)),
      adds.map((l) => stripCr(l.text)),
    )) {
      const n = part.count ?? part.value.length;
      for (let k = 0; k < n; k++) {
        if (part.removed) {
          const l = dels[d++];
          out.push({ ...l, text: stripCr(l.text) });
        } else if (part.added) {
          const l = adds[a++];
          out.push({ ...l, text: stripCr(l.text) });
        } else {
          const del = dels[d++];
          const add = adds[a++];
          out.push({
            kind: "context",
            oldLine: del.oldLine,
            newLine: add.newLine,
            text: stripCr(add.text),
            ...(del.text !== add.text && {
              eolChange: del.text.endsWith("\r") ? "crlf-to-lf" : "lf-to-crlf",
            }),
          });
        }
      }
    }
  }
  return { ...hunk, lines: out };
}

/* ───────────────────── word diff ───────────────────── */

/**
 * How much of a del/add pair survives a word diff: the non-whitespace
 * characters both sides share, over the longer side's. Whitespace is left out
 * so shared indentation alone can't make two unrelated lines look alike.
 * A pair with no non-whitespace content on either side counts as identical.
 */
export function sharedRatio(parts: Change[]): number {
  let shared = 0;
  let oldLen = 0;
  let newLen = 0;
  for (const part of parts) {
    const n = part.value.replace(/\s+/g, "").length;
    if (part.added) newLen += n;
    else if (part.removed) oldLen += n;
    else {
      shared += n;
      oldLen += n;
      newLen += n;
    }
  }
  const longest = Math.max(oldLen, newLen);
  return longest === 0 ? 1 : shared / longest;
}
