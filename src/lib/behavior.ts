/**
 * Behavioral before/after for one changed symbol — the conceptual-diff idea,
 * scoped to something a reviewer asks for rather than something every tour pays
 * for.
 *
 * A raw diff shows the reviewer WHAT the bytes became and leaves them to work
 * out what the code now DOES. That translation is the expensive part of review,
 * and it's the part worth having help with. A before/after behavior list is the
 * form that help should take, because unlike a prose summary it is falsifiable:
 * each bullet is a claim about the code that a reviewer can check line by line,
 * and a wrong one is visibly wrong rather than plausibly vague.
 *
 * Two deliberate scoping choices:
 *
 * 1. ON DEMAND, not in the tour. Generating this for every stop would bloat the
 *    tour prompt, cost tokens on stops nobody opens, and put the whole tour's
 *    anchoring quality at risk for a feature used on a handful of symbols. It
 *    follows the existing per-stop `checkWithAI` pattern instead.
 * 2. EPHEMERAL. Like `CheckResult`, the answer isn't stored — it describes the
 *    diff at the moment it was asked, and a stored copy would outlive the code
 *    it describes.
 *
 * `refactor_only` is the load-bearing classification. Most large PRs are mostly
 * behavior-preserving, and being told so explicitly — with the before/after
 * lists matching — is what lets a reviewer skim a file honestly instead of
 * re-deriving that conclusion by hand.
 */
import { extractObjects, stripFence, toArray, toInt, toStringArray } from "@/lib/ai/json";

/** How a change relates to observable behavior. */
export type ChangeClass =
  | "behavior_added"
  | "behavior_removed"
  | "new_guard"
  | "ordering_change"
  | "contract_change"
  | "error_change"
  | "refactor_only";

/** Where a change's evidence lives, as new-file lines — the same convention
 * `GuidedStep` uses, so a click lands in the diff viewer without translation. */
export interface ChangeRange {
  line: number;
  endLine?: number;
}

export interface BehaviorChange {
  type: ChangeClass;
  text: string;
  /** Lines backing this claim. Empty when the model supplied none, which is
   * itself a signal — an unanchored statement is graded down, never hidden. */
  ranges: ChangeRange[];
}

export interface BehaviorDiff {
  /** The symbol this describes, as the model named it from the diff. */
  symbol: string;
  /** What the code did before, one step per bullet. Empty for a new symbol. */
  before: string[];
  /** What it does now. Empty for a deleted symbol. */
  after: string[];
  changes: BehaviorChange[];
}

const CLASSES = new Set<ChangeClass>([
  "behavior_added",
  "behavior_removed",
  "new_guard",
  "ordering_change",
  "contract_change",
  "error_change",
  "refactor_only",
]);

/** Near-miss classifications → canonical. An unrecognized but non-empty type
 * becomes `behavior_modified`'s closest honest neighbour — `behavior_added` —
 * rather than `refactor_only`, because wrongly telling a reviewer "no
 * behavioral change" is the one error that costs them a real bug. */
const SYNONYMS: Record<string, ChangeClass> = {
  added: "behavior_added",
  behaviour_added: "behavior_added",
  behavior_modified: "behavior_added",
  behaviour_modified: "behavior_added",
  modified: "behavior_added",
  removed: "behavior_removed",
  behaviour_removed: "behavior_removed",
  deleted: "behavior_removed",
  guard: "new_guard",
  validation: "new_guard",
  ordering: "ordering_change",
  order_change: "ordering_change",
  reorder: "ordering_change",
  contract: "contract_change",
  signature_change: "contract_change",
  api_change: "contract_change",
  error: "error_change",
  exception_change: "error_change",
  refactor: "refactor_only",
  no_behavior_change: "refactor_only",
  none: "refactor_only",
};

function toClass(raw: unknown): ChangeClass {
  const s = typeof raw === "string" ? raw.toLowerCase().trim() : "";
  if (CLASSES.has(s as ChangeClass)) return s as ChangeClass;
  if (s && s in SYNONYMS) return SYNONYMS[s];
  return "behavior_added";
}

