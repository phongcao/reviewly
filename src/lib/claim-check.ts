/**
 * Second-opinion checks on tour stops, and the trust value they feed.
 *
 * `verify.ts` grades where a stop is ANCHORED — an `exact` grade means the
 * line exists and the backticked names are in the diff, not that the sentence
 * about them is true. The checks here are the other half: a separate AI call,
 * in a fresh context that cannot see the rest of the tour, reads the stop's
 * claims against the code and says which ones the code shows.
 *
 * A checker is itself a model, so its output is held to the same rule the
 * tour is: everything ambiguous falls toward LESS trust. An unknown verdict, a
 * "supported" with no cited line, or a cited line the checker could not have
 * seen all become `unverifiable`. Nothing here can promote a stop on the
 * strength of output it failed to parse.
 */
import { extractObjects, stripFence, toArray, toInt } from "@/lib/ai/json";
import { MAX_CLAIMS } from "@/lib/ai/prompts";
import { type Evidence, findFile } from "@/lib/ai/verify";
import { parsePatch } from "@/lib/diff";
import type { FollowUpResult } from "@/lib/followups";
import type { GuidedStep, StepKind } from "@/lib/guided";
import type { PullFile } from "@/lib/tauri";

/** Verdict the clone-backed concern check ("Check with AI") returns. */
export type CheckResult = { verdict: "resolved" | "valid"; finding: string };

/** Pull the verdict JSON from the agent's (possibly chatty) reply. Unparseable
 *  output is treated as "valid" so we never auto-dismiss on ambiguity. */
export function parseCheckResult(out: string): CheckResult {
  const m = out.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]) as { verdict?: unknown; finding?: unknown };
      return {
        verdict: o.verdict === "resolved" ? "resolved" : "valid",
        finding: typeof o.finding === "string" && o.finding.trim() ? o.finding.trim() : out.trim(),
      };
    } catch {
      /* fall through to raw-text fallback */
    }
  }
  return { verdict: "valid", finding: out.trim() };
}

/** `misplaced`: the behavior is real, but the stop cited the wrong place for it.
 * The checker's cite is where it actually happens. */
export type ClaimVerdict = "supported" | "misplaced" | "contradicted" | "unverifiable";

/** One atomic claim out of a stop, with the checker's verdict on it. */
export interface CheckedClaim {
  text: string;
  verdict: ClaimVerdict;
  /** The cited location. Absent when the checker cited nothing. */
  path?: string;
  line?: number;
  /** The checker's one-clause reason. */
  note: string;
  /** Set when the parser overrode the checker's verdict, and why. Shown so a
   * reviewer can tell "the checker had no evidence" from "the checker cited
   * evidence it could not have seen". */
  downgraded?: string;
}

/** The whole stop's result: any contradiction sinks it, and only a non-empty,
 * all-supported set lifts it. Everything else is `partial`, including a
 * misplaced cite: the behavior holds, but the stop points at the wrong code. */
export type ClaimsResult = "supported" | "contradicted" | "partial";

/** A stored check on one stop. Two shapes because the two checks ask different
 * questions: a concern check asks "is this worth raising?", a claim check asks
 * "is each sentence true?". */
export type CheckRecord =
  | {
      type: "concern";
      verdict: "resolved" | "valid";
      finding: string;
      checkedAt: number;
      provider: string;
    }
  | {
      type: "claims";
      result: ClaimsResult;
      claims: CheckedClaim[];
      /** True when the checker's reply held no readable JSON at all — kept
       * apart from a real "no factual claims" so the UI doesn't present a
       * parse failure as a finding. */
      unparsed?: boolean;
      checkedAt: number;
      provider: string;
    }
  /** Was one of the reviewer's own comments addressed? Keyed by thread id. */
  | (FollowUpResult & {
      type: "followup";
      /** Newest comment in the thread when checked; a newer one makes it stale. */
      lastCommentId: number;
      /** What the fix was held against: the changes since the comment, or —
       * when GitHub could no longer compare — the PR's whole change. */
      basis: "since-comment" | "whole-pr";
      /** Ran inside a local clone. */
      clone: boolean;
      checkedAt: number;
      provider: string;
    });

/** Which check a stop gets. Concerns and questions are claims about intent and
 * about code outside the diff, so they get the clone-backed concern check;
 * orientation and praise describe what the code does, which a claim check can
 * hold against the patch with no clone. */
export const checkTypeFor = (kind: StepKind): "concern" | "claims" =>
  kind === "concern" || kind === "question" ? "concern" : "claims";

export interface ClaimCheckContext {
  step: Pick<GuidedStep, "path">;
  /** The PR's files — what a cited line is held against. */
  files: PullFile[];
  /** A clone was available, so the checker may cite lines outside the diff. */
  clone: boolean;
  /** Set for a codebase-tour stop: there is no diff, so a cite into the
   * anchored file must name a line the file has (1…`lines`). Cites into other
   * files are taken on trust — the checker ran in the clone. */
  repoFile?: { path: string; lines: number };
}

