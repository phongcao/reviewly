/**
 * How many items to ask the AI for, derived from the PR in front of it.
 *
 * The counts used to be constants baked into the prompt prose ("4 to 10 steps",
 * "2 to 7 layers"), so a one-line tweak and a 300-file rewrite got the identical
 * instruction — the small PR padded, the large one starved. Everything here is a
 * pure function of `PrSize`, and `PrSize` comes from `buildReviewContext`, which
 * knows what actually fit in the prompt.
 *
 * Deliberately import-free so nothing can cycle through it.
 */

/** The size of a PR *as the model experiences it* — what fit, not what exists. */
export interface PrSize {
  /** Changed files in the PR. */
  files: number;
  /** additions + deletions across the whole PR. */
  churn: number;
  /** Files that made it into the context with at least some patch text. */
  shownFiles: number;
  /** Churn the model can actually see (truncation-aware, so a half-shown file
   * contributes half its lines). */
  shownChurn: number;
  /** `shownChurn / churn`, and 1 when there is no churn at all. */
  coverage: number;
}

/** An inclusive "ask for between min and max of these" range. */
export interface CountBand {
  min: number;
  max: number;
}

/** Ceiling for a single guided-tour call. Each step costs roughly 300-500 output
 * tokens, so ~24 is where one reply starts risking the model's output limit —
 * and nothing in `ai.rs` sets `max_tokens`, so a truncated reply is only caught
 * after the fact by `parseGuided`'s salvage. Past this ceiling the answer is to
 * fan out over layers (see `shouldFanOut`), not to ask one call for more. */
export const STEP_CAP_SINGLE = 24;

/** Floor for one layer's ceiling in a fanned-out deep tour — what a normally
 * sized layer gets. Lower than the single cap because a tour's total is the sum
 * across layers; `layerStepCap` is how a bigger layer earns more than this. */
export const STEP_CAP_LAYER_MIN = 12;

/** Ceiling for one layer's call however big the layer is. Equal to the single
 * cap because the binding constraint is the same one — past ~24 steps a single
 * reply risks the model's output limit — and no one slice should be allowed to
 * ask for more than a whole-PR call would. */
export const STEP_CAP_LAYER_MAX = STEP_CAP_SINGLE;

/** Visible units past which a layer counts as oversized and starts earning
 * extra stops. Sits where `stepBudget`'s own target crosses
 * `STEP_CAP_LAYER_MIN`, so the cap is continuous across the knee rather than
 * jumping. */
const LAYER_CAP_KNEE = 13;

/** Extra stops per visible unit past the knee — a bit over half the base rate,
 * so roughly one more stop per 2 further files or ~200 further changed lines. */
const LAYER_CAP_SLOPE = 0.4;

/** Ceiling on layers. Past ~10 slices the layering stops being a reading order
 * and becomes a second file tree. */
export const LAYER_CAP = 10;

/** Fan-out thresholds — the point where one call can no longer cover the PR. */
export const FANOUT_FILES = 25;
export const FANOUT_CHURN = 1_500;
export const FANOUT_COVERAGE = 0.8;

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/**
 * Reviewable "units" in what the model can see: one per visible file, plus one
 * per ~80 visible changed lines. Files count because each one is its own context
 * switch for the reviewer; lines count because a 900-line file holds more than
 * one idea.
 */
export const reviewUnits = (s: PrSize): number => s.shownFiles + s.shownChurn / 80;

/**
 * How many guided-tour stops to ask for.
 *
 * Driven by VISIBLE size, not total: a PR where only 30% of the diff fit must
 * never be asked for 24 stops, or the model fills the gap by inventing anchors
 * in code it cannot see.
 *
 * | visible size      | units | steps          |
 * |-------------------|-------|----------------|
 * | 1 file, ≤10 lines | –     | 0–3 (trivial)  |
 * | 1 file, 40 lines  | 1.5   | 3–5            |
 * | 5 files, 250 lines| 8.1   | 5–9            |
 * | 15 files, 900     | 26.3  | 11–21          |
 * | 40 files, 3k      | 77.5  | 12–24 (capped) |
 *
 * A mid-size PR still lands on today's 4–10, so only the tails move.
 */
export function stepBudget(s: PrSize, opts?: { cap?: number }): CountBand {
  // A one-line tweak, a version bump, a config flag: preserve the prompt's
  // existing "may return an empty steps array" behaviour rather than demanding
  // stops that don't exist.
  if (s.files <= 1 && s.churn <= 10) return { min: 0, max: 3 };
  const target = Math.round(3 + reviewUnits(s) * 0.7);
  const max = Math.min(opts?.cap ?? STEP_CAP_SINGLE, Math.max(5, target));
  return { min: Math.max(2, Math.round(max * 0.5)), max };
}

/**
 * Ceiling for ONE layer's call in a fanned-out deep tour, scaled to the layer.
 *
 * A flat cap made every oversized layer look identical to the model: past ~13
 * visible units `stepBudget`'s target ran into the ceiling, so a 9-file layer
 * and a 60-file layer were both handed the same "6 to 12 stops" and came back
 * the same length. The ceiling now grows with what the model can SEE of the
 * layer — visible units, never total — so a big slice earns more stops without
 * ever being asked to narrate code that was truncated out of its context.
 *
 * | visible units | ~layer size          | cap |
 * |---------------|----------------------|-----|
 * | ≤13           | 8 files, 400 lines   | 12  |
 * | 20            | 12 files, 650 lines  | 15  |
 * | 30            | 18 files, 950 lines  | 19  |
 * | 43+           | 25 files, 1.4k lines | 24  |
 *
 * The tour's total is still the sum over layers (at most `LAYER_CAP` of them),
 * which is the price of covering a PR too big for one call honestly.
 */
export function layerStepCap(s: PrSize): number {
  const over = reviewUnits(s) - LAYER_CAP_KNEE;
  if (over <= 0) return STEP_CAP_LAYER_MIN;
  return clamp(
    Math.round(STEP_CAP_LAYER_MIN + over * LAYER_CAP_SLOPE),
    STEP_CAP_LAYER_MIN,
    STEP_CAP_LAYER_MAX,
  );
}

/**
 * How many layers to cut the PR into.
 *
 * Uses TOTAL files rather than visible ones: the layered planner is handed the
 * exhaustive path inventory by `buildLayerContext`, so it can layer files whose
 * diffs were truncated out of the context. Coverage is irrelevant to it.
 */
export function layerBudget(s: PrSize): CountBand {
  const target = Math.round(2 + s.files / 6);
  const max = Math.min(LAYER_CAP, Math.max(3, target));
  return { min: Math.max(2, Math.min(max - 1, Math.round(max * 0.6))), max };
}

/**
 * True when one call can no longer cover this PR honestly — either it's big
 * enough that a single tour would skip most of it, or so much of the diff was
 * truncated away that the model is reviewing blind. Above this line the tour
 * fans out over the layer partition instead, which has no total-step ceiling.
 */
export function shouldFanOut(s: PrSize): boolean {
  return s.files >= FANOUT_FILES || s.churn >= FANOUT_CHURN || s.coverage < FANOUT_COVERAGE;
}

/** Round a raw ratio into the 0..1 `coverage` field. */
export const toCoverage = (shown: number, total: number): number =>
  total <= 0 ? 1 : clamp(shown / total, 0, 1);
