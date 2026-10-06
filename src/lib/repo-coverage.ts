/**
 * What a codebase tour did not explore — the repository counterpart of
 * `coverage.ts`. A PR tour counts changed lines; a repository has no change,
 * so the unit is the module, weighted by its source lines, and "at risk" is
 * an unexplored module whose files look sensitive.
 */
import { fileRank } from "@/lib/ai/context";
import { type RiskCategory, riskFromText } from "@/lib/coverage";
import { isTestFile } from "@/lib/focus";
import type { GuidedStep } from "@/lib/guided";
import type { RepoModule } from "@/lib/repo-modules";

export type RepoBucket = "toured" | "pending" | "skippable" | "tests" | "unexplored";

export interface ModuleCoverage {
  module: RepoModule;
  bucket: RepoBucket;
  stops: number;
  risks: RiskCategory[];
}

export interface RepoCoverageReport {
  modules: ModuleCoverage[];
  counts: Record<RepoBucket, number>;
  /** Source lines per bucket — the weight of each gap. */
  lines: Record<RepoBucket, number>;
  /** Unexplored modules that look sensitive, biggest first. */
  atRisk: ModuleCoverage[];
}

const EMPTY = (): Record<RepoBucket, number> => ({
  toured: 0,
  pending: 0,
  skippable: 0,
  tests: 0,
  unexplored: 0,
});

/**
 * Bucket every module. `pendingModules` are modules whose layer has no tour
 * yet — in flight or never run — so they read as queued, not as gaps.
 * `heads` maps a path to the text read from it (file heads), for the risk
 * scan; a path with no text is judged by its path alone.
 */
export function repoCoverage(
  steps: GuidedStep[],
  modules: RepoModule[],
  heads: ReadonlyMap<string, string>,
  pendingModules?: ReadonlySet<string>,
): RepoCoverageReport {
  const stopsByPath = new Map<string, number>();
  for (const s of steps) stopsByPath.set(s.path, (stopsByPath.get(s.path) ?? 0) + 1);
  const counts = EMPTY();
  const lines = EMPTY();
  const out: ModuleCoverage[] = [];
  for (const m of modules) {
    const stops = m.files.reduce((n, f) => n + (stopsByPath.get(f) ?? 0), 0);
    const bucket: RepoBucket =
      stops > 0
        ? "toured"
        : pendingModules?.has(m.id)
          ? "pending"
          : m.files.length > 0 && m.files.every((f) => fileRank(f) === 3)
            ? "skippable"
            : m.files.length > 0 && m.files.every(isTestFile)
              ? "tests"
              : "unexplored";
    const risks = [...new Set(m.files.flatMap((f) => riskFromText(f, heads.get(f) ?? "")))];
    counts[bucket]++;
    lines[bucket] += m.lines;
    out.push({ module: m, bucket, stops, risks });
  }
  const atRisk = out
    .filter((c) => c.bucket === "unexplored" && c.risks.length > 0)
    .sort((a, b) => b.module.lines - a.module.lines);
  return { modules: out, counts, lines, atRisk };
}
