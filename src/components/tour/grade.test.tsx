import { GRADE_STYLE, GradeLabel, PR_GRADE_HELP } from "@/components/tour/grade";
import { StepHeader } from "@/components/tour/step-header";
import type { Evidence } from "@/lib/ai/verify";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

describe("GradeLabel", () => {
  it("labels heuristic as unverified, like the stop's warning", () => {
    for (const g of ["exact", "strong", "heuristic"] as Evidence[]) {
      const html = renderToStaticMarkup(<GradeLabel grade={g} help={PR_GRADE_HELP} />);
      expect(html).toContain(`>${GRADE_STYLE[g].label}<`);
      expect(html).toContain(`aria-label="Grade: ${GRADE_STYLE[g].label}"`);
    }
    expect(GRADE_STYLE.heuristic.label).toBe("unverified");
  });

  it("sits in the stop header after the kind", () => {
    const html = renderToStaticMarkup(
      <StepHeader
        index={0}
        step={{ path: "a.ts", line: 1, kind: "orient", title: "T" }}
        trust="unchecked"
        showTrust={false}
        openLabel="x"
        onOpenFile={() => {}}
        grade={<GradeLabel grade="strong" help={PR_GRADE_HELP} />}
      />,
    );
    expect(html.indexOf("Orientation")).toBeLessThan(html.indexOf("Grade: strong"));
  });
});
