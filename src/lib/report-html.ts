/**
 * The review report as one self-contained HTML page.
 *
 * Every string in a report is untrusted: titles and paths come from the PR,
 * and everything else from a model. So the page escapes all of it, renders no
 * markdown (only backtick spans become `<code>`, after escaping), turns no
 * model text into a link, and ships with a CSP that allows no script at all.
 * The one link is the PR's own URL, and only when it is http(s).
 */
import { GRADE_LABEL } from "@/lib/ai/verify";
import type { Trust } from "@/lib/claim-check";
import type { CoverageBucket } from "@/lib/coverage";
import type { GuidedVerdict, StepKind } from "@/lib/guided";
import type { ReportStep, ReviewReport } from "@/lib/report";

export const REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

/** Escape text for an HTML text node or a double-quoted attribute. */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escape, then turn closed backtick spans into `<code>`. Nothing else. */
export function inline(s: string): string {
  const parts = s.split("`");
  if (parts.length % 2 === 0) return esc(s); // an unclosed span: leave it as text
  return parts.map((p, i) => (i % 2 === 1 ? `<code>${esc(p)}</code>` : esc(p))).join("");
}

/** Model prose as paragraphs: blank lines split, single newlines break. */
function prose(s: string): string {
  return s
    .trim()
    .split(/\n\s*\n/)
    .filter(Boolean)
    .map((p) => `<p>${p.split("\n").map(inline).join("<br>")}</p>`)
    .join("");
}

const KIND_LABEL: Record<StepKind, string> = {
  orient: "Orientation",
  concern: "Worth a comment",
  question: "Question",
  praise: "Nice",
};

const TRUST_LABEL: Record<Trust, string> = {
  verified: "Checked",
  contradicted: "Disputed",
  // Same word as the app's header filter. A stop whose check came back
  // partial lands here too; "How to read this" says so.
  unchecked: "Unchecked",
  unanchored: "Unverified",
};

const VERDICT_LABEL: Record<GuidedVerdict, string> = {
  approve: "Suggests approve",
  request_changes: "Suggests changes",
  comment: "Suggests comment",
};

const BUCKET_LABEL: Record<CoverageBucket, string> = {
  toured: "Toured",
  pending: "Pending (layer not toured yet)",
  skippable: "Skippable (generated, lockfile, format only)",
  tests: "Tests",
  unexamined: "Unexamined",
};
const BUCKETS: CoverageBucket[] = ["toured", "pending", "skippable", "tests", "unexamined"];

const fmtDate = (ms: number): string =>
  `${new Date(ms).toISOString().replace("T", " ").slice(0, 16)} UTC`;

