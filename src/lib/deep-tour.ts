import { layerStepCap, stepBudget } from "@/lib/ai/budget";
import {
  type ContextOptions,
  LAYER_DIFF_BUDGET,
  type LayerScopeInfo,
  type ReviewContext,
} from "@/lib/ai/context";
import { CLONE_ABSENT_CLAUSE, buildGuidedSystem } from "@/lib/ai/prompts";
import type { GuidedPlan, GuidedStep, GuidedVerdict, TourLayer } from "@/lib/guided";
import { type LayerPlan, reconcileLayers } from "@/lib/layers";
import type { PullFile } from "@/lib/tauri";
import type { DeepSynthesis, DeepTourEntry } from "@/stores/deep-tour";
import type { TourJob } from "@/stores/deep-tour-gen";

/**
 * A stable identity for one stop of a deep tour.
 *
 * This is the load-bearing detail of the whole design. A deep tour's step list
 * GROWS as layers land, so anything keyed by array index (which is how the
 * classic tour stores `seen` / `dismissed`) would silently re-point at a
 * different stop every time a batch arrived — the reviewer dismisses stop 4,
 * layer 2 lands, and stop 4 is now someone else's. A content-derived id can't
 * drift, and regenerating one layer invalidates only that layer's ids.
 */
export const stepId = (step: GuidedStep): string =>
  `${step.layerId ?? ""}#${step.path}:${step.line}:${step.title}`;

/** Verdict severity, worst first — the aggregation order across layers. */
const SEVERITY: GuidedVerdict[] = ["request_changes", "comment", "approve"];

/**
 * The only two fields of a `DeepTourEntry` that decide what a merged tour
 * CONTAINS: the layer partition and the batches that have landed on it.
 *
 * Deliberately narrower than `DeepTourEntry`. The entry also carries the
 * reviewer's cursor (`lastActiveId`, `seen`, `dismissed`), which changes on
 * every stop they move to — and since the store replaces the entry object on
 * each of those writes, a merge memoized on the whole entry re-ran on every
 * click and handed the UI 200+ freshly-allocated step objects that were equal
 * to the ones it already had. Taking only what the merge reads lets the caller
 * memoize on exactly that, so cursor movement stops rebuilding the tour.
 */
export type TouredLayers = Pick<DeepTourEntry, "plan" | "byLayer"> &
  Partial<Pick<DeepTourEntry, "headSha" | "synthesis">>;

/**
 * Background-task key prefix for a deep tour's whole-PR synthesis. Disjoint
 * from the bare `prKey` (classic tour), `layers:` and `tour:` for the reason
 * `TOUR_KEY_PREFIX` gives: `ai:done` is broadcast to every listener.
 */
export const SYNTH_KEY_PREFIX = "synth:";
export const synthKey = (prKey: string): string => `${SYNTH_KEY_PREFIX}${prKey}`;
export const parseSynthKey = (key: string): string | null =>
  key.startsWith(SYNTH_KEY_PREFIX) && key.length > SYNTH_KEY_PREFIX.length
    ? key.slice(SYNTH_KEY_PREFIX.length)
    : null;

/** Which batches a synthesis was written from. A regenerated layer gets a new
 * `generatedAt`, which changes the basis and retires the synthesis. */
export const synthesisBasis = (byLayer: DeepTourEntry["byLayer"]): string =>
  Object.entries(byLayer)
    .map(([id, b]) => `${id}:${b.generatedAt}`)
    .sort()
    .join(",");

/** The synthesis still describes this exact tour: same head, same batches. */
export function synthesisFresh(entry: TouredLayers): DeepSynthesis | null {
  const s = entry.synthesis;
  if (!s) return null;
  if ((entry.headSha ?? "") !== s.headSha) return null;
  return s.basis === synthesisBasis(entry.byLayer) ? s : null;
}

/** Every layer of the tour's own partition has landed — the point at which
 * a whole-PR summary can speak for the whole PR. */
export const allLayersToured = (entry: TouredLayers): boolean =>
  entry.plan.layers.length > 0 && entry.plan.layers.every((l) => !!entry.byLayer[l.id]);

/**
 * The input to `buildDeepSummarySystem`: each layer's title and intent, and
 * for each toured layer its summary, verdict, reason, and concern titles. No
 * diff and no stop details — the synthesis restates conclusions, it does not
 * re-review.
 */