/** One `{line, endLine?}` from the model, or null if it carries no usable
 * line. Tolerates a bare number and numeric strings, like `toStep`. */
function toRange(p: unknown): ChangeRange | null {
  if (typeof p === "number" || typeof p === "string") {
    const n = toInt(p);
    return n !== null && n >= 1 ? { line: n } : null;
  }
  if (typeof p !== "object" || p === null) return null;
  const o = p as Record<string, unknown>;
  const line = toInt(o.line);
  if (line === null || line < 1) return null;
  const end = toInt(o.endLine);
  return { line, endLine: end !== null && end >= line ? end : undefined };
}

function toChange(p: unknown): BehaviorChange | null {
  if (typeof p === "string") {
    return p.trim() ? { type: "behavior_added", text: p.trim(), ranges: [] } : null;
  }
  if (typeof p !== "object" || p === null) return null;
  const o = p as Record<string, unknown>;
  const text = typeof o.text === "string" ? o.text.trim() : "";
  if (!text) return null;
  const ranges = toArray(o.ranges ?? o.lines)
    .map(toRange)
    .filter((r): r is ChangeRange => r !== null);
  return { type: toClass(o.type), text, ranges };
}

/**
 * Pull the behavior diff out of the model's reply.
 *
 * Same defense-in-depth as `parseGuided`: de-fence, prefer the LAST balanced
 * object that actually carries the payload (robust to a chatty preamble or an
 * illustrative example), and tolerate a bare string in the changes array.
 * Returns null rather than a half-empty shell — a card with no content is worse
 * than no card.
 */
export function parseBehavior(content: string): BehaviorDiff | null {
  const s = stripFence(content);
  const objs = extractObjects(s);
  const obj = [...objs].reverse().find((o) => {
    if (!o || typeof o !== "object") return false;
    const r = o as Record<string, unknown>;
    return (
      toArray(r.before).length > 0 || toArray(r.after).length > 0 || toArray(r.changes).length > 0
    );
  }) as Record<string, unknown> | undefined;
  if (!obj) return null;

  const before = toStringArray(obj.before).filter((x) => x.trim());
  const after = toStringArray(obj.after).filter((x) => x.trim());
  const changes = toArray(obj.changes)
    .map(toChange)
    .filter((c): c is BehaviorChange => c !== null);

  // A before/after with nothing on either side and no stated change says
  // nothing at all.
  if (before.length === 0 && after.length === 0 && changes.length === 0) return null;

  return {
    symbol: typeof obj.symbol === "string" && obj.symbol.trim() ? obj.symbol.trim() : "",
    before,
    after,
    changes,
  };
}

/** True when the model concluded nothing observable changed — every stated
 * change is `refactor_only`, and it stated at least one. */
export const isPureRefactor = (b: BehaviorDiff): boolean =>
  b.changes.length > 0 && b.changes.every((c) => c.type === "refactor_only");

export const CHANGE_LABEL: Record<ChangeClass, string> = {
  behavior_added: "added",
  behavior_removed: "removed",
  new_guard: "guard",
  ordering_change: "ordering",
  contract_change: "contract",
  error_change: "errors",
  refactor_only: "refactor",
};

/** Sign shown before a change line, mirroring the spec's `+ / - / ~` notation. */
export const CHANGE_SIGN: Record<ChangeClass, string> = {
  behavior_added: "+",
  behavior_removed: "−",
  new_guard: "+",
  ordering_change: "~",
  contract_change: "~",
  error_change: "~",
  refactor_only: "~",
};

export const CHANGE_STYLE: Record<ChangeClass, string> = {
  behavior_added: "text-success",
  behavior_removed: "text-destructive",
  new_guard: "text-success",
  ordering_change: "text-warning",
  contract_change: "text-warning",
  error_change: "text-warning",
  refactor_only: "text-muted-foreground",
};
