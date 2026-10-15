import { useCallback, useRef } from "react";

/**
 * A callback with a permanent identity that always invokes the latest version
 * handed to it.
 *
 * Load-bearing for the tours' memoized stops, and the reason is worth stating:
 * a tour of this size only stays responsive if moving the cursor re-renders the
 * two stops whose appearance actually changed rather than all of them. But
 * nearly every handler a stop receives is rebuilt on a cursor move anyway —
 * progress methods are recreated whenever read state changes, and the page's
 * own `onAddComment` / `onOpenFile` are inline arrows. Passing those straight
 * down would defeat `memo` on every single click. Wrapping them here decouples
 * "this handler does the newest thing" from "this prop changed".
 */
export function useEvent<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}
