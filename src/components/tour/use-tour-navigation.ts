import { useEvent } from "@/components/tour/use-event";
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export interface TourNavigation {
  /** Original index of the stop the cursor is on. */
  active: number;
  setActive: Dispatch<SetStateAction<number>>;
  /** `active`'s position in `visible`; -1 while it is being re-snapped. */
  pos: number;
  atFirst: boolean;
  atLast: boolean;
  /** Step ±n through the visible stops, smooth-scrolling to the one landed on. */
  move: (delta: number) => void;
  /** Smooth-scroll to one stop and make it current. */
  jumpTo: (index: number) => void;
  /** The reading pane — the element that scrolls. */
  scrollRef: RefObject<HTMLDivElement>;
  /** Register a stop's section (its sticky header is what "current" tracks). */
  setStepRef: (index: number, el: HTMLElement | null) => void;
}

/**
 * The tour's cursor: which stop is current, how the reader moves between
 * stops, and keeping the two in step with the reading pane's scroll position.
 *
 * The current stop is exactly the one whose sticky header is pinned at the top
 * of the pane. Moving (keys, prev/next, a rail click) smooth-scrolls there and
 * holds the target until the scroll arrives, so the highlight doesn't flash
 * every stop it passes over.
 *
 * The effects below are declared in a deliberate order — snap, report,
 * keyboard, resume, sync — and React runs them in that order. Two outcomes
 * depend on it: dismissing the current stop lands on the NEXT one (snap moves
 * to the first visible stop, then sync, running after it, re-reads the pinned
 * header and wins), and resuming on mount holds the jump before sync first
 * measures a pane that still sits at the top.
 */
