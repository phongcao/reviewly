import { TOUR_KEY_PREFIX, parseGuided } from "@/lib/guided";
import { LAYERS_KEY_PREFIX } from "@/lib/layers";
import { subscribe } from "@/lib/tauri";
import { useGuided } from "@/stores/guided";
import { useGuidedGen } from "@/stores/guided-gen";
import { useEffect } from "react";
import { toast } from "sonner";

interface AiDone {
  key: string;
  ok: boolean;
  output?: string;
  error?: string;
  provider?: string;
  headSha?: string;
  canceled?: boolean;
}

/**
 * Bridge the backend `ai:done` event (a guided-tour generation finished in its
 * Rust background task) into the stores. Mounted app-wide, so a tour started on
 * one screen still lands even after you navigate away or refresh — the result is
 * written to the persisted `useGuided` store whenever it completes.
 */
export function useGuidedEvents() {
  useEffect(() => {
    let unsub: (() => void) | undefined;
    (async () => {
      unsub = await subscribe<AiDone>("ai:done", (e) => {
        const { key, ok, output, error, provider, headSha, canceled } = e.payload;
        // `ai:done` is broadcast for every AI background task. A layered-review
        // plan or one layer of a deep tour is another surface's reply — parsing
        // it here would fail and report a phantom "tour failed" for a tour
        // nobody asked for. A classic whole-PR tour uses the bare `prKey`.
        if (key.startsWith(LAYERS_KEY_PREFIX) || key.startsWith(TOUR_KEY_PREFIX)) return;
        const gen = useGuidedGen.getState();
        gen.done(key);
        // Canceled by the user — just clear the pending state, no error/toast.
        if (canceled) return;
        // `key` is `owner/repo#number` — show a friendly short ref in the toast.
        const ref = key.split("/").pop() ?? key;
        // Surface the model's own first line so an opaque failure (a refusal,
        // "diff too large", a rate-limit, a bad model id) is actionable instead
        // of a generic "didn't return a usable tour".
        const hint = (raw: string): string => {
          const first =
            raw
              .trim()
              .split("\n")
              .find((l) => l.trim()) ?? "";
          return first.length > 160 ? `${first.slice(0, 157)}…` : first;
        };
        if (!ok) {
          gen.fail(key, hint(error ?? "") || "The AI review failed.");
          toast.error(`Guided tour failed · ${ref}`);
          return;
        }
        const plan = parseGuided(output ?? "");
        if (!plan) {
          const h = hint(output ?? "");
          gen.fail(
            key,
            h
              ? `The AI didn't return a usable tour — it said: “${h}”`
              : "The AI didn't return a usable tour. Try again.",
          );
          toast.error(`Guided tour failed · ${ref}`);
          return;
        }
        useGuided.getState().set(key, plan, { headSha: headSha ?? "", provider: provider ?? "" });
        toast.success(`Guided tour ready · ${ref}`);
      });
    })();
    return () => unsub?.();
  }, []);
}
