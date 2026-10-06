import { Button } from "@/components/ui/button";
import { buildRepoMapSystem, repoMapInput } from "@/lib/ai/prompts";
import { useAiAvailable } from "@/lib/ai/use-ai-available";
import { heuristicRepoMap, repoMapKey, repoSubject } from "@/lib/repo-map";
import { computeRepoStructure } from "@/lib/repo-structure";
import { type RepoInfo, invoke } from "@/lib/tauri";
import { PROVIDER_LABEL, aiInvokeArgs, useAiProvider } from "@/stores/ai";
import { useRepoMap, useRepoMapGen } from "@/stores/repo-map";
import { useQuery } from "@tanstack/react-query";
import { Compass, Map as MapIcon, Sparkles } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";

/** Layers the map planner asks for: a few for a small repository, up to 10. */
const layerBand = (modules: number) => ({
  min: Math.min(3, Math.max(1, modules)),
  max: Math.max(3, Math.min(10, Math.ceil(modules / 3))),
});

export type RepoMapBuilder = ReturnType<typeof useRepoMapBuilder>;

/**
 * The Explain tab's map of a repository: what it is, where execution starts,
 * and the order to read its parts in. Structure and order are computed from
 * the clone; the AI only names and groups. The tab works without AI — the
 * computed map renders on its own.
 */
export function useRepoMapBuilder(owner: string, repo: string, root: string) {
  const subject = repoSubject(owner, repo);
  const entry = useRepoMap((s) => s.byRepo[subject]);
  const planning = useRepoMapGen((s) => !!s.inFlight[subject]);
  const planError = useRepoMapGen((s) => s.error[subject]);
  const provider = useAiProvider((s) => s.provider);
  const { available } = useAiAvailable();
  const [building, setBuilding] = useState(false);
  const info = useQuery({
    queryKey: ["git-repo-info", root],
    queryFn: () => invoke<RepoInfo>("git_repo_info", { path: root }),
    staleTime: 10_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  /** Compute the structure, store the offline map, then — when asked and
   * available — send the planner. The planner's reply replaces the map's
   * names and grouping, never the structure. */
  const build = useCallback(
    async (withAi: boolean) => {
      if (building) return;
      setBuilding(true);
      try {
        const s = await computeRepoStructure(root);
        // Same commit, same structure: keep a planned map until a new plan
        // replaces it, rather than flashing back to the computed one.
        const prev = useRepoMap.getState().byRepo[subject];
        const keep = prev && prev.headSha === s.head && prev.provider !== "heuristic";
        useRepoMap.getState().set(subject, {
          map: keep ? prev.map : heuristicRepoMap(s.modules, s.order),
          modules: s.modules,
          edges: s.edges,
          order: s.order,
          skipped: s.skipped,
          headSha: s.head,
          generatedAt: keep ? prev.generatedAt : Date.now(),
          provider: keep ? prev.provider : "heuristic",
        });
        info.refetch();
        if (!withAi) return;
        useRepoMapGen.getState().start(subject);
        await invoke("ai_review_bg", {
          key: repoMapKey(`${owner}/${repo}`),
          ...aiInvokeArgs(),
          headSha: s.head,
          // No clone: everything the planner needs is computed and in the
          // prompt, which keeps it fast and repeatable.
          cwd: null,
          prompt: `${buildRepoMapSystem({ layers: layerBand(s.modules.length), modules: s.modules.length })}\n\n${repoMapInput(
            {
              modules: s.modules,
              edges: s.edges,
              order: s.order,
              readme: s.readme,
              manifests: s.manifests,
            },
          )}`,
        }).catch((e) => useRepoMapGen.getState().fail(subject, String(e)));
      } catch (e) {
        toast.error(`Couldn't map this repository — ${String(e)}`);
      } finally {
        setBuilding(false);
      }
    },
    [building, root, subject, owner, repo, info],
  );

  const cancel = useCallback(() => {
    invoke("ai_cancel", { key: repoMapKey(`${owner}/${repo}`) }).catch(() => {});
    useRepoMapGen.getState().done(subject);
  }, [owner, repo, subject]);

  const canUseAi = available === true;
  const aiName = PROVIDER_LABEL[provider];

  return {
    subject,
    entry,
    info,
    build,
    cancel,
    building,
    planning,
    planError,
    canUseAi,
    aiName,
  };
}

/** No map yet: what the tab does, and the two ways to build one. */
export function MapIntro({ builder }: { builder: RepoMapBuilder }) {
  const { aiName, building, build, canUseAi } = builder;
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <MapIcon className="size-8 text-muted-foreground/60" strokeWidth={1.5} />
      <div>
        <p className="text-sm font-medium text-foreground">Explain this repository</p>
        <p className="mt-1 max-w-md text-xs text-muted-foreground">
          Cut the code into modules, find the import links between them, and get an order to read
          them in. The structure is computed from your clone; {aiName} only names and groups it.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" loading={building} onClick={() => build(false)}>
          <Compass className="size-3.5" />
          Map without AI
        </Button>
        <Button size="sm" disabled={!canUseAi} loading={building} onClick={() => build(true)}>
          <Sparkles className="size-3.5" />
          Map with {aiName}
        </Button>
      </div>
    </div>
  );
}
