import { invoke } from "@/lib/tauri";
import { type DeepTourEntry, useDeepTour } from "@/stores/deep-tour";
import { type GuidedEntry, useGuided } from "@/stores/guided";
import { type LayersEntry, useLayers } from "@/stores/layers";
import { useViewedFiles } from "@/stores/viewed-files";
import { getVersion } from "@tauri-apps/api/app";

/**
 * Export / import for the review data a PR accumulates — the part that costs
 * real time and AI tokens to produce.
 *
 * Reviewly keeps all of this in the local SQLite `kv` table (one JSON row per
 * Zustand store), which makes it trivially copyable but only as a whole file.
 * That's the wrong granularity for the actual need: carry the deep tours you
 * paid for onto another machine without dragging your tokens, window state and
 * repo bindings along, and without clobbering whatever the other machine has.
 *
 * So a bundle is grouped by PR, not by store. One PR's tour, its layer
 * partition and its viewed marks travel together, and import merges PR by PR.
 */

/** Bundle format version. Bump only on a breaking shape change. */
const BUNDLE_VERSION = 1;
const BUNDLE_KIND = "reviewly.review-data";

/** Everything worth carrying for one PR, keyed `${owner}/${repo}#${number}`. */
export interface PrReviewData {
  /** The layered deep tour — the expensive one: one AI call per layer. */
  deepTour?: DeepTourEntry;
  /** The layer partition the deep tour was built on. Useless to separate: the
   * layered view reads the plan from here, and a tour without its partition has
   * nowhere to hang its stops. */
  layers?: LayersEntry;
  /** The classic single-call guided tour. */
  guided?: GuidedEntry;
  /** Viewed-file marks, by full `${prKey}@${headSha}` key — a PR can carry
   * several if it was reviewed across pushes. */
  viewed?: Record<string, Record<string, true>>;
}

export interface ReviewDataBundle {
  kind: typeof BUNDLE_KIND;
  version: number;
  /** Epoch ms, for the filename and the import summary. */
  exportedAt: number;
  /** Reviewly version that wrote it — diagnostics only, never gated on. */
  app: string;
  prs: Record<string, PrReviewData>;
}

/** What a bundle holds, for the UI to show before and after a transfer. */
export interface BundleStats {
  prs: number;
  deepTours: number;
  guidedTours: number;
  layerPlans: number;
  /** Total stops across every deep tour — the honest measure of what the AI produced. */
  deepStops: number;
}

export function bundleStats(bundle: ReviewDataBundle): BundleStats {
  const entries = Object.values(bundle.prs);
  return {
    prs: entries.length,
    deepTours: entries.filter((e) => e.deepTour).length,
    guidedTours: entries.filter((e) => e.guided).length,
    layerPlans: entries.filter((e) => e.layers).length,
    deepStops: entries.reduce(
      (n, e) =>
        n +
        Object.values(e.deepTour?.byLayer ?? {}).reduce(
          (m, batch) => m + (batch.plan?.steps?.length ?? 0),
          0,
        ),
      0,
    ),
  };
}

/**
 * Collect the current review data into a bundle.
 *
 * Union of every PR key that appears in any store, so a PR with a layer plan
 * but no tour yet still travels — partial work is work.
 */
export async function collectBundle(): Promise<ReviewDataBundle> {
  const deep = useDeepTour.getState().byPr;
  const layers = useLayers.getState().byPr;
  const guided = useGuided.getState().byPr;
  const viewed = useViewedFiles.getState().viewed;

  const prs: Record<string, PrReviewData> = {};
  for (const key of new Set([
    ...Object.keys(deep),
    ...Object.keys(layers),
    ...Object.keys(guided),
  ])) {
    const entry: PrReviewData = {};
    if (deep[key]) entry.deepTour = deep[key];
    if (layers[key]) entry.layers = layers[key];
    if (guided[key]) entry.guided = guided[key];
    // Viewed rows carry an `@sha` suffix, so they attach by prefix rather than
    // by exact key. Guard the `@` or `foo/bar#1` would also claim `foo/bar#12`.
    const marks: Record<string, Record<string, true>> = {};
    for (const [vKey, paths] of Object.entries(viewed)) {
      if (vKey.startsWith(`${key}@`)) marks[vKey] = paths;
    }
    if (Object.keys(marks).length > 0) entry.viewed = marks;
    prs[key] = entry;
  }

  return {
    kind: BUNDLE_KIND,
    version: BUNDLE_VERSION,
    exportedAt: Date.now(),
    app: await getVersion().catch(() => "unknown"),
    prs,
  };
}

/** Thrown for a file that isn't a review bundle, so the UI can say why. */
export class BundleError extends Error {}

