import { parseGuided } from "@/lib/guided";
import { parseRepoTourKey, repoTourPlan } from "@/lib/repo-tour";
import { subscribe } from "@/lib/tauri";
import { useRepoTour, useRepoTourGen } from "@/stores/repo-tour";
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

/** Bridge `ai:done` for one layer of a codebase tour (`repo-tour:` keys). A
 * failed layer is recorded and the queue keeps going, as in a deep tour. */
export function useRepoTourEvents() {
  useEffect(() => {
    let unsub: (() => void) | undefined;
    (async () => {
      unsub = await subscribe<AiDone>("ai:done", (e) => {
        const { key, ok, output, error, provider, headSha, canceled } = e.payload;
        const parsed = parseRepoTourKey(key);
        if (!parsed) return;
        const { repo, layerId } = parsed;
        const gen = useRepoTourGen.getState();
        if (canceled) {
          gen.finish(repo, layerId);
          return;
        }
        if (!ok) {
          gen.finish(
            repo,
            layerId,
            error?.split("\n").find((l) => l.trim()) || "This layer failed.",
          );
          return;
        }
        const plan = parseGuided(output ?? "");
        if (!plan) {
          gen.finish(repo, layerId, "No usable tour for this layer.");
          return;
        }
        useRepoTour.getState().setBatch(`repo:${repo}`, layerId, repoTourPlan(plan), {
          headSha: headSha ?? "",
          provider: provider ?? "",
        });
        gen.finish(repo, layerId);
        const after = useRepoTourGen.getState().byRepo[repo];
        if (after && after.running.length === 0 && after.queued.length === 0) {
          toast.success(`Codebase tour ready · ${repo}`);
        }
      });
    })();
    return () => unsub?.();
  }, []);
}
