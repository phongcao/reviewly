import { buildReviewReport } from "@/lib/report";
import { REPORT_CSP, inline, renderReportHtml } from "@/lib/report-html";
import { SAMPLE_INPUT, SAMPLE_STEPS } from "@/lib/report.fixture";
import { describe, expect, it } from "vitest";

const report = (o: Partial<typeof SAMPLE_INPUT> = {}) =>
  buildReviewReport({ ...SAMPLE_INPUT, ...o });

describe("renderReportHtml", () => {
  it("escapes a step title that carries markup", () => {
    const steps = [{ ...SAMPLE_STEPS[0], title: "<img src=x onerror=alert(1)>" }];
    const html = renderReportHtml(report({ plan: { ...SAMPLE_INPUT.plan, steps } }));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("never turns a javascript: URL in a detail into a link", () => {
    const steps = [
      { ...SAMPLE_STEPS[0], detail: "See [here](javascript:alert(1)) or javascript:alert(2)" },
    ];
    const html = renderReportHtml(report({ plan: { ...SAMPLE_INPUT.plan, steps } }));
    expect(html).not.toMatch(/href="javascript:/i);
    // The PR URL is the only link on the page.
    expect(html.match(/<a /g)).toHaveLength(1);
  });

  it("drops a PR URL that isn't http(s)", () => {
    const html = renderReportHtml(
      report({ pr: { ...SAMPLE_INPUT.pr, url: "javascript:alert(1)" } }),
    );
    expect(html).not.toContain("<a ");
  });

  it("keeps an imported bundle's enum values inside their class attributes", () => {
    const evil = '"><meta http-equiv="refresh" content="0;url=https://evil.example">';
    const steps = [{ ...SAMPLE_STEPS[0], kind: evil } as unknown as (typeof SAMPLE_STEPS)[0]];
    const html = renderReportHtml(report({ plan: { ...SAMPLE_INPUT.plan, steps } }));
    expect(html).not.toContain('<meta http-equiv="refresh"');
    expect(html).not.toContain("evil.example");
  });

  it("forbids form posts and <base> in its CSP", () => {
    expect(REPORT_CSP).toContain("form-action 'none'");
    expect(REPORT_CSP).toContain("base-uri 'none'");
  });

  it("carries the CSP meta tag and no script", () => {
    const html = renderReportHtml(report());
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">`);
    expect(html).not.toMatch(/<script/i);
  });

  it("shows the stale and partial banners only when their conditions hold", () => {
    const both = renderReportHtml(report());
    expect(both).toContain('id="stale"');
    expect(both).toContain('id="partial"');

    const fresh = renderReportHtml(
      report({
        tour: {
          ...SAMPLE_INPUT.tour,
          headSha: SAMPLE_INPUT.pr.headSha,
          layersToured: { done: 2, total: 2 },
        },
      }),
    );
    expect(fresh).not.toContain('id="stale"');
    expect(fresh).not.toContain('id="partial"');
  });

  it("lists every unexamined file", () => {
    const r = report({ pendingPaths: new Set() });
    const html = renderReportHtml(r);
    const unexamined = r.coverage.files.filter((f) => f.bucket === "unexamined");
    expect(unexamined.length).toBeGreaterThan(1);
    for (const f of unexamined) expect(html).toContain(`<code>${f.path}</code>`);
  });

  it("collapses and labels a dismissed stop", () => {
    const html = renderReportHtml(report());
    expect(html).toContain('<details class="stop dismissed"><summary>Dismissed by the reviewer');
  });

  it("labels a summary written from the file list", () => {
    expect(renderReportHtml(report())).toContain("from the file list");
  });

  it("numbers the layer titles once, not again with list markers", () => {
    const html = renderReportHtml(report());
    expect(html).toContain('<ul class="layers">');
    expect(html).not.toContain("<ol");
  });

  it("names the unchecked count as the app's header filter does", () => {
    const html = renderReportHtml(report());
    expect(html).toMatch(/\d+ unchecked · \d+ unverified\)/);
    expect(html).toContain("Unchecked includes a stop whose check came back partial.");
    expect(html).not.toContain("not backed");
  });

  it("numbers snippet lines and leaves a deleted line blank", () => {
    const html = renderReportHtml(report());
    expect(html).toContain(
      '<span class="add"><span class="ln">12</span>+    if (item.quantity &lt;= 0) {</span>',
    );
    expect(html).toContain('<span class="del"><span class="ln"></span>-export function refresh');
  });

  it("says when a snippet cuts the stop's range short", () => {
    const r = report();
    r.steps[0].snippetOmitted = 12;
    expect(renderReportHtml(r)).toContain("12 more lines of this stop's range not shown.");
    expect(renderReportHtml(report())).not.toContain("of this stop's range not shown");
  });

  it("embeds a diagram only when given one", () => {
    expect(renderReportHtml(report())).not.toContain('class="diagram"');
    expect(renderReportHtml(report(), { diagramSvg: "<svg></svg>" })).toContain(
      '<div class="diagram"><svg></svg></div>',
    );
  });
});

describe("inline", () => {
  it("escapes first, then turns backtick spans into code", () => {
    expect(inline("`a<b` & `c`")).toBe("<code>a&lt;b</code> &amp; <code>c</code>");
  });

  it("leaves an unclosed span as text", () => {
    expect(inline("a `b")).toBe("a `b");
  });
});
