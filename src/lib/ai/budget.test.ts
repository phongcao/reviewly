import {
  type PrSize,
  STEP_CAP_LAYER_MAX,
  STEP_CAP_LAYER_MIN,
  layerStepCap,
  reviewUnits,
  stepBudget,
} from "@/lib/ai/budget";
import { describe, expect, it } from "vitest";

/** A layer as the model sees it — everything visible, which is the case the cap
 * is written for. */
const layer = (shownFiles: number, shownChurn: number): PrSize => ({
  files: shownFiles,
  churn: shownChurn,
  shownFiles,
  shownChurn,
  coverage: 1,
});

/** What the prompt actually asks a layer call for. */
const band = (s: PrSize) => stepBudget(s, { cap: layerStepCap(s) });

describe("layerStepCap", () => {
  it("leaves a normally sized layer on the old flat ceiling", () => {
    expect(layerStepCap(layer(3, 120))).toBe(STEP_CAP_LAYER_MIN);
    expect(layerStepCap(layer(8, 400))).toBe(STEP_CAP_LAYER_MIN);
  });

  it("is continuous at the knee — no jump as a layer crosses it", () => {
    const below = layer(8, 390);
    const above = layer(8, 410);
    expect(reviewUnits(below)).toBeLessThan(13);
    expect(reviewUnits(above)).toBeGreaterThan(13);
    expect(layerStepCap(above) - layerStepCap(below)).toBeLessThanOrEqual(1);
  });

  it("grows the ceiling as the layer grows", () => {
    expect(layerStepCap(layer(12, 650))).toBe(15);
    expect(layerStepCap(layer(18, 950))).toBe(19);
  });

  it("never exceeds a whole-PR call's ceiling", () => {
    expect(layerStepCap(layer(25, 1_400))).toBe(STEP_CAP_LAYER_MAX);
    expect(layerStepCap(layer(300, 40_000))).toBe(STEP_CAP_LAYER_MAX);
  });

  it("is monotonic in layer size", () => {
    let prev = 0;
    for (const files of [1, 4, 8, 12, 18, 25, 40, 80, 200]) {
      const cap = layerStepCap(layer(files, files * 55));
      expect(cap).toBeGreaterThanOrEqual(prev);
      prev = cap;
    }
  });
});

describe("layer step band", () => {
  it("no longer hands every big layer the identical ask", () => {
    const small = band(layer(9, 500));
    const huge = band(layer(40, 2_000));
    expect(huge.max).toBeGreaterThan(small.max);
    expect(huge.min).toBeGreaterThan(small.min);
  });

  it("keeps small layers exactly where they were", () => {
    expect(band(layer(2, 60))).toEqual(stepBudget(layer(2, 60), { cap: STEP_CAP_LAYER_MIN }));
  });

  it("still scales the ask down when most of the layer was truncated away", () => {
    // 60 files changed, but only a handful survived the layer diff budget: the
    // ask must follow what is VISIBLE, never the layer's real size.
    const blind: PrSize = {
      files: 60,
      churn: 6_000,
      shownFiles: 4,
      shownChurn: 200,
      coverage: 0.03,
    };
    expect(layerStepCap(blind)).toBe(STEP_CAP_LAYER_MIN);
    expect(band(blind).max).toBeLessThan(STEP_CAP_LAYER_MIN);
  });
});