export function deepSummaryInput(entry: TouredLayers): string {
  const verdicts: { verdict: GuidedVerdict; reason: string; title: string }[] = [];
  const blocks = entry.plan.layers.map((layer, i) => {
    const batch = entry.byLayer[layer.id];
    const head = `## Layer ${i + 1} of ${entry.plan.layers.length}: ${layer.title}\nIntent: ${layer.intent}`;
    if (!batch) return `${head}\n(not toured)`;
    if (batch.plan.verdict) {
      verdicts.push({
        verdict: batch.plan.verdict,
        reason: batch.plan.verdictReason?.trim() ?? "",
        title: layer.title,
      });
    }
    const concerns = batch.plan.steps
      .filter((s) => s.kind === "concern")
      .map((s) => `- ${s.title}`);
    return [
      head,
      `Summary: ${batch.plan.summary || "(none)"}`,
      `Verdict: ${batch.plan.verdict ?? "(none)"}`,
      `Verdict reason: ${batch.plan.verdictReason || "(none)"}`,
      concerns.length ? `Concerns:\n${concerns.join("\n")}` : "Concerns: none",
    ].join("\n");
  });
  // Same fold `mergeDeepTour` shows, so the reason explains the verdict the
  // reviewer actually sees.
  const combined = aggregateVerdict(verdicts).verdict ?? "(none)";
  return `# Combined verdict\n${combined}\n\n# Layer results\n${blocks.join("\n\n")}`;
}

/**
 * Fold the per-layer tours that have landed so far into one `GuidedPlan`.
 *
 * Merging happens at READ time and is never stored — the same choice
 * `reconcileLayers` makes, for the same reason: the PR keeps moving, layers
 * arrive out of order, and one of them may be regenerated. Deriving the plan on
 * every read means a partially-complete tour is always a correct tour of the
 * layers that are in, rather than a stale snapshot.
 *
 * The partition comes from the entry itself and is reconciled against the PR's
 * files here, so files pushed since the tour started surface as an untoured
 * trailing layer rather than vanishing.
 */
export function mergeDeepTour(entry: TouredLayers, files: PullFile[]): GuidedPlan {
  const plan: LayerPlan = reconcileLayers(entry.plan, files);
  const steps: GuidedStep[] = [];
  const seen = new Set<string>();
  const verdicts: { verdict: GuidedVerdict; reason: string; title: string }[] = [];
  const layers: TourLayer[] = [];

  // Plan order, NOT arrival order: which call finished first is an accident of
  // scheduling, while the layer order is the reading order the planner chose.
  for (const [index, layer] of plan.layers.entries()) {
    const batch = entry.byLayer[layer.id];
    if (!batch) continue; // still generating, failed, or never queued — a gap that fills in later.

    const before = steps.length;
    for (const step of batch.plan.steps) {
      const stamped: GuidedStep = { ...step, layerId: layer.id };
      const id = stepId(stamped);
      if (seen.has(id)) continue;
      seen.add(id);
      steps.push(stamped);
    }
    // Only landed layers get a heading — an untoured layer has no stops to head,
    // and `index` keeps the numbering absolute so "Layer 6 of 10" stays true
    // whether or not 2–5 have landed yet.
    if (steps.length > before) {
      layers.push({
        id: layer.id,
        title: layer.title,
        index: index + 1,
        total: plan.layers.length,
        steps: steps.length - before,
      });
    }
    if (batch.plan.verdict) {
      verdicts.push({
        verdict: batch.plan.verdict,
        reason: batch.plan.verdictReason?.trim() ?? "",
        title: layer.title,
      });
    }
  }

  const touredTitles = plan.layers.filter((l) => entry.byLayer[l.id]).map((l) => l.title);
  const synthesis = synthesisFresh(entry);
  const verdict = aggregateVerdict(verdicts);

  return {
    // The planner's sentence was written from the file list before any layer
    // was read. Once every layer is in, a synthesis restates what they found;
    // prefer it while it still describes these exact batches.
    summary: synthesis?.summary || plan.summary,
    tour: touredTitles.length
      ? `${plan.strategy} Toured layer by layer: ${touredTitles.join(" → ")}.`
      : plan.strategy,
    ...verdict,
    ...(synthesis?.verdictReason && verdict.verdict
      ? { verdictReason: synthesis.verdictReason }
      : {}),
    steps,
    layers,
  };
}

