import { REPO_MAP_KEY_PREFIX, parseRepoMap, reconcileRepoMap } from "@/lib/repo-map";
import { subscribe } from "@/lib/tauri";
import { useRepoMap, useRepoMapGen } from "@/stores/repo-map";
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
 * Bridge `ai:done` for a codebase-map run (`repo-map:` keys) into the store.
 * The reply is reconciled against the structure stored when the run started,
 * so a map always covers exactly the modules that were computed — whatever
 * the model returned.
 */
export function useRepoMapEvents() {
  useEffect(() => {
    let unsub: (() => void) | undefined;
    (async () => {
      unsub = await subscribe<AiDone>("ai:done", (e) => {
        const { key, ok, output, error, provider, headSha, canceled } = e.payload;
        if (!key.startsWith(REPO_MAP_KEY_PREFIX)) return;
        const repo = key.slice(REPO_MAP_KEY_PREFIX.length);
        const subject = `repo:${repo}`;
        const gen = useRepoMapGen.getState();
        if (canceled) {
          gen.done(subject);
          return;
        }
        if (!ok) {
          gen.fail(subject, error?.split("\n").find((l) => l.trim()) || "The map planner failed.");
          toast.error(`Codebase map failed · ${repo}`);
          return;
        }
        const entry = useRepoMap.getState().byRepo[subject];
        const parsed = parseRepoMap(output ?? "");
        if (!entry || !parsed) {
          gen.fail(subject, "The AI didn't return a usable map. The computed map is still shown.");
          toast.error(`Codebase map failed · ${repo}`);
          return;
        }
        const tracked = new Set(entry.modules.flatMap((m) => m.files));
        useRepoMap.getState().setMap(subject, reconcileRepoMap(parsed, entry.modules, tracked), {
          headSha: headSha ?? "",
          provider: provider ?? "",
        });
        gen.done(subject);
        toast.success(`Codebase map ready · ${repo}`);
      });
    })();
    return () => unsub?.();
  }, []);
}
