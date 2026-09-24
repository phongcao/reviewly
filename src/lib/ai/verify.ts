/**
 * Deterministic verification of a tour stop against the diff it claims to
 * describe.
 *
 * The prompts already demand that every stop name a path + line that exist in
 * the diff and quote only identifiers that appear there verbatim
 * (`@/lib/ai/prompts`, "Ground every claim in bytes you can see"). Until now
 * that contract was enforced by asking the model politely: `toStep` drops a stop
 * with no parseable anchor, but nothing checks the anchor against the PR, and
 * the only real check in the app is `InlineDiff` at render time — which renders
 * an honest "not in this diff" note and then says nothing to anyone about it.
 *
 * This module closes that loop with no model call and no AST. A stop is graded
 * on where its evidence actually lands: on a line the PR adds, on unchanged
 * context inside a real hunk, or nowhere the diff can support — which is also
 * the verdict for an anchor that misses every hunk, names a file the PR never
 * touches, or quotes an identifier absent from the whole diff.
 *
 * Nothing is ever removed, and that is the load-bearing half. Dropping a
 * weakly-grounded concern would trade a visible false positive for an invisible
 * false negative, and a reviewer cannot audit what they were never shown. The
 * grade is shown next to the stop so a shaky claim reads as shaky instead of
 * reading like every other one.
 *
 * Grades are categorical and derived from provenance — never a percentage. A
 * number here would imply a calibration we have no way to earn.
 */
import { parsePatch } from "@/lib/diff";
import type { GuidedStep } from "@/lib/guided";
import type { PullFile } from "@/lib/tauri";

/** How well a stop's claim is backed by bytes in the diff.
 * - `exact`     — anchored to a line this PR actually adds, every named identifier present.
 * - `strong`    — anchored inside a real hunk (context lines only), identifiers present.
 * - `heuristic` — the anchor missed every hunk, or an identifier is nowhere in the diff. */
export type Evidence = "exact" | "strong" | "heuristic";

export interface StepEvidence {
  grade: Evidence;
  /** Backticked identifiers that appear nowhere in the PR's diff. */
  ungrounded: string[];
  /** Why this isn't `exact`, phrased for a UI tooltip. Absent when it is. */
  reason?: string;
}

export interface VerifiedStep {
  step: GuidedStep;
  evidence: StepEvidence;
}

/**
 * Tokens that carry no identity, so their absence from the diff proves nothing.
 *
 * Three groups: language keywords that appear inside quoted expressions
 * (`quantity <= 0`, `if (!user)`); built-in error and container types, which a
 * model names generically when describing behaviour ("guards against
 * `KeyError`") rather than quoting the file; and conventional doc filenames.
 *
 * Measured against two real tours (78 stops): without the built-ins, 3 of 4
 * flags were false positives — enough to train a reviewer to ignore the banner,
 * which costs more than the fabrications it catches. Still kept deliberately
 * small, because over-stopping hides the real ones: a fabricated domain symbol
 * like `ValidationFailure` or `Unauthorized` is not on this list and is exactly
 * what the check exists to find.
 */
