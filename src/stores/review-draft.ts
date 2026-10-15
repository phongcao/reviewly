import { sqlStorage } from "@/lib/sql-storage";
import type { DraftComment } from "@/lib/tauri";
import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface PRKey {
  owner: string;
  repo: string;
  number: number;
}

export function prKey(k: PRKey): string {
  return `${k.owner}/${k.repo}#${k.number}`;
}

/**
 * A pending inline comment. The `id` is local-only — it gives edit/remove a
 * stable handle (an array index shifts under a concurrent remove) and is
 * stripped before the review is submitted (see `toSubmittable`).
 */
export interface PendingComment extends DraftComment {
  id: string;
}

interface Draft {
  body: string;
  comments: PendingComment[];
  updatedAt: number;
}

interface ReviewDraftState {
  drafts: Record<string, Draft>;
  get: (k: PRKey) => Draft;
  setBody: (k: PRKey, body: string) => void;
  /** Adds a comment; one that already carries an `id` (an undo) keeps it. */
  addComment: (k: PRKey, c: DraftComment & { id?: string }) => void;
  updateComment: (k: PRKey, id: string, body: string) => void;
  removeComment: (k: PRKey, id: string) => void;
  clear: (k: PRKey) => void;
}

const empty = (): Draft => ({ body: "", comments: [], updatedAt: Date.now() });

const newId = (): string => crypto.randomUUID();

/** The comment as GitHub's create-review endpoint expects it — no local `id`. */
export function toSubmittable({ id: _id, ...c }: PendingComment): DraftComment {
  return c;
}

export const useReviewDraft = create<ReviewDraftState>()(
  persist(
    (set, get) => {
      /** Replace one draft's comments, bumping its `updatedAt`. */
      const setComments = (k: PRKey, fn: (cs: PendingComment[]) => PendingComment[]) => {
        const key = prKey(k);
        const cur = get().drafts[key] ?? empty();
        set({
          drafts: {
            ...get().drafts,
            [key]: { ...cur, comments: fn(cur.comments), updatedAt: Date.now() },
          },
        });
      };
      return {
        drafts: {},
        get: (k) => get().drafts[prKey(k)] ?? empty(),
        setBody: (k, body) => {
          const key = prKey(k);
          const cur = get().drafts[key] ?? empty();
          set({ drafts: { ...get().drafts, [key]: { ...cur, body, updatedAt: Date.now() } } });
        },
        addComment: (k, c) => setComments(k, (cs) => [...cs, { ...c, id: c.id ?? newId() }]),
        updateComment: (k, id, body) =>
          setComments(k, (cs) => cs.map((c) => (c.id === id ? { ...c, body } : c))),
        removeComment: (k, id) => setComments(k, (cs) => cs.filter((c) => c.id !== id)),
        clear: (k) => {
          const key = prKey(k);
          const rest = { ...get().drafts };
          delete rest[key];
          set({ drafts: rest });
        },
      };
    },
    {
      name: "reviewly.review-drafts",
      storage: sqlStorage<ReviewDraftState>(),
      // v0 stored comments without ids — give each one so it can be edited.
      version: 1,
      migrate: (persisted, version) => {
        const state = persisted as { drafts?: Record<string, Draft> };
        if (version < 1 && state?.drafts) {
          for (const d of Object.values(state.drafts)) {
            d.comments = (d.comments ?? []).map((c) => ({ ...c, id: c.id ?? newId() }));
          }
        }
        return state as ReviewDraftState;
      },
    },
  ),
);