/**
 * Combine the layers' verdicts by severity — worst wins. Each layer judged only
 * its own slice, so a single blocking layer blocks the PR while "approve"
 * requires every landed layer to have said so.
 */
function aggregateVerdict(verdicts: { verdict: GuidedVerdict; reason: string; title: string }[]): {
  verdict?: GuidedVerdict;
  verdictReason?: string;
} {
  if (verdicts.length === 0) return {};

  for (const level of SEVERITY) {
    const hits = verdicts.filter((v) => v.verdict === level);
    if (hits.length === 0) continue;

    if (level === "approve") {
      // Reached only when every landed layer approved.
      const reason = hits[0].reason;
      return {
        verdict: "approve",
        verdictReason:
          hits.length === 1
            ? reason
            : `Every layer reads clean${reason ? ` — ${lowerFirst(reason)}` : "."}`,
      };
    }

    const first = hits[0];
    const extra = hits.length - 1;
    const base = first.reason ? `${first.title}: ${first.reason}` : first.title;
    return {
      verdict: level,
      verdictReason:
        extra > 0
          ? `${base} (+${extra} more layer${extra === 1 ? "" : "s"} flagged something)`
          : base,
    };
  }
  return {};
}

const lowerFirst = (s: string): string => (s ? s[0].toLowerCase() + s.slice(1) : s);

/** Progress across a deep tour, for the UI and for deciding what to re-queue. */
export interface DeepTourProgress {
  /** Layers with a stored batch. */
  done: string[];
  /** Layers with neither a batch nor a run in flight — what "Continue" covers. */
  missing: string[];
  total: number;
  steps: number;
}

export function deepTourProgress(
  entry: TouredLayers | undefined,
  files: PullFile[],
  busy: Set<string>,
): DeepTourProgress {
  const plan = entry ? reconcileLayers(entry.plan, files) : null;
  if (!plan) return { done: [], missing: [], total: 0, steps: 0 };
  const done: string[] = [];
  const missing: string[] = [];
  let steps = 0;
  for (const layer of plan.layers) {
    const batch = entry?.byLayer[layer.id];
    if (batch) {
      done.push(layer.id);
      steps += batch.plan.steps.length;
    } else if (!busy.has(layer.id)) {
      missing.push(layer.id);
    }
  }
  return { done, missing, total: plan.layers.length, steps };
}

/**
 * One AI job per layer, each seeing only its own files.
 *
 * This is what makes the total number of stops unbounded: it's the sum over
 * layers, and no single call has to hold the whole PR — so a 300-file PR is
 * covered by many small, well-grounded calls instead of one call asked for more
 * than it can ground. Pass `only` to (re)run specific layers.
 */
export function buildTourJobs(o: {
  plan: LayerPlan;
  files: PullFile[];
  buildContext: (subset: PullFile[], opts?: ContextOptions) => ReviewContext;
  /** The reviewer's custom instructions, already formatted as a prompt section. */
  custom: string;
  /** Local clone path, or null when the model sees only the diff. */
  cwd: string | null;
  headSha: string;
  only?: string[];
}): TourJob[] {
  const byPath = new Map(o.files.map((f) => [f.filename, f]));
  return o.plan.layers
    .map((layer, index) => ({ layer, index }))
    .filter(({ layer }) => !o.only || o.only.includes(layer.id))
    .map(({ layer, index }) => {
      const subset = layer.files.map((p) => byPath.get(p)).filter((f): f is PullFile => !!f);
      if (subset.length === 0) return null;
      // `index` is the layer's place in the WHOLE plan, not in the filtered
      // list — a retry of layer 5 must still say "layer 5 of 7".
      const scope: LayerScopeInfo = {
        title: layer.title,
        intent: layer.intent,
        focus: layer.focus,
        index,
        total: o.plan.layers.length,
      };
      const ctx = o.buildContext(subset, { budget: LAYER_DIFF_BUDGET, scope });
      const system = buildGuidedSystem({
        steps: stepBudget(ctx.size, { cap: layerStepCap(ctx.size) }),
        size: ctx.size,
        layer: scope,
      });
      return {
        layerId: layer.id,
        prompt: `${system}${o.custom}${o.cwd ? "" : CLONE_ABSENT_CLAUSE}\n\n# Pull request\n${ctx.text}`,
        headSha: o.headSha,
        cwd: o.cwd,
      };
    })
    .filter((job): job is TourJob => job !== null);
}
