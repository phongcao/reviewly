import { parseQuestionKey, parseQuestionTour } from "@/lib/question-tour";
import { subscribe } from "@/lib/tauri";
import { useQuestionTours } from "@/stores/question-tours";
import { useEffect } from "react";

interface AiDone {
  key: string;
  ok: boolean;
  output?: string;
  error?: string;
  provider?: string;
  canceled?: boolean;
}

/** Bridge `ai:done` for a question tour (`question:` keys) into the store. */
export function useQuestionEvents() {
  useEffect(() => {
    let unsub: (() => void) | undefined;
    (async () => {
      unsub = await subscribe<AiDone>("ai:done", (e) => {
        const { key, ok, output, error, provider, canceled } = e.payload;
        const parsed = parseQuestionKey(key);
        if (!parsed) return;
        const subject = `repo:${parsed.repo}`;
        const store = useQuestionTours.getState();
        if (canceled) {
          store.fail(subject, parsed.id, "Stopped.");
          return;
        }
        if (!ok) {
          store.fail(
            subject,
            parsed.id,
            error?.split("\n").find((l) => l.trim()) || "The AI call failed.",
          );
          return;
        }
        const answer = parseQuestionTour(output ?? "");
        if (!answer) {
          store.fail(subject, parsed.id, "The AI didn't return a usable answer.");
          return;
        }
        store.land(subject, parsed.id, { ...answer, provider: provider ?? "" });
      });
    })();
    return () => unsub?.();
  }, []);
}
