import {
  type ContextHistory,
  EMPTY_HISTORY,
  type ReviewLocation,
  goBack,
  goForward,
  pushLocation,
} from "@/lib/review-context";
import { sqlStorage } from "@/lib/sql-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * State for the review context pane — the third pane that shows surrounding
 * code beside the diff.
 *
 * Only `open` is persisted: whether the reviewer likes the pane is a lasting
 * preference, but *where they were peeking* is scratch navigation that
 * shouldn't outlive the session or follow them to another PR. Nothing here
 * touches the viewed-files store, which is the point — reading a dependency
 * must never count as reviewing a change.
 */
interface State {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  /** Navigation history per PR key (`owner/repo#number`). In-memory. */
  byPr: Record<string, ContextHistory>;
  historyFor: (prKey: string) => ContextHistory;
  /** Open a location, and reveal the pane if it was closed. */
  navigate: (prKey: string, loc: ReviewLocation) => void;
  back: (prKey: string) => void;
  forward: (prKey: string) => void;
  reset: (prKey: string) => void;
}

export const useReviewContext = create<State>()(
  persist(
    (set, get) => ({
      open: false,
      setOpen: (open) => set({ open }),
      toggle: () => set({ open: !get().open }),
      byPr: {},
      historyFor: (prKey) => get().byPr[prKey] ?? EMPTY_HISTORY,
      navigate: (prKey, loc) => {
        const next = pushLocation(get().byPr[prKey] ?? EMPTY_HISTORY, loc);
        set({ open: true, byPr: { ...get().byPr, [prKey]: next } });
      },
      back: (prKey) =>
        set({ byPr: { ...get().byPr, [prKey]: goBack(get().byPr[prKey] ?? EMPTY_HISTORY) } }),
      forward: (prKey) =>
        set({ byPr: { ...get().byPr, [prKey]: goForward(get().byPr[prKey] ?? EMPTY_HISTORY) } }),
      reset: (prKey) => {
        const rest = { ...get().byPr };
        delete rest[prKey];
        set({ byPr: rest });
      },
    }),
    {
      name: "reviewly.review-context",
      storage: sqlStorage<Pick<State, "open">>(),
      partialize: (s) => ({ open: s.open }),
    },
  ),
);
