import type { GuidedStep } from "@/lib/guided";
import { sqlStorage } from "@/lib/sql-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface QuestionTour {
  id: string;
  question: string;
  status: "pending" | "done" | "failed";
  answer: string;
  steps: GuidedStep[];
  /** `HEAD` when asked — an answer about another commit is marked stale. */
  headSha: string;
  askedAt: number;
  error?: string;
  provider?: string;
}

/** Per repository, newest first. */
export const MAX_QUESTIONS = 20;

interface State {
  /** Keyed `repo:owner/repo`. */
  byRepo: Record<string, QuestionTour[]>;
  ask: (subject: string, q: Pick<QuestionTour, "id" | "question" | "headSha">) => void;
  land: (
    subject: string,
    id: string,
    result: { answer: string; steps: GuidedStep[]; provider: string },
  ) => void;
  fail: (subject: string, id: string, error: string) => void;
  remove: (subject: string, id: string) => void;
}

export const useQuestionTours = create<State>()(
  persist(
    (set, get) => {
      const update = (subject: string, id: string, fn: (q: QuestionTour) => QuestionTour) => {
        const list = get().byRepo[subject];
        if (!list?.some((q) => q.id === id)) return;
        set({
          byRepo: { ...get().byRepo, [subject]: list.map((q) => (q.id === id ? fn(q) : q)) },
        });
      };
      return {
        byRepo: {},
        ask: (subject, q) =>
          set({
            byRepo: {
              ...get().byRepo,
              [subject]: [
                {
                  ...q,
                  status: "pending",
                  answer: "",
                  steps: [],
                  askedAt: Date.now(),
                } as QuestionTour,
                ...(get().byRepo[subject] ?? []),
              ].slice(0, MAX_QUESTIONS),
            },
          }),
        land: (subject, id, r) => update(subject, id, (q) => ({ ...q, ...r, status: "done" })),
        fail: (subject, id, error) =>
          update(subject, id, (q) => ({ ...q, status: "failed", error })),
        remove: (subject, id) =>
          set({
            byRepo: {
              ...get().byRepo,
              [subject]: (get().byRepo[subject] ?? []).filter((q) => q.id !== id),
            },
          }),
      };
    },
    { name: "reviewly.question-tours", storage: sqlStorage<State>() },
  ),
);
