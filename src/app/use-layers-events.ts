import { LAYERS_KEY_PREFIX, parseLayers } from "@/lib/layers";
import { subscribe } from "@/lib/tauri";
import { useLayers } from "@/stores/layers";
import { useLayersGen } from "@/stores/layers-gen";
import { useEffect } from "react";
import { toast } from "sonner";

interface AiDone {
  key: string;
  ok: boolean;
  output?: string;
  error?: string;
  provider?: string;
  headSha?: string;
  model?: string | null;
  effort?: string | null;
  canceled?: boolean;
}

/**
 * Bridge the backend `ai:done` event for a LAYER-PLAN run into the stores.
 * `ai:done` is broadcast for every AI background task, so the prefix on the key
 * is what tells a layering apart from a guided tour; anything else is another
 * surface's result and is left alone. Mounted app-wide, so a plan started on one
 * screen still lands after navigating away or refreshing — the Rust task
 * outlives both.
 */
export function useLayersEvents() {
  useEffect(() => {
    let unsub: (() => void) | undefined;
    (async () => {
      unsub = await subscribe<AiDone>("ai:done", (e) => {
        const { key, ok, output, error, provider, headSha, model, effort, canceled } = e.payload;
        if (!key.startsWith(LAYERS_KEY_PREFIX)) return;
        const prKey = key.slice(LAYERS_KEY_PREFIX.length);
        const gen = useLayersGen.getState();
        gen.done(prKey);
        // Canceled by the user — just clear the pending state, no error/toast.
        if (canceled) return;
        const ref = prKey.split("/").pop() ?? prKey;
        // Surface the model's own first line so an opaque failure (a refusal, a
        // rate-limit, a bad model id) is actionable instead of generic.
        const hint = (raw: string): string => {
          const first =
            raw
              .trim()
              .split("\n")
              .find((l) => l.trim()) ?? "";
          return first.length > 160 ? `${first.slice(0, 157)}…` : first;
        };
        if (!ok) {
          gen.fail(prKey, hint(error ?? "") || "The layer plan failed.");
          toast.error(`Layering failed · ${ref}`);
          return;
        }
        const plan = parseLayers(output ?? "");
        if (!plan) {
          const h = hint(output ?? "");
          gen.fail(
            prKey,
            h
              ? `The AI didn't return a usable split — it said: “${h}”`
              : "The AI didn't return a usable split. Try again, or split by structure.",
          );
          toast.error(`Layering failed · ${ref}`);
          return;
        }
        useLayers.getState().set(prKey, plan, {
          headSha: headSha ?? "",
          source: provider ?? "",
          model: model ?? undefined,
          effort: effort ?? undefined,
        });
        toast.success(`Layers ready · ${ref}`, {
          description: `${plan.layers.length} layers to read in order`,
        });
      });
    })();
    return () => unsub?.();
  }, []);
}
