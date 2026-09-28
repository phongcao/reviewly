import type { DiffView } from "@/stores/ui";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Back / forward through where the reviewer has been on a PR's Files tab —
 * the tour, then a file a stop linked to, then another file… A location is the
 * view plus, outside the tour, the open file. Where *inside* it you were is not
 * recorded: the tour resumes on its last stop and each diff keeps its own
 * scroll offset, so returning to the view/file lands where you left it.
 */
export interface NavEntry {
  view: DiffView;
  /** The open file; ignored for the tour, which is one location. */
  file: string | null;
}

export interface NavState {
  /** What the history belongs to (the PR); a new scope starts it over. */
  scope: string;
  entries: NavEntry[];
  /** The entry the reviewer is on; -1 while empty. */
  index: number;
}

/** Bound the stack — a long session shouldn't grow it forever. */
export const NAV_CAP = 50;

/** Identity of a location. Unified ↔ split on one file is the same place. */
export function navKey(e: NavEntry): string {
  return e.view === "guided" ? "guided" : `file:${e.file ?? ""}`;
}

export function emptyNav(scope: string): NavState {
  return { scope, entries: [], index: -1 };
}

/**
 * The reviewer arrived at `entry`. Drops any forward history (like a browser),
 * collapses a repeat of the current location into it, and trims the oldest
 * entries past the cap.
 */
export function recordNav(state: NavState, entry: NavEntry): NavState {
  const cur = state.entries[state.index];
  if (cur && navKey(cur) === navKey(entry)) {
    // Same place, maybe a different layout — keep it current so going back
    // here restores split vs unified as it was last seen.
    if (cur.view === entry.view) return state;
    const entries = state.entries.slice();
    entries[state.index] = entry;
    return { ...state, entries };
  }
  const entries = [...state.entries.slice(0, state.index + 1), entry].slice(-NAV_CAP);
  return { ...state, entries, index: entries.length - 1 };
}

/** Move `delta` steps; null when there's nothing that way. */
export function stepNav(state: NavState, delta: number): NavState | null {
  const index = state.index + delta;
  if (index < 0 || index >= state.entries.length) return null;
  return { ...state, index };
}

/**
 * Track `location` into a history and expose back/forward. `apply` moves the
 * page to an entry; the location change that follows is recognized as the
 * move itself rather than recorded as a new visit. Pass a null location for
 * states that aren't a place (another tab, no file picked yet).
 */
export function useNavHistory(
  scope: string,
  location: NavEntry | null,
  apply: (entry: NavEntry) => void,
) {
  const [state, setState] = useState<NavState>(() => emptyNav(scope));
  // Key of the entry a back/forward is moving to, until the page gets there.
  const pending = useRef<string | null>(null);
  const key = location ? navKey(location) : null;
  const view = location?.view;
  const file = location?.file ?? null;

  useEffect(() => {
    if (!key || !view) return;
    const entry = { view, file };
    if (pending.current !== null) {
      const expected = pending.current;
      pending.current = null;
      // Landed where the move was headed; anything else (the file dropped out
      // of scope, say) is a real new place and gets recorded below.
      if (key === expected) {
        setState((s) => {
          const entries = s.entries.slice();
          entries[s.index] = entry;
          return { ...s, entries };
        });
        return;
      }
    }
    setState((s) => recordNav(s.scope === scope ? s : emptyNav(scope), entry));
  }, [scope, key, view, file]);

  // A stale scope (the page moved to another PR before its first location
  // landed) has nothing to go back to.
  const live = state.scope === scope;
  const canBack = live && state.index > 0;
  const canForward = live && state.index < state.entries.length - 1;

  const go = useCallback(
    (delta: number) => {
      if (state.scope !== scope) return;
      const next = stepNav(state, delta);
      if (!next) return;
      const entry = next.entries[next.index];
      pending.current = navKey(entry);
      setState(next);
      apply(entry);
    },
    [state, scope, apply],
  );

  return {
    canBack,
    canForward,
    back: useCallback(() => go(-1), [go]),
    forward: useCallback(() => go(1), [go]),
  };
}