const NOISE = new Set([
  // Built-in error types — named generically, not quoted from the code.
  "assertionerror",
  "attributeerror",
  "baseexception",
  "error",
  "exception",
  "filenotfounderror",
  "importerror",
  "indexerror",
  "ioerror",
  "keyerror",
  "notimplementederror",
  "oserror",
  "rangeerror",
  "referenceerror",
  "runtimeerror",
  "stopiteration",
  "syntaxerror",
  "typeerror",
  "valueerror",
  "zerodivisionerror",
  // Built-in container / global types.
  "array",
  "dict",
  "json",
  "list",
  "object",
  "promise",
  "tuple",
  // Conventional filenames a summary cites without the PR touching them.
  "changelog",
  "license",
  "readme",
  "todo",
  // Language keywords, which appear inside quoted expressions.
  "and",
  "async",
  "await",
  "bool",
  "boolean",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "def",
  "elif",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "final",
  "finally",
  "float",
  "for",
  "from",
  "func",
  "function",
  "if",
  "import",
  "int",
  "interface",
  "let",
  "new",
  "nil",
  "none",
  "not",
  "null",
  "number",
  "or",
  "pass",
  "private",
  "public",
  "return",
  "self",
  "static",
  "str",
  "string",
  "struct",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/g;
const BACKTICKED = /`([^`\n]+)`/g;

/**
 * Identifiers a stop commits to, pulled from the backticked spans of its title,
 * detail and suggestion.
 *
 * Backticks are the model's own marker for "I am quoting code", which makes them
 * exactly the claims worth checking — prose is not evidence and is not checked.
 * A span may be a whole expression, so it is tokenized rather than matched
 * whole: `quantity <= 0` grounds on `quantity`.
 */
export function citedIdentifiers(text: string): string[] {
  const out = new Set<string>();
  for (const span of text.matchAll(BACKTICKED)) {
    for (const tok of span[1].matchAll(IDENT)) {
      const id = tok[0];
      // Short tokens collide with everything (`id`, `db`, `ok`), so they can
      // neither confirm nor refute — skip rather than manufacture a signal.
      if (id.length < 3) continue;
      if (NOISE.has(id.toLowerCase())) continue;
      out.add(id);
    }
  }
  return [...out];
}

/** The PR's file whose name matches `path`, tolerating a case-only miss the way
 * `reconcileLayers` does — models re-case paths far more often than they invent
 * a file that differs from a real one only in case. */
function findFile(files: PullFile[], path: string): PullFile | undefined {
  const exact = files.find((f) => f.filename === path);
  if (exact) return exact;
  const lower = path.toLowerCase();
  return files.find((f) => f.filename.toLowerCase() === lower);
}

/** Anything the model asserted and anchored — a tour stop, or one behavioral
 * change in a behavior panel. Verification doesn't care which. */
export interface Claim {
  path: string;
  line: number;
  endLine?: number;
  /** The prose whose backticked identifiers must hold up. */
  text: string;
}

/** Everything a tour stop asserts, as one blob for the identifier check. */
const stepText = (step: GuidedStep): string =>
  `${step.title}\n${step.detail}\n${step.suggestion ?? ""}`;

/** Verify one tour stop. */
export const verifyStep = (step: GuidedStep, files: PullFile[], corpus?: string): StepEvidence =>
  verifyClaim(
    { path: step.path, line: step.line, endLine: step.endLine, text: stepText(step) },
    files,
    corpus,
  );

/**
 * Verify one claim against the PR's files.
 *
 * `files` must be the PR's real file list — the same list `mergeDeepTour` and
 * `InlineDiff` resolve against — so a stop is judged against exactly what the
 * reviewer will be shown.
 *
 * Pass `corpus` when verifying a batch, to hoist the join out of the loop.
 */
export function verifyClaim(claim: Claim, files: PullFile[], corpus?: string): StepEvidence {
  // Every changed line in the PR. An identifier missing from the cited file but
  // present in a sibling is still grounded — cross-file narration ("this is the
  // caller of `validate`") is legitimate and common, and the fabrications worth
  // catching are symbols that exist nowhere at all.
  const all = corpus ?? prCorpus(files);

  const file = findFile(files, claim.path);
  if (!file) {
    // Nothing to stand the claim up against, and `InlineDiff` will say as much.
    // Still not deleted: a fabricated anchor on a real concern is a reason to
    // read the code, not a reason to hide the concern.
    return {
      grade: "heuristic",
      ungrounded: citedIdentifiers(claim.text).filter((id) => !all.includes(id)),
      reason: `${claim.path} isn't among this PR's changed files.`,
    };
  }

  const lo = claim.line;
  const hi = claim.endLine && claim.endLine >= lo ? claim.endLine : lo;
  const inRange = (n: number | null) => n !== null && n >= lo && n <= hi;

  // The hunk that actually contains the anchor — same rule as `InlineDiff`, so a
  // stop graded `exact`/`strong` here is exactly one that renders a real snippet
  // there, and a downgrade always explains a visible "not in this diff" note
  // rather than contradicting it.
  const hunk = parsePatch(file.patch).find((h) => h.lines.some((l) => inRange(l.newLine)));
  const touchesAdd = hunk?.lines.some((l) => l.kind === "add" && inRange(l.newLine)) ?? false;

  // Prefer the containing hunk as the grounding window, widening to the file and
  // then the whole PR. Each widening is a weaker claim, but only total absence
  // is reported.
  const window = hunk ? hunk.lines.map((l) => l.text).join("\n") : (file.patch ?? "");
  const ungrounded = citedIdentifiers(claim.text).filter(
    (id) => !window.includes(id) && !all.includes(id),
  );

  return grade({ hunk: !!hunk, touchesAdd, ungrounded, line: lo });
}

/** Concatenated patch text of every changed file — the widest grounding window. */
export const prCorpus = (files: PullFile[]): string => files.map((f) => f.patch ?? "").join("\n");

/** Verify a whole tour. Nothing is removed: a stop the diff can't support is
 * graded `heuristic` and shown as such, because a concern the reviewer never
 * sees is the one failure mode they cannot audit. */
export function verifySteps(steps: GuidedStep[], files: PullFile[]): VerifiedStep[] {
  const corpus = prCorpus(files);
  return steps.map((step) => ({ step, evidence: verifyStep(step, files, corpus) }));
}

function grade(o: {
  hunk: boolean;
  touchesAdd: boolean;
  ungrounded: string[];
  line: number;
}): StepEvidence {
  if (!o.hunk) {
    return {
      grade: "heuristic",
      ungrounded: o.ungrounded,
      reason: `Line ${o.line} isn't in this file's diff.`,
    };
  }
  if (o.ungrounded.length > 0) {
    const names = o.ungrounded.map((n) => `\`${n}\``).join(", ");
    return {
      grade: "heuristic",
      ungrounded: o.ungrounded,
      reason: `${names} ${o.ungrounded.length === 1 ? "doesn't appear" : "don't appear"} anywhere in this diff.`,
    };
  }
  if (!o.touchesAdd) {
    return {
      grade: "strong",
      ungrounded: [],
      reason: "Anchored to unchanged context, not to a line this PR adds.",
    };
  }
  return { grade: "exact", ungrounded: [] };
}

/** True when a stop is weakly enough grounded that the UI should say so. */
export const isDowngraded = (e: StepEvidence): boolean => e.grade === "heuristic";