export function useTourNavigation({
  visible,
  initial,
  onActive,
  onOpen,
  onDismiss,
  keyboard = true,
  preserveBy,
}: {
  /** Original indices of the stops in view, in reading order. */
  visible: number[];
  /** Where to start (the resume point). Clamped by the caller. */
  initial: number;
  /** The cursor settled on a stop — persist it (mark seen, resume point). */
  onActive?: (index: number) => void;
  /** `o`: open the current stop's file. */
  onOpen?: (index: number) => void;
  /** `x`: dismiss the current stop. Without it the key does nothing. */
  onDismiss?: (index: number) => void;
  /** Listen for j/k/o/x/Enter/d on the window. */
  keyboard?: boolean;
  /**
   * Stable ids for every stop, by original index. For a tour whose list grows
   * while it is read: when a stop lands ABOVE the cursor, every index after it
   * shifts, and the stop being read would slide down out of view. With ids the
   * pane keeps the reader's stop where it was on screen and the cursor on it.
   */
  preserveBy?: string[];
}): TourNavigation {
  const [active, setActive] = useState(initial);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stepRefs = useRef<(HTMLElement | null)[]>([]);
  const setStepRef = useCallback((i: number, el: HTMLElement | null) => {
    stepRefs.current[i] = el;
  }, []);
  const report = useEvent((i: number) => onActive?.(i));
  const open = useEvent((i: number) => onOpen?.(i));
  const dismiss = useEvent((i: number) => onDismiss?.(i));
  const canDismiss = !!onDismiss;

  // While a programmatic jump (click a node / next / prev) is smooth-scrolling,
  // hold the chosen stop active until the scroll actually arrives — otherwise
  // the scroll listener reads the mid-animation position and briefly flashes
  // each stop it passes over (the "blink to the previous one").
  const jumpTargetRef = useRef<number | null>(null);
  const jumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const beginJump = useCallback((target: number) => {
    jumpTargetRef.current = target;
    if (jumpTimer.current) clearTimeout(jumpTimer.current);
    // Safety release: the scroll may never reach the very top (e.g. the last
    // stops), so don't hold the highlight hostage forever.
    jumpTimer.current = setTimeout(() => {
      jumpTargetRef.current = null;
    }, 1000);
  }, []);
  useEffect(
    () => () => {
      if (jumpTimer.current) clearTimeout(jumpTimer.current);
    },
    [],
  );

  // Move ±1 through the *visible* set (respects any filter the caller applies).
  const move = useCallback(
    (delta: number) => {
      setActive((a) => {
        const p = visible.indexOf(a);
        const curr = p < 0 ? 0 : p;
        const n = visible[Math.max(0, Math.min(visible.length - 1, curr + delta))] ?? a;
        beginJump(n);
        stepRefs.current[n]?.scrollIntoView({ behavior: "smooth", block: "start" });
        return n;
      });
    },
    [visible, beginJump],
  );

  // Where the reader's stop sat on screen at the last measurement, by id, so a
  // stop landing above it can be compensated for. Only kept with `preserveBy`.
  const ids = preserveBy;
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const anchorRef = useRef<{ id: string; offset: number } | null>(null);
  // A layout effect, so the correction lands before the browser paints the
  // shifted pane, and before the passive sync below re-reads the pinned header.
  useLayoutEffect(() => {
    const root = scrollRef.current;
    const a = anchorRef.current;
    if (!ids || !root || !a) return;
    const j = ids.indexOf(a.id);
    const el = j >= 0 ? stepRefs.current[j] : null;
    if (!el) return;
    const shift = el.getBoundingClientRect().top - root.getBoundingClientRect().top - a.offset;
    if (Math.abs(shift) > 1) root.scrollTop += shift;
    setActive(j);
  }, [ids]);

  // When a filter or a dismiss hides the active step, snap to the first
  // visible one.
  useEffect(() => {
    if (visible.length > 0 && !visible.includes(active)) setActive(visible[0]);
  }, [visible, active]);

  // Persist resume position + mark the visited step as seen.
  useEffect(() => {
    report(active);
  }, [active, report]);

  // Keyboard nav: j/↓ next, k/↑ prev, o open file, x dismiss, Enter/d next
  // undismissed stop. Ignored while typing.
  useEffect(() => {
    if (!keyboard) return;
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        move(1);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        move(-1);
      } else if (e.key === "o") {
        open(active);
      } else if (e.key === "x") {
        if (!canDismiss) return;
        // 81: dismiss the active stop; the effect on `visible` re-snaps to the
        // next remaining stop automatically.
        e.preventDefault();
        dismiss(active);
      } else if (e.key === "Enter" || e.key === "d") {
        // 81: advance to the next (undismissed) stop.
        e.preventDefault();
        move(1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keyboard, active, move, open, dismiss, canDismiss]);

  // Coming back to the tour (Back from a file a stop linked to, or the view
  // toggle) resumes on the stop you left. `active` is seeded from the resume
  // point, but the pane mounts scrolled to the top, and the scroll sync below
  // would otherwise read that as "on the first stop" and overwrite it. Runs
  // before that effect, so the jump is already held when it first measures.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on mount
  useEffect(() => {
    if (active === visible[0]) return;
    beginJump(active);
    stepRefs.current[active]?.scrollIntoView({ block: "start" });
  }, []);

  // The active (colored) step is exactly the one whose sticky header is pinned
  // at the top: the last visible section that has scrolled to/above the top
  // edge. This keeps the highlight in lock-step with the stuck header.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;

    // Small tolerance throughout so a jumped-to stop (which lands ~flush at the
    // top) still registers as current — a tight `<= 1` would snap back to the
    // previous stop after a click/next jump.
    const atTop = (i: number, top: number): boolean | null => {
      const el = stepRefs.current[i];
      if (!el) return null;
      return el.getBoundingClientRect().top - top <= 4;
    };

    // The last visible stop that has scrolled to/above the top edge.
    function stuck(top: number): number {
      let current = visible[0] ?? 0;
      for (const i of visible) {
        const above = atTop(i, top);
        if (above === null) continue;
        if (above) current = i;
        else break;
      }
      return current;
    }

    // Has a jump's smooth scroll ARRIVED at its target? Equivalent to
    // `stuck(top) === target` — the stops above the target are above it in the
    // document too, so they need no measuring — but it reads two rects instead
    // of one per stop passed over. On a 200-stop tour that is the difference
    // between two layout reads and two hundred, on every frame of the
    // animation, which is most of what made a click feel slow.
    function arrived(target: number, top: number): boolean {
      const pos = visible.indexOf(target);
      // A target the filter hid can never become the stuck stop, exactly as
      // under the full scan — hold until `beginJump`'s safety timer releases.
      if (pos < 0) return false;
      if (atTop(target, top) !== true) {
        // Nothing is pinned yet (the intro is still on screen). The scan's
        // default in that case is the first visible stop, so a jump to that one
        // has arrived; any other is still on its way.
        return target === visible[0];
      }
      for (let p = pos + 1; p < visible.length; p++) {
        const above = atTop(visible[p], top);
        if (above === null) continue;
        return !above;
      }
      return true; // nothing mounted below it — the target is as stuck as it gets
    }

    // Remember where the current stop sits, for `preserveBy`. Not while the
    // pane rests at the very top: nothing is being read yet, so a layer that
    // lands above should simply appear above.
    function anchor(i: number, top: number) {
      const id = idsRef.current?.[i];
      const el = stepRefs.current[i];
      if (!root || !id || !el || root.scrollTop <= 0) {
        anchorRef.current = null;
        return;
      }
      anchorRef.current = { id, offset: el.getBoundingClientRect().top - top };
    }

    function syncStuck() {
      if (!root) return;
      const top = root.getBoundingClientRect().top;
      // A jump is animating: hold the chosen stop until the scroll reaches it,
      // so we don't flash each stop it passes over on the way.
      const target = jumpTargetRef.current;
      if (target !== null) {
        if (!arrived(target, top)) return;
        jumpTargetRef.current = null;
        setActive(target);
        if (idsRef.current) anchor(target, top);
        return;
      }
      const current = stuck(top);
      setActive(current);
      if (idsRef.current) anchor(current, top);
    }

    // Coalesced to one measurement per frame. Scroll fires faster than that
    // during a smooth scroll, and every extra call is a forced layout against
    // the whole reading pane.
    let frame = 0;
    function onScroll() {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        syncStuck();
      });
    }

    syncStuck();
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      root.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [visible]);

  const jumpTo = useCallback(
    (i: number) => {
      beginJump(i);
      stepRefs.current[i]?.scrollIntoView({ behavior: "smooth", block: "start" });
      setActive(i);
    },
    [beginJump],
  );

  const pos = visible.indexOf(active);
  return {
    active,
    setActive,
    pos,
    atFirst: pos <= 0,
    atLast: pos >= visible.length - 1,
    move,
    jumpTo,
    scrollRef,
    setStepRef,
  };
}