/**
 * Parse and validate a bundle.
 *
 * Deliberately shallow: it checks the envelope and that each PR's slots are the
 * right shape, then trusts the entry bodies. The stores already tolerate
 * missing optional fields (`seen`, `collapsedLayers`, `dismissed`) because
 * they've been through their own migrations, and the layered view reconciles
 * plans against the PR's real files at read time — so a slightly-off entry
 * degrades to "stale tour" rather than a crash. Validating every step would
 * duplicate that reconciliation here and go stale the moment the shape moves.
 */
export function parseBundle(text: string): ReviewDataBundle {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BundleError("not valid JSON");
  }
  if (!raw || typeof raw !== "object") throw new BundleError("not a review bundle");
  const b = raw as Partial<ReviewDataBundle>;
  if (b.kind !== BUNDLE_KIND) throw new BundleError("not a Reviewly review-data file");
  if (typeof b.version !== "number" || b.version > BUNDLE_VERSION) {
    throw new BundleError(
      `bundle version ${String(b.version)} is newer than this Reviewly understands`,
    );
  }
  if (!b.prs || typeof b.prs !== "object") throw new BundleError("bundle has no PR data");

  const prs: Record<string, PrReviewData> = {};
  for (const [key, value] of Object.entries(b.prs)) {
    if (!value || typeof value !== "object") continue;
    const e = value as PrReviewData;
    const entry: PrReviewData = {};
    // A tour without its `plan`/`byLayer` has nothing to show; drop it rather
    // than persist a row the layered view will trip over.
    if (e.deepTour?.plan && e.deepTour.byLayer) entry.deepTour = e.deepTour;
    if (e.layers?.plan) entry.layers = e.layers;
    if (e.guided?.plan) entry.guided = e.guided;
    if (e.viewed && typeof e.viewed === "object") entry.viewed = e.viewed;
    if (Object.keys(entry).length > 0) prs[key] = entry;
  }
  if (Object.keys(prs).length === 0) throw new BundleError("bundle has no usable review data");

  return {
    kind: BUNDLE_KIND,
    version: b.version,
    exportedAt: typeof b.exportedAt === "number" ? b.exportedAt : 0,
    app: typeof b.app === "string" ? b.app : "unknown",
    prs,
  };
}

/** What an import actually changed, for the confirmation toast. */
export interface ImportResult {
  deepTours: number;
  guidedTours: number;
  layerPlans: number;
  viewedKeys: number;
  /** PRs present in the bundle whose local copy was already newer. */
  skipped: number;
}

/**
 * Merge a bundle into the local stores.
 *
 * Never deletes: each store merges per PR and keeps the newer `generatedAt`, so
 * importing is safe to repeat and an older bundle can't undo newer work. That's
 * what makes this a plain button and not a confirm-you-mean-it dialog.
 *
 * Each store applies its own entry cap on the way in, so a big import evicts
 * the oldest tours exactly as generating them one at a time would have.
 */
export function applyBundle(bundle: ReviewDataBundle): ImportResult {
  const deep: Record<string, DeepTourEntry> = {};
  const layers: Record<string, LayersEntry> = {};
  const guided: Record<string, GuidedEntry> = {};
  let viewed: Record<string, Record<string, true>> = {};

  for (const [key, entry] of Object.entries(bundle.prs)) {
    if (entry.deepTour) deep[key] = entry.deepTour;
    if (entry.layers) layers[key] = entry.layers;
    if (entry.guided) guided[key] = entry.guided;
    if (entry.viewed) viewed = { ...viewed, ...entry.viewed };
  }

  const result: ImportResult = {
    deepTours: useDeepTour.getState().importEntries(deep),
    layerPlans: useLayers.getState().importEntries(layers),
    guidedTours: useGuided.getState().importEntries(guided),
    viewedKeys: useViewedFiles.getState().importViewed(viewed),
    skipped: 0,
  };
  result.skipped = Object.keys(deep).length - result.deepTours;
  return result;
}

/** Default filename for a save dialog: `reviewly-review-data-2026-09-21.json`. */
export function bundleFilename(now = new Date()): string {
  return `reviewly-review-data-${now.toISOString().slice(0, 10)}.json`;
}

/** Serialize and write a bundle to `path`. */
export async function writeBundle(path: string, bundle: ReviewDataBundle): Promise<void> {
  await invoke("write_bundle", { path, contents: JSON.stringify(bundle, null, 2) });
}

/** Read and parse a bundle from `path`. */
export async function readBundle(path: string): Promise<ReviewDataBundle> {
  return parseBundle(await invoke<string>("read_bundle", { path }));
}