const VERDICTS = new Set<ClaimVerdict>(["supported", "misplaced", "contradicted", "unverifiable"]);

/** New-file lines that some hunk of `file` shows (added or context). */
function visibleLines(file: PullFile): Set<number> {
  const out = new Set<number>();
  for (const h of parsePatch(file.patch)) {
    for (const l of h.lines) if (l.newLine !== null) out.add(l.newLine);
  }
  return out;
}

/**
 * Parse a claim check's reply into checked claims and an overall result.
 *
 * The checker is checked with the same rule `verify.ts` applies to the tour:
 * without a clone, the only code it can have seen is the diff, so a citation
 * outside every hunk — or in a file the PR doesn't touch — is a citation of
 * nothing, and the claim it backs is `unverifiable`.
 */
export function parseClaimCheck(
  out: string,
  ctx: ClaimCheckContext,
): { result: ClaimsResult; claims: CheckedClaim[]; unparsed?: true } {
  const objs = extractObjects(stripFence(out));
  const root = objs.find(
    (o): o is { claims: unknown } => !!o && typeof o === "object" && "claims" in o,
  );
  if (!root) return { result: "partial", claims: [], unparsed: true };

  const lines = new Map<string, Set<number>>();
  const shown = (file: PullFile): Set<number> => {
    let s = lines.get(file.filename);
    if (!s) {
      s = visibleLines(file);
      lines.set(file.filename, s);
    }
    return s;
  };

  const claims: CheckedClaim[] = [];
  for (const raw of toArray(root.claims)) {
    if (claims.length >= MAX_CLAIMS) break;
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    const text = typeof c.text === "string" ? c.text.trim() : "";
    if (!text) continue;
    const note = typeof c.note === "string" ? c.note.trim() : "";
    const path = typeof c.path === "string" && c.path.trim() ? c.path.trim() : ctx.step.path;
    const line = toInt(c.line);
    const cited = line !== null && line > 0 ? line : undefined;
    let verdict: ClaimVerdict = VERDICTS.has(c.verdict as ClaimVerdict)
      ? (c.verdict as ClaimVerdict)
      : "unverifiable";
    let downgraded: string | undefined;

    if (verdict !== "unverifiable") {
      if (cited === undefined) {
        verdict = "unverifiable";
        downgraded = "The check cited no line.";
      } else if (ctx.repoFile) {
        if (path === ctx.repoFile.path && cited > ctx.repoFile.lines) {
          verdict = "unverifiable";
          downgraded = `Line ${cited} is past the end of ${path} (${ctx.repoFile.lines} lines).`;
        }
      } else if (!ctx.clone) {
        const file = findFile(ctx.files, path);
        if (!file) {
          verdict = "unverifiable";
          downgraded = `${path} isn't in this PR, and there is no clone to read it from.`;
        } else if (!shown(file).has(cited)) {
          verdict = "unverifiable";
          downgraded = `Line ${cited} isn't in this file's diff, and there is no clone to read it from.`;
        }
      }
    }

    claims.push({
      text,
      verdict,
      ...(cited !== undefined ? { path, line: cited } : {}),
      note,
      ...(downgraded ? { downgraded } : {}),
    });
  }

  return { result: claimsResult(claims), claims };
}

/** Fold per-claim verdicts into the stop's result. Zero claims is a valid
 * answer ("no factual claims") and folds to `partial`: nothing was shown true. */
export function claimsResult(claims: CheckedClaim[]): ClaimsResult {
  if (claims.some((c) => c.verdict === "contradicted")) return "contradicted";
  if (claims.length > 0 && claims.every((c) => c.verdict === "supported")) return "supported";
  return "partial";
}

/**
 * How far a stop can be taken as fact, combining where it is anchored with
 * what a check found.
 * - `unanchored`   — the grade is `heuristic`; no check can fix a missing anchor.
 * - `contradicted` — a claim check found a contradiction, or the concern check
 *                    cleared the concern as not worth raising.
 * - `verified`     — anchored (`exact` / `strong`) AND the check backed it.
 * - `unchecked`    — everything else, including a `partial` claim check.
 *
 * Anything that presents a stop as fact (an exported report) should key off
 * this rather than the grade alone.
 */
export type Trust = "verified" | "contradicted" | "unchecked" | "unanchored";

export function stepTrust(evidence: Evidence, check?: CheckRecord): Trust {
  if (evidence === "heuristic") return "unanchored";
  if (!check || check.type === "followup") return "unchecked";
  if (check.type === "claims") {
    if (check.result === "contradicted") return "contradicted";
    if (check.result === "supported") return "verified";
    return "unchecked";
  }
  return check.verdict === "resolved" ? "contradicted" : "verified";
}