const safeUrl = (u: string): string | null => (/^https?:\/\//i.test(u) ? u : null);

const chip = (cls: string, text: string): string => `<span class="chip ${cls}">${esc(text)}</span>`;

function stepHtml(s: ReportStep): string {
  const loc = `${s.path}:${s.line}${s.endLine ? `-${s.endLine}` : ""}`;
  const chips = [
    chip(`k-${s.kind}`, KIND_LABEL[s.kind]),
    chip(`g-${s.evidence.grade}`, GRADE_LABEL[s.evidence.grade]),
    chip(`t-${s.trust}`, TRUST_LABEL[s.trust]),
  ].join(" ");
  const why = s.evidence.reason ? `<p class="muted small">${inline(s.evidence.reason)}</p>` : "";
  const omitted = s.snippetOmitted
    ? `<p class="muted small">${s.snippetOmitted} more line${s.snippetOmitted === 1 ? "" : "s"} of this stop's range not shown.</p>`
    : "";
  const snippet = s.snippet.length
    ? `<pre class="diff">${s.snippet
        .map((l, i) => {
          const c = l[0] === "+" ? "add" : l[0] === "-" ? "del" : "ctx";
          return `<span class="${c}"><span class="ln">${s.snippetLines[i] ?? ""}</span>${esc(l)}</span>`;
        })
        // No separator: each span is a block, and a newline inside <pre>
        // would add a blank row between them.
        .join("")}</pre>${omitted}`
    : `<p class="muted small">No snippet: this line isn't in the file's diff.</p>`;

  let check = "";
  if (s.check?.type === "claims") {
    const head = s.check.unparsed
      ? "The check's reply could not be read."
      : s.check.claims.length === 0
        ? "The check found no factual claims."
        : `AI claim check (${esc(s.check.provider)}, ${fmtDate(s.check.checkedAt)})`;
    const rows = s.check.claims
      .map(
        (c) =>
          `<li class="claim c-${c.verdict}"><span class="verdict">${esc(c.verdict)}</span> ${inline(c.text)}${
            c.note ? `<span class="muted"> — ${inline(c.note)}</span>` : ""
          }${c.downgraded ? `<span class="muted"> (${esc(c.downgraded)})</span>` : ""}${
            c.path && c.line != null ? ` <code class="loc">${esc(c.path)}:${c.line}</code>` : ""
          }</li>`,
      )
      .join("");
    check = `<div class="check"><p class="small">${head}</p>${rows ? `<ul>${rows}</ul>` : ""}</div>`;
  } else if (s.check?.type === "concern") {
    check = `<div class="check"><p class="small">AI concern check (${esc(s.check.provider)}, ${fmtDate(
      s.check.checkedAt,
    )}): <strong>${s.check.verdict === "resolved" ? "not worth raising" : "valid"}</strong></p><p>${inline(
      s.check.finding,
    )}</p></div>`;
  }

  const suggestion = s.suggestion
    ? `<div class="suggestion"><p class="small muted">Suggested comment</p>${prose(s.suggestion)}</div>`
    : "";

  const body = `<div class="stop-head"><span class="num">${s.index + 1}</span> ${chips}</div>
<h3>${inline(s.title)}</h3>
<p class="loc"><code>${esc(loc)}</code></p>
${why}${snippet}${prose(s.detail)}${check}${suggestion}`;

  return s.dismissed
    ? `<details class="stop dismissed"><summary>Dismissed by the reviewer: ${inline(s.title)} <code>${esc(
        loc,
      )}</code></summary>${body}</details>`
    : `<section class="stop">${body}</section>`;
}

export function renderReportHtml(report: ReviewReport, opts?: { diagramSvg?: string }): string {
  const { pr, tour, coverage } = report;
  const url = safeUrl(pr.url);
  const title = `${pr.title} — Reviewly review report`;
  const out: string[] = [];

  // 1. Header.
  out.push(`<header>
<p class="muted small">Reviewly review report · ${esc(pr.key)}</p>
<h1>${url ? `<a href="${esc(url)}" rel="noopener noreferrer">${esc(pr.title)}</a>` : esc(pr.title)}</h1>
<p class="muted small">Head <code>${esc(pr.headSha.slice(0, 7))}</code> · exported ${fmtDate(
    report.exportedAt,
  )} · toured by ${esc(tour.provider)} on ${fmtDate(tour.generatedAt)} · Reviewly ${esc(report.app)}</p>
</header>`);

  // 2. Stale banner.
  if (tour.stale) {
    out.push(
      `<div class="banner warn" id="stale">This tour was made on <code>${esc(tour.headSha.slice(0, 7))}</code>, but the PR head is now <code>${esc(
        pr.headSha.slice(0, 7),
      )}</code>. Stops may describe code that has changed.</div>`,
    );
  }
  // 3. Partial banner.
  if (tour.layersToured && tour.layersToured.done < tour.layersToured.total) {
    out.push(
      `<div class="banner warn" id="partial">Partial tour: ${tour.layersToured.done} of ${tour.layersToured.total} layers toured. Files in the other layers are listed as pending.</div>`,
    );
  }

  // 4. Summary and verdict.
  const source =
    tour.summarySource === "layer-planner"
      ? "from the file list, not from reading the code"
      : tour.summarySource === "deep-synthesis"
        ? "from the toured layers' results"
        : "from the tour";
  out.push(`<section><h2>Summary</h2>
${prose(tour.summary || "(no summary)")}
<p class="muted small">Summary source: ${source}.</p>
${tour.strategy ? `<h3>How the tour reads the PR</h3>${prose(tour.strategy)}` : ""}
${
  tour.verdict
    ? `<p>${chip(`v-${tour.verdict}`, VERDICT_LABEL[tour.verdict])}${
        tour.verdictReason ? ` ${inline(tour.verdictReason)}` : ""
      }</p>`
    : ""
}
</section>`);

  // 5. How to read this.
  const g = { exact: 0, strong: 0, heuristic: 0 };
  const t: Record<Trust, number> = {
    verified: 0,
    contradicted: 0,
    unchecked: 0,
    unanchored: 0,
  };
  for (const s of report.steps) {
    g[s.evidence.grade]++;
    t[s.trust]++;
  }
  out.push(`<section><h2>How to read this</h2>
<ul>
<li><strong>Grades</strong> (${g.exact} exact · ${g.strong} strong · ${g.heuristic} unverified) show where a stop is anchored in the diff. They do not show whether the stop is true.</li>
<li><strong>Trust</strong> (${t.verified} checked · ${t.contradicted} disputed · ${t.unchecked} unchecked · ${t.unanchored} unverified) combines the grade with an AI check. Unchecked includes a stop whose check came back partial. AI checks are themselves AI calls and can be wrong.</li>
<li>The AI wrote every stop. Read the code before you act on one.</li>
</ul></section>`);

  // 6. Layers and diagram.
  if (report.layers?.length) {
    const items = report.layers
      .map(
        (l) =>
          `<li><strong>${l.index}. ${inline(l.title)}</strong> ${chip(`r-${l.risk}`, `${l.risk} risk`)}${
            l.toured ? "" : ` ${chip("t-unchecked", "not toured")}`
          }<br>${inline(l.intent)}${
            l.focus.length ? `<ul>${l.focus.map((f) => `<li>${inline(f)}</li>`).join("")}</ul>` : ""
          }<details><summary class="small">${l.files.length} file${l.files.length === 1 ? "" : "s"}</summary><ul class="files">${l.files
            .map((f) => `<li><code>${esc(f)}</code></li>`)
            .join("")}</ul></details></li>`,
      )
      .join("");
    out.push(
      `<section><h2>Layers</h2>${
        opts?.diagramSvg ? `<div class="diagram">${opts.diagramSvg}</div>` : ""
      }<ul class="layers">${items}</ul></section>`,
    );
  }

  // 7. Stops, grouped by layer.
  const layerTitle = new Map((report.layers ?? []).map((l) => [l.id, `${l.index}. ${l.title}`]));
  const groups: { id: string | undefined; steps: ReportStep[] }[] = [];
  for (const s of report.steps) {
    const last = groups[groups.length - 1];
    if (last && last.id === s.layerId) last.steps.push(s);
    else groups.push({ id: s.layerId, steps: [s] });
  }
  out.push(
    `<section><h2>Stops (${report.steps.length})</h2>${
      report.steps.length === 0 ? `<p class="muted">The tour has no stops.</p>` : ""
    }${groups
      .map(
        (gr) =>
          `${gr.id ? `<h3 class="layer-head">Layer ${inline(layerTitle.get(gr.id) ?? gr.id)}</h3>` : ""}${gr.steps
            .map(stepHtml)
            .join("")}`,
      )
      .join("")}</section>`,
  );

  // 8. Coverage.
  const unexamined = coverage.files.filter((f) => f.bucket === "unexamined");
  out.push(`<section id="coverage"><h2>Coverage</h2>
<table><thead><tr><th>Bucket</th><th>Files</th><th>Changed lines</th></tr></thead><tbody>${BUCKETS.map(
    (b) =>
      `<tr><td>${esc(BUCKET_LABEL[b])}</td><td>${coverage.counts[b]}</td><td>${coverage.churn[b]}</td></tr>`,
  ).join("")}</tbody></table>
${
  coverage.atRisk.length
    ? `<h3>Unexamined and sensitive</h3><ul class="files">${coverage.atRisk
        .map((p) => {
          const f = coverage.files.find((x) => x.path === p);
          return `<li><code>${esc(p)}</code> ${(f?.risks ?? []).map((r) => chip("risk", r)).join(" ")}</li>`;
        })
        .join("")}</ul>`
    : ""
}
<h3>Unexamined files (${unexamined.length})</h3>
${
  unexamined.length
    ? `<ul class="files" id="unexamined">${unexamined
        .map(
          (f) =>
            `<li><code>${esc(f.path)}</code> <span class="muted small">+${f.additions} −${f.deletions}</span></li>`,
        )
        .join("")}</ul>`
    : `<p class="muted">Every changed file has a stop, is pending, or is skippable.</p>`
}
</section>`);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
${out.join("\n")}
</main>
</body>
</html>
`;
}

const CSS = `
:root{--bg:#fbfbfa;--fg:#1d1d1f;--muted:#6b6b70;--card:#ffffff;--line:#e4e4e7;--code:#f1f1f3;
--ok:#1a7f37;--ok-bg:#dafbe1;--warn:#9a6700;--warn-bg:#fff8c5;--bad:#cf222e;--bad-bg:#ffebe9;--info:#0969da;--info-bg:#ddf4ff;
--add:#e6ffec;--del:#ffebe9}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#e8e8ea;--muted:#9a9aa2;--card:#1c1c1f;--line:#2e2e33;--code:#26262b;
--ok:#3fb950;--ok-bg:#12261a;--warn:#d29922;--warn-bg:#2b2111;--bad:#f85149;--bad-bg:#2d1416;--info:#58a6ff;--info-bg:#10233a;
--add:#12261a;--del:#2d1416}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:1.5rem;line-height:1.3;margin:.2em 0}
h2{font-size:1.15rem;margin:2em 0 .6em;border-bottom:1px solid var(--line);padding-bottom:.3em}
h3{font-size:1rem;margin:.6em 0 .3em}
a{color:var(--info)}
code{font:.88em/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);padding:.1em .3em;border-radius:4px;overflow-wrap:anywhere}
.muted{color:var(--muted)}.small{font-size:.85rem}
.banner{padding:10px 12px;border-radius:8px;margin:12px 0}
.warn{background:var(--warn-bg);color:var(--warn)}
.chip{display:inline-block;font-size:.72rem;font-weight:600;padding:1px 8px;border-radius:999px;background:var(--code);color:var(--muted);white-space:nowrap}
.k-concern,.r-high{background:var(--warn-bg);color:var(--warn)}.k-question{background:var(--info-bg);color:var(--info)}.k-praise{background:var(--ok-bg);color:var(--ok)}
.g-exact,.t-verified,.v-approve{background:var(--ok-bg);color:var(--ok)}
.g-heuristic,.t-unanchored,.v-request_changes,.risk{background:var(--warn-bg);color:var(--warn)}
.t-contradicted{background:var(--bad-bg);color:var(--bad)}.v-comment{background:var(--info-bg);color:var(--info)}
.stop,details.stop{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:12px 0}
details.dismissed{opacity:.75}details summary{cursor:pointer}
.stop-head{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.num{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;border-radius:999px;background:var(--code);font-size:.75rem;color:var(--muted)}
p.loc{margin:0 0 .5em}
pre.diff{background:var(--code);border-radius:8px;padding:8px 0;overflow-x:auto;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:.5em 0}
pre.diff>span{display:block;padding:0 10px 0 0;white-space:pre}
pre.diff .add{background:var(--add)}pre.diff .del{background:var(--del)}
pre.diff .ln{display:inline-block;min-width:3.2em;padding-right:.8em;text-align:right;color:var(--muted);user-select:none}
.check{border-left:3px solid var(--line);padding:2px 0 2px 10px;margin:.6em 0}
.check ul{padding-left:1.1em;margin:.3em 0}
.claim .verdict{font-size:.72rem;font-weight:700;text-transform:uppercase}
.c-supported .verdict{color:var(--ok)}.c-misplaced .verdict{color:var(--warn)}.c-contradicted{color:var(--bad)}.c-contradicted .verdict{color:var(--bad)}.c-unverifiable{color:var(--muted)}
.suggestion{background:var(--code);border-radius:8px;padding:6px 10px;margin:.6em 0}
.layers{list-style:none;padding-left:0}.layers>li{margin:.6em 0}.files{padding-left:1.1em}
.diagram{overflow-x:auto;margin:.6em 0;background:#fff;border-radius:8px;padding:8px}.diagram svg{max-width:100%;height:auto}
table{border-collapse:collapse;width:100%;font-size:.9rem}
th,td{text-align:left;padding:4px 8px;border-bottom:1px solid var(--line)}
td:not(:first-child),th:not(:first-child){text-align:right}
`;
