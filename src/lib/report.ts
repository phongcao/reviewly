/**
 * The review report: one derived model of a tour for readers outside
 * Reviewly — the HTML page a PR author opens.
 *
 * The review-data bundle can't serve this. It holds the tour as the app stores
 * it, without the diff, so a consumer can compute neither grades, nor
 * snippets, nor coverage from it. The report carries all three, computed here
 * by the same functions the tour pane uses, so the page says what the app
 * showed.
 *
 * Pure: every input is passed in, including the clock and the app version, so
 * tests can pin the exact output.
 */
import { type StepEvidence, groundInClone, prCorpus, verifyStep } from "@/lib/ai/verify";
import { type CheckRecord, type Trust, stepTrust } from "@/lib/claim-check";
import { type CoverageBucket, type RiskCategory, tourCoverage } from "@/lib/coverage";
import { stepId } from "@/lib/deep-tour";
import { anchorWindow } from "@/lib/diff";
import type { GuidedPlan, GuidedVerdict, StepKind } from "@/lib/guided";
import type { LayerEdge } from "@/lib/layer-edges";
import type { LayerPlan, LayerRisk } from "@/lib/layers";
import type { PullFile } from "@/lib/tauri";

/** Most patch lines a stop's snippet carries. */
export const SNIPPET_MAX = 30;

/** Where the report's summary came from — readers must know when it was
 * written from a file list rather than from reading the code. */
export type SummarySource = "tour" | "layer-planner" | "deep-synthesis";

export interface ReportStep {
  id: string;
  /** Position in the tour's reading order, 0-based. */
  index: number;
  layerId?: string;
  path: string;
  line: number;
  endLine?: number;
  kind: StepKind;
  title: string;
  detail: string;
  suggestion?: string;
  evidence: StepEvidence;
  check?: CheckRecord;
  trust: Trust;
  /** The reviewer hid this stop. Kept, because a report that silently drops
   * stops misstates what the tour said. */
  dismissed: boolean;
  /** Raw patch lines with their `+`/`-`/` ` prefix around the anchor. */
  snippet: string[];
  /** New-file line number of each `snippet` line; null on a deleted line. */
  snippetLines: (number | null)[];
  /** Lines of the stop's own range cut by the `SNIPPET_MAX` cap. */
  snippetOmitted?: number;
}

export interface ReportLayer {
  id: string;
  /** 1-based reading position. */
  index: number;
  title: string;
  intent: string;
  focus: string[];
  risk: LayerRisk;
  files: string[];
  toured: boolean;
}

export interface ReviewReport {
  exportedAt: number;
  app: string;
  pr: { key: string; title: string; url: string; headSha: string };
  tour: {
    type: "classic" | "deep";
    provider: string;
    generatedAt: number;
    headSha: string;
    /** The tour was made on another head than the PR has now. */
    stale: boolean;
    summary: string;
    summarySource: SummarySource;
    strategy: string;
    verdict?: GuidedVerdict;
    verdictReason?: string;
    layersToured?: { done: number; total: number };
  };
  layers?: ReportLayer[];
  edges?: LayerEdge[];
  steps: ReportStep[];
  coverage: {
    counts: Record<CoverageBucket, number>;
    churn: Record<CoverageBucket, number>;
    files: {
      path: string;
      bucket: CoverageBucket;
      stops: number;
      risks: RiskCategory[];
      additions: number;
      deletions: number;
    }[];
    atRisk: string[];
  };
}

export interface ReviewReportInput {
  pr: { key: string; title: string; url: string; headSha: string };
  /** The merged plan: the classic entry's, or `mergeDeepTour`'s. */
  plan: GuidedPlan;
  tour: {
    type: "classic" | "deep";
    headSha: string;
    provider: string;
    generatedAt: number;
    /** Defaults by type: `tour` for classic, `layer-planner` for deep. */
    summarySource?: SummarySource;
    layersToured?: { done: number; total: number };
  };
  /** The layer partition, reconciled against `files`, and which layers have a
   * tour. Omit for a tour with no layers. */
  layers?: { plan: LayerPlan; toured: ReadonlySet<string> };
  edges?: LayerEdge[];
  files: PullFile[];
  /** Names found in the local clone, so the report grades stops exactly as
   * the tour pane did — see `groundInClone`. */
  cloneNames?: ReadonlySet<string>;
  /** Step checks for the PR's current head, by `stepId`. */
  checks?: Record<string, CheckRecord>;
  dismissedIds: ReadonlySet<string>;
  /** Files of layers not toured yet — reported as `pending`, not `unexamined`. */
  pendingPaths?: ReadonlySet<string>;
  exportedAt: number;
  app: string;
}

export interface StepSnippet {
  lines: string[];
  numbers: (number | null)[];
  /** Lines of the anchored range that did not fit. */
  omitted: number;
}

/** A stop's snippet: the same window `InlineDiff` draws, capped at
 * `SNIPPET_MAX` lines. Over the cap, the surrounding context goes first, then
 * the tail of the range — so the anchor is always inside, and `omitted` says
 * how much of the range the reader is not shown. */
