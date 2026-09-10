/**
 * Review context: the "peek without leaving the diff" navigation model.
 *
 * The reviewer is reading a changed file and needs to see something that isn't
 * in the diff — the definition a changed line calls, an untouched caller, a
 * test. Opening it must not disturb the diff: not the active file, not the
 * scroll position, and never the viewed-files progress, because reading a
 * dependency is not reviewing a change.
 *
 * Everything here is pure so the navigation semantics can be tested without a
 * store or a DOM. The store in `@/stores/review-context` is a thin wrapper.
 */

/** A place the reviewer can be looking at inside the context pane. */
export interface ReviewLocation {
  /** Repo-relative path, e.g. `src/lib/layers.ts`. */
  path: string;
  /** 1-based line to anchor on, when the caller knows one. */
  line?: number;
}

/** Browser-like history for one PR's context pane. */
export interface ContextHistory {
  entries: ReviewLocation[];
  /** Index of the entry currently shown; -1 when the history is empty. */
  index: number;
}

export const EMPTY_HISTORY: ContextHistory = { entries: [], index: -1 };

/** Cap so a long review can't grow the stack without bound. */
const MAX_ENTRIES = 50;

export function sameLocation(a: ReviewLocation | null, b: ReviewLocation | null): boolean {
  if (!a || !b) return a === b;
  return a.path === b.path && (a.line ?? null) === (b.line ?? null);
}

/** The entry currently in view, or null when nothing has been opened. */
export function currentLocation(h: ContextHistory): ReviewLocation | null {
  return h.index >= 0 && h.index < h.entries.length ? h.entries[h.index] : null;
}

export const canGoBack = (h: ContextHistory): boolean => h.index > 0;
export const canGoForward = (h: ContextHistory): boolean => h.index < h.entries.length - 1;

/**
 * Open a location, with browser semantics: navigating after going back discards
 * the forward entries, because that future no longer describes where the
 * reviewer has been.
 *
 * Re-opening what's already in view is a no-op rather than a duplicate entry —
 * otherwise `back` would appear to do nothing the first time it's pressed.
 */
export function pushLocation(h: ContextHistory, loc: ReviewLocation): ContextHistory {
  if (sameLocation(currentLocation(h), loc)) return h;
  const kept = h.entries.slice(0, h.index + 1);
  kept.push(loc);
  const overflow = Math.max(0, kept.length - MAX_ENTRIES);
  const entries = overflow > 0 ? kept.slice(overflow) : kept;
  return { entries, index: entries.length - 1 };
}

export function goBack(h: ContextHistory): ContextHistory {
  return canGoBack(h) ? { ...h, index: h.index - 1 } : h;
}

export function goForward(h: ContextHistory): ContextHistory {
  return canGoForward(h) ? { ...h, index: h.index + 1 } : h;
}

/**
 * Rank paths for the pane's file picker: basename prefix, then basename
 * substring, then anywhere in the path. Same ordering `searchPaths` uses for
 * the chat's `@` mentions, but over bare paths so it can serve both the PR's
 * changed files and a whole clone's `git ls-files`.
 */
export function rankPaths(paths: string[], query: string, limit = 20): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return paths.slice(0, limit);

  const prefix: string[] = [];
  const sub: string[] = [];
  const inPath: string[] = [];
  for (const p of paths) {
    const base = (p.split("/").pop() ?? p).toLowerCase();
    if (base.startsWith(q)) prefix.push(p);
    else if (base.includes(q)) sub.push(p);
    else if (p.toLowerCase().includes(q)) inPath.push(p);
    if (prefix.length >= limit) break;
  }
  return [...prefix, ...sub, ...inPath].slice(0, limit);
}
