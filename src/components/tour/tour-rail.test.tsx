import { TourRail } from "@/components/tour/tour-rail";
import { type GuidedStep, type TourLayer, layerReadCounts, tourLayerIndex } from "@/lib/guided";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

/** The rail moved out of the PR tour so the codebase tour can share it; these
 * pin the markup the PR tour relied on. */
const step = (layerId: string, title: string): GuidedStep => ({
  path: "a.ts",
  line: 1,
  kind: "orient",
  title,
  detail: "d",
  layerId,
});
const layer = (id: string, index: number): TourLayer => ({
  id,
  title: `Layer ${id}`,
  index,
  total: 2,
  steps: 2,
});
const layers = [layer("l1", 1), layer("l2", 2)];
const steps = [step("l1", "One"), step("l1", "Two"), step("l2", "Three")];
const visible = [0, 1, 2];

const render = (o: { collapsed?: string[]; collapsible?: boolean; action?: boolean } = {}) =>
  renderToStaticMarkup(
    <TourRail
      steps={steps}
      index={tourLayerIndex(visible, steps, layers)}
      layerDone={layerReadCounts(visible, steps, new Set([0]))}
      pos={1}
      active={1}
      seen={new Set([0])}
      activeLayer={layers[0]}
      layerPos={2}
      collapse={
        o.collapsible === false
          ? undefined
          : { collapsed: new Set(o.collapsed ?? []), toggle: () => {}, setAll: () => {} }
      }
      onJump={() => {}}
      layerAction={o.action ? (l) => <span>act-{l.id}</span> : undefined}
    />,
  );

describe("TourRail", () => {
  it("groups stops under abbreviated layer headings that control their rows", () => {
    const html = render();
    expect(html).toContain("L1/2");
    expect(html).toContain("L2/2");
    expect(html).toContain('aria-controls="tour-layer-l1"');
    expect(html).toContain('id="tour-layer-l2"');
    expect(html).toContain("1/2");
    expect(html).toContain("Three");
  });

  it("offers collapse-all only with collapse support and more than one layer", () => {
    expect(render()).toContain('aria-label="Collapse all layers"');
    expect(render({ collapsible: false })).not.toContain("Collapse all layers");
  });

  it("hides a folded layer's rows with the hidden class", () => {
    expect(render({ collapsed: ["l2"] })).toContain('id="tour-layer-l2" class="hidden"');
  });

  it("renders the caller's layer action", () => {
    expect(render({ action: true })).toContain("act-l1");
  });
});
