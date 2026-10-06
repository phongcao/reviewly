import { type Evidence, type StepEvidence, citedIdentifiers } from "@/lib/ai/verify";
/**
 * Deterministic grading of a codebase-tour stop against the repository at a
 * commit — the repository counterpart of `verify.ts`.
 *
 * A PR stop is graded against the diff: added lines are `exact`, context is
 * `strong`. A repository has no diff, and treating every line as "added"
 * would make every stop `exact` and the grade meaningless. So the window
 * here is the anchored range itself: names quoted in a stop must appear right
 * where it points (`exact`), or at least somewhere real (`strong`). A name
 * that exists nowhere in the repository is a fabrication, and the stop is
 * `heuristic` — shown, labeled, never removed.
 */
import type { GuidedStep } from "@/lib/guided";

/** Lines of slack on each side of the anchored range. A definition one line
 * above a doc comment, or a call just below, is still "at" the anchor. */
export const REPO_WINDOW = 3;

export interface RepoEvidenceContext {
  /** Every tracked path at the commit. */
  trackedPaths: ReadonlySet<string>;
  /** The anchored file's text at the commit, when it could be read. */
  fileText: string | null;
  /** Identifiers known to exist somewhere in the repository (from a lookup).
   * Names absent here AND from the anchored file are treated as nowhere. */
  knownIdentifiers: ReadonlySet<string>;
}

const stepText = (step: GuidedStep): string => `${step.title}\n${step.detail}`;

export function verifyRepoStep(step: GuidedStep, ctx: RepoEvidenceContext): StepEvidence {
  const cited = citedIdentifiers(stepText(step));
  if (!ctx.trackedPaths.has(step.path)) {
    return {
      grade: "heuristic",
      ungrounded: cited.filter((id) => !ctx.knownIdentifiers.has(id)),
      reason: `${step.path} isn't a tracked file at this commit.`,
    };
  }
  const lines = ctx.fileText === null ? null : ctx.fileText.split("\n");
  const total = lines ? (lines[lines.length - 1] === "" ? lines.length - 1 : lines.length) : 0;
  if (lines && step.line > total) {
    return {
      grade: "heuristic",
      ungrounded: [],
      reason: `Line ${step.line} is past the end of the file (${total} lines).`,
    };
  }

  const whole = ctx.fileText ?? "";
  const nowhere = cited.filter((id) => !whole.includes(id) && !ctx.knownIdentifiers.has(id));
  if (nowhere.length > 0) {
    const names = nowhere.map((n) => `\`${n}\``).join(", ");
    return {
      grade: "heuristic",
      ungrounded: nowhere,
      reason: `${names} ${nowhere.length === 1 ? "doesn't appear" : "don't appear"} anywhere in the repository.`,
    };
  }

  const hi = step.endLine && step.endLine >= step.line ? step.endLine : step.line;
  const window = lines
    ? lines.slice(Math.max(0, step.line - 1 - REPO_WINDOW), hi + REPO_WINDOW).join("\n")
    : "";
  const elsewhere = cited.filter((id) => !window.includes(id));
  if (!lines || elsewhere.length > 0) {
    const grade: Evidence = "strong";
    return {
      grade,
      ungrounded: [],
      reason: !lines
        ? "The anchored file couldn't be read, so the anchor itself wasn't checked."
        : `${elsewhere.map((n) => `\`${n}\``).join(", ")} ${
            elsewhere.length === 1 ? "exists" : "exist"
          } in the repository, but not at the anchored lines.`,
    };
  }
  return { grade: "exact", ungrounded: [] };
}

/** Cited identifiers a step needs looked up: the ones its anchored file
 * doesn't already contain. */
export function identifiersToLookUp(step: GuidedStep, fileText: string | null): string[] {
  const text = fileText ?? "";
  return citedIdentifiers(stepText(step)).filter((id) => !text.includes(id));
}
