/**
 * The codebase tour: one AI call per map layer, run in the clone, merged in
 * map order for display — the repository counterpart of the deep tour.
 *
 * Same shape decisions as `deep-tour.ts`, for the same reasons: batches land
 * out of order, a layer can be regenerated alone, so progress is keyed by the
 * stable `stepId` and the merge happens at read time.
 */
import { repoStepBudget } from "@/lib/ai/budget";
import { buildCodebaseTourSystem } from "@/lib/ai/prompts";
import { stepId } from "@/lib/deep-tour";
import type { GuidedPlan, GuidedStep, TourLayer } from "@/lib/guided";
import type { LayerEdge } from "@/lib/layer-edges";
import { type RepoMap, repoLayerEdges } from "@/lib/repo-map";
import type { RepoModule } from "@/lib/repo-modules";

/** `repo-tour:<layerId>@owner/repo` — its own `ai:done` namespace. */
export const REPO_TOUR_KEY_PREFIX = "repo-tour:";
export const repoTourKey = (layerId: string, repo: string): string =>
  `${REPO_TOUR_KEY_PREFIX}${layerId}@${repo}`;
export function parseRepoTourKey(key: string): { layerId: string; repo: string } | null {
  if (!key.startsWith(REPO_TOUR_KEY_PREFIX)) return null;
  const rest = key.slice(REPO_TOUR_KEY_PREFIX.length);
  const at = rest.indexOf("@");
  if (at <= 0 || at === rest.length - 1) return null;
  return { layerId: rest.slice(0, at), repo: rest.slice(at + 1) };
}

/** What a tour was built on — snapshotted so a re-planned map can't orphan
 * the batches. */
export interface MapSnapshot {
  map: RepoMap;
  modules: RepoModule[];
  edges: LayerEdge[];
}

export interface RepoTourBatch {
  plan: GuidedPlan;
  provider: string;
  generatedAt: number;
}

/**
 * Codebase tours ignore PR-only fields even when a model sends them: there is
 * no verdict to give and no author to post a suggestion to. Pitfalls stay
 * `concern` (the UI labels them); `praise` becomes `orient`.
 */
export function repoTourPlan(plan: GuidedPlan): GuidedPlan {
  return {
    summary: plan.summary,
    tour: plan.tour,
    steps: plan.steps.map(({ suggestion: _, ...s }) => ({
      ...s,
      kind: s.kind === "praise" ? "orient" : s.kind,
    })),
  };
}

/** Fold the landed layers into one plan, in map order, without duplicates. */
export function mergeRepoTour(entry: {
  mapSnapshot: MapSnapshot;
  byLayer: Record<string, RepoTourBatch>;
}): GuidedPlan {
  const { map } = entry.mapSnapshot;
  const steps: GuidedStep[] = [];
  const seen = new Set<string>();
  const layers: TourLayer[] = [];
  map.layers.forEach((layer, index) => {
    const batch = entry.byLayer[layer.id];
    if (!batch) return;
    const before = steps.length;
    for (const step of batch.plan.steps) {
      const stamped: GuidedStep = { ...step, layerId: layer.id };
      const id = stepId(stamped);
      if (seen.has(id)) continue;
      seen.add(id);
      steps.push(stamped);
    }
    if (steps.length > before) {
      layers.push({
        id: layer.id,
        title: layer.title,
        index: index + 1,
        total: map.layers.length,
        steps: steps.length - before,
      });
    }
  });
  return { summary: map.summary, tour: map.strategy, steps, layers };
}

/** Layer ids of the map with no batch yet. */
export const pendingLayers = (entry: {
  mapSnapshot: MapSnapshot;
  byLayer: Record<string, RepoTourBatch>;
}): string[] => entry.mapSnapshot.map.layers.filter((l) => !entry.byLayer[l.id]).map((l) => l.id);

/** One AI job per layer. Each runs in the clone (`cwd`) and reads its own
 * files; the prompt carries the layer, the map summary, and its neighbours. */
export function buildRepoTourJobs(
  snap: MapSnapshot,
  only?: string[],
): { layerId: string; prompt: string }[] {
  const { map, modules } = snap;
  const byId = new Map(modules.map((m) => [m.id, m]));
  const title = new Map(map.layers.map((l) => [l.id, l.title]));
  const edges = repoLayerEdges(map, snap.edges);
  return map.layers
    .map((layer, index) => ({ layer, index }))
    .filter(({ layer }) => !only || only.includes(layer.id))
    .map(({ layer, index }) => {
      const mods = layer.modules.map((id) => byId.get(id)).filter((m): m is RepoModule => !!m);
      const lines = mods.reduce((n, m) => n + m.lines, 0);
      return {
        layerId: layer.id,
        prompt: buildCodebaseTourSystem({
          layer: {
            title: layer.title,
            intent: layer.intent,
            focus: layer.focus,
            index,
            total: map.layers.length,
            modules: mods.map((m) => ({ id: m.id, files: m.files })),
          },
          map: { summary: map.summary },
          neighbors: {
            uses: edges.filter((e) => e.to === layer.id).map((e) => title.get(e.from) ?? e.from),
            usedBy: edges.filter((e) => e.from === layer.id).map((e) => title.get(e.to) ?? e.to),
          },
          steps: repoStepBudget(lines),
        }),
      };
    });
}
