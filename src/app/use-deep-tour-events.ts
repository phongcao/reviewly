import { parseGuided, parseTourKey } from "@/lib/guided";
import { subscribe } from "@/lib/tauri";
import { useDeepTour } from "@/stores/deep-tour";
import { useDeepTourGen } from "@/stores/deep-tour-gen";
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
 * Bridge the backend `ai:done` event for ONE LAYER of a deep tour into the
 * stores. `ai:done` is broadcast for every AI background task, so the `tour:`
 * key namespace is what tells a layer tour apart from a classic whole-PR tour
 * or a layer plan; anything else belongs to another surface and is left alone.
 *
 * A layer that fails is recorded as a per-layer error and the queue keeps
 * going — one bad slice must never take down a tour that has already covered
 * six others.
 */
export function useDeepTourEvents() {
  useEffect(() => {
    let unsub: (() => void) | undefined;
    (async () => {
      unsub = await subscribe<AiDone>("ai:done", (e) => {
        const { key, ok, output, error, provider, headSha, canceled } = e.payload;
        const parsed = parseTourKey(key);
        if (!parsed) return;
        const { prKey, layerId } = parsed;

        // Canceled by the user — free the slot, no error, no toast. `cancelAll`
        // has already emptied the queue, so this can't start anything new.
        if (canceled) {
          useDeepTourGen.getState().finish(prKey, layerId);
          return;
        }

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
          useDeepTourGen
            .getState()
            .finish(prKey, layerId, hint(error ?? "") || "This layer failed.");
          return;
        }

        const plan = parseGuided(output ?? "");
        if (!plan) {
          const h = hint(output ?? "");
          useDeepTourGen
            .getState()
            .finish(
              prKey,
              layerId,
              h ? `No usable tour — it said: “${h}”` : "No usable tour for this layer.",
            );
          return;
        }

        useDeepTour
          .getState()
          .setBatch(prKey, layerId, plan, { headSha: headSha ?? "", provider: provider ?? "" });
        useDeepTourGen.getState().finish(prKey, layerId);

        // Toast once, when the run drains — a per-layer toast on a ten-layer PR
        // is a notification storm, and the steps are already visible as they land.
        const after = useDeepTourGen.getState().byPr[prKey];
        if (after && after.running.length === 0 && after.queued.length === 0) {
          const entry = useDeepTour.getState().byPr[prKey];
          const batches = Object.values(entry?.byLayer ?? {});
          const steps = batches.reduce((n, b) => n + b.plan.steps.length, 0);
          const failed = Object.values(after.errors).filter(Boolean).length;
          const ref = prKey.split("/").pop() ?? prKey;
          if (failed > 0) {
            toast.warning(`Deep tour finished with gaps · ${ref}`, {
              description: `${steps} stops across ${batches.length} layers · ${failed} layer(s) failed`,
            });
          } else {
            toast.success(`Deep tour ready · ${ref}`, {
              description: `${steps} stops across ${batches.length} layers`,
            });
          }
        }
      });
    })();
    return () => unsub?.();
  }, []);
}
