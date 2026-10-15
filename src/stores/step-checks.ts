import type { CheckRecord } from "@/lib/claim-check";
import { sqlStorage } from "@/lib/sql-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";

/** stepId → the latest check on that stop. */
export type StepChecks = Record<string, CheckRecord>;

/**
 * The checks key: the subject plus the head commit they were run against.
 *
 * Keyed by head SHA on purpose. A check describes the code at one commit, and
 * after a push it describes code that may no longer exist — so a new head
 * starts with no checks rather than carrying verdicts on someone else's bytes.
 */
export const checksKey = (subject: string, headSha: string | undefined): string =>
  `${subject}@${headSha ?? ""}`;

/** Keep at most this many PR@head keys so the persisted kv row stays bounded. */
const MAX_ENTRIES = 40;

/** Newest check in an entry — what eviction orders by. */
const newest = (checks: StepChecks): number =>
  Object.values(checks).reduce((m, c) => Math.max(m, c.checkedAt), 0);

/** Drop the entries whose newest check is oldest once we exceed the cap. */
function evict(byKey: Record<string, StepChecks>): Record<string, StepChecks> {
  const keys = Object.keys(byKey);
  if (keys.length <= MAX_ENTRIES) return byKey;
  const keep = keys.sort((a, b) => newest(byKey[b]) - newest(byKey[a])).slice(0, MAX_ENTRIES);
  const next: Record<string, StepChecks> = {};
  for (const k of keep) next[k] = byKey[k];
  return next;
}

interface State {
  /** Checks keyed by `checksKey(prKey, headSha)`. */
  byKey: Record<string, StepChecks>;
  set: (key: string, stepId: string, record: CheckRecord) => void;
  /** Forget one stop's check — "Keep it" after a concern was cleared, or a re-check. */
  clear: (key: string, stepId: string) => void;
  /** Merge checks from an exported bundle. Per stop, the newer `checkedAt`
   * wins. Returns how many stop checks actually landed. */
  importEntries: (entries: Record<string, StepChecks>) => number;
  /** Drop every check under `key` whose stop id matches — a discarded tour's
   * stops. Returns what was removed, so an Undo can hand it back through
   * `importEntries`. */
  forget: (key: string, match: (stepId: string) => boolean) => StepChecks;
}

export const useStepChecks = create<State>()(
  persist(
    (set, get) => ({
      byKey: {},
      set: (key, stepId, record) =>
        set({
          byKey: evict({
            ...get().byKey,
            [key]: { ...get().byKey[key], [stepId]: record },
          }),
        }),
      clear: (key, stepId) => {
        const cur = get().byKey[key];
        if (!cur?.[stepId]) return;
        const next = { ...cur };
        delete next[stepId];
        set({ byKey: { ...get().byKey, [key]: next } });
      },
      forget: (key, match) => {
        const kept: StepChecks = {};
        const removed: StepChecks = {};
        for (const [id, v] of Object.entries(get().byKey[key] ?? {})) {
          (match(id) ? removed : kept)[id] = v;
        }
        if (Object.keys(removed).length > 0) set({ byKey: { ...get().byKey, [key]: kept } });
        return removed;
      },
      importEntries: (entries) => {
        const byKey = { ...get().byKey };
        let added = 0;
        for (const [key, checks] of Object.entries(entries)) {
          if (!checks || typeof checks !== "object") continue;
          const cur = { ...byKey[key] };
          let touched = false;
          for (const [id, record] of Object.entries(checks)) {
            if (!record || typeof record.checkedAt !== "number") continue;
            if (cur[id] && cur[id].checkedAt >= record.checkedAt) continue;
            cur[id] = record;
            touched = true;
            added++;
          }
          if (touched) byKey[key] = cur;
        }
        if (added > 0) set({ byKey: evict(byKey) });
        return added;
      },
    }),
    {
      name: "reviewly.step-checks",
      storage: sqlStorage<Pick<State, "byKey">>(),
      // Only the checks. This also drops the `confirmed` map that older builds
      // stored next to them.
      partialize: (s) => ({ byKey: s.byKey }),
    },
  ),
);

/** A "Check all" run in progress for one checks key. */
export interface CheckBatch {
  done: number;
  total: number;
  /** Set by the reviewer; the run stops pulling new stops once it sees this. */
  cancelled: boolean;
}

interface RunState {
  /** `${checksKey}|${stepId}` → a check is running for that stop. */
  inFlight: Record<string, true>;
  batch: Record<string, CheckBatch | undefined>;
  start: (runKey: string) => void;
  finish: (runKey: string) => void;
  setBatch: (key: string, batch: CheckBatch | undefined) => void;
}

/**
 * In-memory run state for checks. Separate from the persisted store because a
 * spinner must never survive a restart: the call that would clear it died with
 * the webview.
 */
export const useStepCheckRuns = create<RunState>((set) => ({
  inFlight: {},
  batch: {},
  start: (runKey) => set((s) => ({ inFlight: { ...s.inFlight, [runKey]: true } })),
  finish: (runKey) =>
    set((s) => {
      const next = { ...s.inFlight };
      delete next[runKey];
      return { inFlight: next };
    }),
  setBatch: (key, batch) => set((s) => ({ batch: { ...s.batch, [key]: batch } })),
}));

export const runKey = (key: string, stepId: string): string => `${key}|${stepId}`;
