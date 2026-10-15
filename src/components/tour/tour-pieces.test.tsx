import { RailStop } from "@/components/tour/rail-stop";
import { StepHeader } from "@/components/tour/step-header";
import type { GuidedStep } from "@/lib/guided";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

/**
 * The PR tour's rail and step header moved into `components/tour/` so the
 * codebase tour can share them. The PR tour must look the same after the
 * move: these pin the markup it depends on.
 */
const step: GuidedStep = {
  path: "src/billing/price.ts",
  line: 12,
  endLine: 14,
  kind: "concern",
  title: "Zero-quantity items skipped",
  detail: "d",
};

describe("StepHeader", () => {
  it("renders the PR tour's sticky header: number, kind, title, full path", () => {
    const html = renderToStaticMarkup(
      <StepHeader
        index={2}
        step={step}
        trust="unchecked"
        showTrust={false}
        openLabel="Open src/billing/price.ts in the diff"
        onOpenFile={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(html).toContain("sticky top-0 z-20");
    expect(html).toContain(">3<");
    expect(html).toContain("Worth a comment");
    expect(html).toContain("Zero-quantity items skipped");
    expect(html).toContain("src/billing/");
    expect(html).toContain("price.ts:12-14");
    expect(html).toContain('aria-label="Open src/billing/price.ts in the diff"');
    expect(html).toContain('aria-label="Dismiss this stop"');
    expect(html).not.toContain("Disputed");
  });

  it("shows a trust chip only when asked", () => {
    const html = renderToStaticMarkup(
      <StepHeader
        index={0}
        step={step}
        trust="contradicted"
        showTrust
        openLabel="x"
        onOpenFile={() => {}}
      />,
    );
    expect(html).toContain("Disputed");
    expect(html).not.toContain("Dismiss this stop");
  });

  it("takes a surface's own kind label", () => {
    const html = renderToStaticMarkup(
      <StepHeader
        index={0}
        step={step}
        trust="unchecked"
        showTrust={false}
        openLabel="x"
        onOpenFile={() => {}}
        kindLabels={{ concern: "Pitfall" }}
      />,
    );
    expect(html).toContain("Pitfall");
    expect(html).not.toContain("Worth a comment");
  });
});

describe("RailStop", () => {
  it("renders the PR tour's rail row: kind label, title, and done state", () => {
    const html = renderToStaticMarkup(
      <RailStop
        step={step}
        active={false}
        done
        first
        last={false}
        aboveFilled
        belowFilled
        onClick={() => {}}
      />,
    );
    expect(html).toContain("Worth a comment");
    expect(html).toContain("Zero-quantity items skipped");
    expect(html).toContain("<svg"); // the done check mark
  });
});

describe("backticks in titles", () => {
  const ticked = { ...step, title: "Default `forms_dir` moves under `shared/`" };

  it("render as code in the step header and the rail, not as literal backticks", () => {
    for (const html of [
      renderToStaticMarkup(
        <StepHeader
          index={0}
          step={ticked}
          trust="unchecked"
          showTrust={false}
          openLabel="x"
          onOpenFile={() => {}}
        />,
      ),
      renderToStaticMarkup(
        <RailStop
          step={ticked}
          active={false}
          done={false}
          first
          last
          aboveFilled={false}
          belowFilled={false}
          onClick={() => {}}
        />,
      ),
    ]) {
      expect(html).toMatch(/<code[^>]*>forms_dir<\/code>/);
      expect(html).not.toContain("`");
    }
  });

  it("calls an unanchored stop Unverified, the same word as the grade", () => {
    const html = renderToStaticMarkup(
      <StepHeader
        index={0}
        step={step}
        trust="unanchored"
        showTrust
        openLabel="x"
        onOpenFile={() => {}}
      />,
    );
    expect(html).toContain("Unverified");
    expect(html).not.toContain("Unanchored");
  });
});
