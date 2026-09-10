import type { ContextOptions, ReviewContext } from "@/lib/ai/context";
import { buildTourJobs } from "@/lib/deep-tour";
import { heuristicLayers, reconcileLayers } from "@/lib/layers";
import type { PullFile } from "@/lib/tauri";
import { useDeepTour } from "@/stores/deep-tour";
import { useDeepTourGen } from "@/stores/deep-tour-gen";
import { useLayers } from "@/stores/layers";
import { useLocalRepos } from "@/stores/local-repos";
import { useReviewPrefs } from "@/stores/review-prefs";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";

/**
 * Start (or re-run part of) a deep tour: one AI call per layer, queued at a
 * bounded concurrency.
 *
 * Shared by the guided pane and the layered-review bar so both entry points
 * queue identical jobs against the same partition — a "Tour this layer" click
 * and the automatic whole-PR fan-out must not disagree about what a layer is.
 *
 * A whole-PR run RESUMES by default: layers that already have a batch are left
 * alone, so touring one layer on its own and then starting the full tour costs
 * one call, not two. Pass `force` to redo everything (that's "Regenerate").
 */
export function useDeepTourRunner({
  prKey,
  files,
  headSha,
  buildContext,
}: {
  prKey: string;
  files: PullFile[];
  headSha?: string;
  buildContext: (subset: PullFile[], opts?: ContextOptions) => ReviewContext;
}): (only?: string[], opts?: { force?: boolean }) => void {
  const aiInstructions = useReviewPrefs((s) => s.aiInstructions);
  const localRepos = useLocalRepos((s) => s.repos);

  // The PR's local clone, when it's checked out — the layer tours can then read
  // the real code rather than reasoning from the diff alone.
  const cwd = useMemo(() => {
    const [owner, repo] = prKey.split("#")[0].split("/");
    return localRepos.find((r) => r.owner === owner && r.repo === repo)?.path ?? null;
  }, [prKey, localRepos]);

  const custom = useMemo(
    () => (aiInstructions.trim() ? `\n\n# Reviewer's instructions\n${aiInstructions.trim()}` : ""),
    [aiInstructions],
  );

  return useCallback(
    (only?: string[], opts?: { force?: boolean }) => {
      if (files.length === 0) return;
      const existing = useDeepTour.getState().byPr[prKey];
      // A partial re-run must reuse the partition the tour was built on;
      // otherwise use the AI layer plan when there is one, and the instant
      // offline structural split when there isn't — so the automatic path never
      // pays for a second AI round-trip before it can start.
      const base =
        only && existing
          ? existing.plan
          : (useLayers.getState().byPr[prKey]?.plan ?? heuristicLayers(files));
      const plan = reconcileLayers(base, files);
      useDeepTour.getState().begin(prKey, plan, headSha ?? "");
      // `begin` may have cleared the batches (different head or partition), so
      // read what survived rather than what we saw a moment ago.
      const kept = useDeepTour.getState().byPr[prKey]?.byLayer ?? {};
      const targets =
        only ?? (opts?.force ? undefined : plan.layers.filter((l) => !kept[l.id]).map((l) => l.id));
      if (targets && targets.length === 0) return;
      const jobs = buildTourJobs({
        plan,
        files,
        buildContext,
        custom,
        cwd,
        headSha: headSha ?? "",
        only: targets,
      });
      // `only` ids are matched against the tour's OWN partition, and the two
      // sources of layers use disjoint id schemes. A caller holding a different
      // partition (the layered view, after the AI plan replaced the structural
      // one the tour started on) would otherwise queue nothing, silently.
      if (jobs.length === 0) {
        toast.warning("That layer isn't part of this tour — regenerate the tour to pick it up.");
        return;
      }
      useDeepTourGen.getState().enqueue(prKey, jobs);
    },
    [prKey, files, headSha, buildContext, custom, cwd],
  );
}