export function stepSnippet(
  files: PullFile[],
  path: string,
  line: number,
  endLine?: number,
): StepSnippet {
  const file = files.find((f) => f.filename === path);
  const hi = endLine && endLine >= line ? endLine : line;
  let rows = anchorWindow(file?.patch, line, hi) ?? [];
  let omitted = 0;
  if (rows.length > SNIPPET_MAX) {
    const inRange = (n: number | null) => n != null && n >= line && n <= hi;
    const first = rows.findIndex((l) => inRange(l.newLine));
    let last = rows.length - 1;
    while (last >= 0 && !inRange(rows[last].newLine)) last--;
    if (first < 0) {
      rows = rows.slice(0, SNIPPET_MAX);
    } else if (last - first + 1 >= SNIPPET_MAX) {
      omitted = last - first + 1 - SNIPPET_MAX;
      rows = rows.slice(first, first + SNIPPET_MAX);
    } else {
      // Split the spare lines between leading and trailing context.
      // Either side's unused share goes to the other.
      const spare = SNIPPET_MAX - (last - first + 1);
      let before = Math.min(first, Math.floor(spare / 2));
      const after = Math.min(rows.length - 1 - last, spare - before);
      before = Math.min(first, spare - after);
      rows = rows.slice(first - before, last + after + 1);
    }
  }
  return {
    lines: rows.map((l) => `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}`),
    numbers: rows.map((l) => (l.kind === "del" ? null : l.newLine)),
    omitted,
  };
}

export function buildReviewReport(input: ReviewReportInput): ReviewReport {
  const { plan, files } = input;
  const corpus = prCorpus(files);

  const steps: ReportStep[] = plan.steps.map((s, index) => {
    const id = stepId(s);
    const evidence = groundInClone(verifyStep(s, files, corpus), input.cloneNames);
    const check = input.checks?.[id];
    const snippet = stepSnippet(files, s.path, s.line, s.endLine);
    return {
      id,
      index,
      ...(s.layerId ? { layerId: s.layerId } : {}),
      path: s.path,
      line: s.line,
      ...(s.endLine ? { endLine: s.endLine } : {}),
      kind: s.kind,
      title: s.title,
      detail: s.detail,
      ...(s.suggestion ? { suggestion: s.suggestion } : {}),
      evidence,
      ...(check ? { check } : {}),
      trust: stepTrust(evidence.grade, check),
      dismissed: input.dismissedIds.has(id),
      snippet: snippet.lines,
      snippetLines: snippet.numbers,
      ...(snippet.omitted ? { snippetOmitted: snippet.omitted } : {}),
    };
  });

  // Same call, same inputs as the tour pane's coverage strip.
  const cov = tourCoverage(plan.steps, files, input.pendingPaths);

  const layers = input.layers?.plan.layers.map(
    (l, i): ReportLayer => ({
      id: l.id,
      index: i + 1,
      title: l.title,
      intent: l.intent,
      focus: l.focus,
      risk: l.risk,
      files: l.files,
      toured: input.layers?.toured.has(l.id) ?? false,
    }),
  );

  return {
    exportedAt: input.exportedAt,
    app: input.app,
    pr: { ...input.pr, title: input.pr.title.trim() },
    tour: {
      type: input.tour.type,
      provider: input.tour.provider,
      generatedAt: input.tour.generatedAt,
      headSha: input.tour.headSha,
      stale: !!input.tour.headSha && input.tour.headSha !== input.pr.headSha,
      summary: plan.summary,
      summarySource:
        input.tour.summarySource ?? (input.tour.type === "deep" ? "layer-planner" : "tour"),
      strategy: plan.tour,
      ...(plan.verdict ? { verdict: plan.verdict } : {}),
      ...(plan.verdictReason ? { verdictReason: plan.verdictReason } : {}),
      ...(input.tour.layersToured ? { layersToured: input.tour.layersToured } : {}),
    },
    ...(layers ? { layers } : {}),
    ...(input.edges ? { edges: input.edges } : {}),
    steps,
    coverage: {
      counts: cov.counts,
      churn: cov.churn,
      files: cov.files.map((f) => ({
        path: f.file.filename,
        bucket: f.bucket,
        stops: f.stops,
        risks: f.risks,
        additions: f.file.additions,
        deletions: f.file.deletions,
      })),
      atRisk: cov.atRisk.map((f) => f.file.filename),
    },
  };
}

/** `reviewly-<owner>-<repo>-<number>-<shortsha>.html` for the save dialog. */
export function reportFilename(report: Pick<ReviewReport, "pr">): string {
  const [ownerRepo, number = ""] = report.pr.key.split("#");
  const [owner = "", repo = ""] = ownerRepo.split("/");
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_");
  const sha = report.pr.headSha.slice(0, 7) || "nohead";
  return `reviewly-${safe(owner)}-${safe(repo)}-${safe(number)}-${sha}.html`;
}
