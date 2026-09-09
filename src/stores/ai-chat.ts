import type { PrContextRef } from "@/lib/ai/attach";
import { sqlStorage } from "@/lib/sql-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** Keep at most this many PR conversations so the persisted row stays bounded. */
const MAX_CONVERSATIONS = 30;
/** Per-PR ceiling on attached context, so one question can't carry a whole PR. */
export const MAX_ATTACHMENTS = 8;

function evict<T>(byPr: Record<string, T>): Record<string, T> {
  const keys = Object.keys(byPr);
  if (keys.length <= MAX_CONVERSATIONS) return byPr;
  // Drop the oldest-inserted keys (object key order ≈ insertion order).
  const drop = keys.slice(0, keys.length - MAX_CONVERSATIONS);
  const next = { ...byPr };
  for (const k of drop) delete next[k];
  return next;
}

interface State {
  /** Conversations keyed by `${owner}/${repo}#${number}`. Persisted so a chat
   * isn't erased by a refresh or app restart. */
  byPr: Record<string, ChatMessage[]>;
  /** In-progress (unsent) composer text per PR, so a half-typed question
   * survives navigation/refresh. Persisted alongside the conversation. */
  drafts: Record<string, string>;
  /** Code the reviewer pinned to the *next* question (diff selection or `@`
   * mention). Same lifecycle as `drafts` — per PR, unsent, cleared on send. */
  attachments: Record<string, PrContextRef[]>;
  append: (key: string, msg: ChatMessage) => void;
  reset: (key: string) => void;
  /** Replace the whole transcript for a PR (used by Regenerate to rewind a turn). */
  setMessages: (key: string, msgs: ChatMessage[]) => void;
  /** Save (or clear, when empty) the unsent draft for a PR. */
  setDraft: (key: string, draft: string) => void;
  /** Pin a snippet/file. De-dupes by id and caps at MAX_ATTACHMENTS. */
  attach: (key: string, ref: PrContextRef) => void;
  removeAttachment: (key: string, id: string) => void;
  /** Replace the whole list — how the detached chat window syncs (attach-bridge). */
  setAttachments: (key: string, refs: PrContextRef[]) => void;
  clearAttachments: (key: string) => void;
}

export const useAiChat = create<State>()(
  persist(
    (set, get) => ({
      byPr: {},
      drafts: {},
      attachments: {},
      append: (key, msg) =>
        set({ byPr: evict({ ...get().byPr, [key]: [...(get().byPr[key] ?? []), msg] }) }),
      reset: (key) => {
        const next = { ...get().byPr };
        delete next[key];
        set({ byPr: next });
      },
      setMessages: (key, msgs) => set({ byPr: evict({ ...get().byPr, [key]: msgs }) }),
      setDraft: (key, draft) => {
        const next = { ...get().drafts };
        if (draft) next[key] = draft;
        else delete next[key];
        set({ drafts: next });
      },
      attach: (key, ref) => {
        const cur = get().attachments[key] ?? [];
        if (cur.some((r) => r.id === ref.id)) return;
        get().setAttachments(key, [...cur, ref].slice(-MAX_ATTACHMENTS));
      },
      removeAttachment: (key, id) =>
        get().setAttachments(
          key,
          (get().attachments[key] ?? []).filter((r) => r.id !== id),
        ),
      setAttachments: (key, refs) => {
        const next = { ...get().attachments };
        if (refs.length) next[key] = refs;
        else delete next[key];
        set({ attachments: evict(next) });
      },
      clearAttachments: (key) => get().setAttachments(key, []),
    }),
    {
      name: "reviewly.ai-chat",
      storage: sqlStorage<Pick<State, "byPr" | "drafts" | "attachments">>(),
      partialize: (s) => ({
        byPr: s.byPr,
        drafts: s.drafts,
        // Strip the captured snippet text: it's re-derived from the PR's patch
        // at send time, and persisting it would bloat the row for no gain.
        attachments: Object.fromEntries(
          Object.entries(s.attachments).map(([k, refs]) => [
            k,
            refs.map(({ code: _code, ...rest }) => rest),
          ]),
        ),
      }),
    },
  ),
);
