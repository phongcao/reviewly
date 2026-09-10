import { extractObjects, firstString, stripFence, toArray, toInt, tryJson } from "@/lib/ai/json";

/** What a stop on the guided tour is about. */
export type StepKind = "orient" | "concern" | "question" | "praise";

/** One stop on the guided reading tour of a PR. */
export interface GuidedStep {
  path: string;
  /** New-file line the step anchors to. */
  line: number;
  /** Optional last line of the relevant range (for multi-line stops). */
  endLine?: number;
  kind: StepKind;
  title: string;
  /** Narration: what this code does / why we're here, in the flow (markdown). */
  detail: string;
  /** Optional ready-to-post review comment (only when the stop deserves one). */
  suggestion?: string;
  /** Which layer of a deep tour produced this stop. Never set by the model —
   * stamped during `mergeDeepTour`, and absent on a classic whole-PR tour. */
  layerId?: string;
}

/** The tour's overall recommendation, surfaced as a suggested review verdict. */
export type GuidedVerdict = "approve" | "request_changes" | "comment";

/** One layer heading in a merged deep tour, in the partition's reading order.
 * Carries `index`/`total` so a heading can say "Layer 2 of 10" even when the
 * layers in between haven't been toured yet. */
export interface TourLayer {
  id: string;
  title: string;
  /** 1-based position in the WHOLE partition, not among the landed layers. */
  index: number;
  total: number;
  /** How many of this layer's stops are in the merged step list. */
  steps: number;
}

/** One run of consecutive tour stops that share a layer, as the rail draws it. */
export interface TourGroup {
  /** The layer heading, or null for a classic tour's single unlabeled run. */
  layer: TourLayer | null;
  /** Original step indices in this run, in visible order. */
  items: number[];
  /** Position of `items[0]` in the visible list. The rail's spine BREAKS are
   * group-local, but "is this stop behind the cursor" is still a question about
   * the whole tour, so a row needs its global position too. */
  start: number;
}

/**
 * Fold the visible stops into per-layer runs, so the tour rail can hide one
 * layer's stops without disturbing the spine running through the others.
 *
 * Adjacent runs with no resolvable layer merge into a single unlabeled group —
 * which is what a classic (unlayered) tour is, and what keeps a step carrying
 * an unknown `layerId` from splitting the rail at a heading that isn't there.
 */
export function groupTourStops(
  visible: number[],
  steps: GuidedStep[],
  layers: TourLayer[] | undefined,
): TourGroup[] {
  if (!layers?.length) {
    return visible.length > 0 ? [{ layer: null, items: [...visible], start: 0 }] : [];
  }
  const byId = new Map(layers.map((l) => [l.id, l]));
  const out: TourGroup[] = [];
  visible.forEach((i, p) => {
    const id = steps[i]?.layerId;
    const layer = (id ? byId.get(id) : undefined) ?? null;
    const prev = out[out.length - 1];
    if (prev && prev.layer?.id === layer?.id) prev.items.push(i);
    else out.push({ layer, items: [i], start: p });
  });
  return out;
}

export interface GuidedPlan {
  /** One sentence: what this PR does. */
  summary: string;
  /** The reading strategy — where to start and why this order (markdown). */
  tour: string;
  /** Optional overall recommendation after the walkthrough. */
  verdict?: GuidedVerdict;
  /** One-sentence justification for the verdict (why approve / what blocks). */
  verdictReason?: string;
  steps: GuidedStep[];
  /** Layer headings for a merged deep tour, in plan order. Absent on a classic
   * whole-PR tour, which has no layers to divide. */
  layers?: TourLayer[];
}

/**
 * Background-task key prefix for ONE layer of a deep tour. The backend keys AI
 * runs by an opaque string and broadcasts `ai:done` to every listener, so each
 * surface needs a disjoint namespace — a classic whole-PR tour uses the bare
 * `prKey`, the layered planner uses `layers:`, and a deep tour uses this. Same
 * reasoning as `LAYERS_KEY_PREFIX` in `@/lib/layers`.
 */
export const TOUR_KEY_PREFIX = "tour:";

/** `tour:<layerId>@<owner>/<repo>#<number>` — `@` appears in neither half, so
 * the split back apart is unambiguous. */
export const tourKey = (prKey: string, layerId: string): string =>
  `${TOUR_KEY_PREFIX}${layerId}@${prKey}`;

/** Inverse of `tourKey`; null for any key that isn't a deep-tour layer. */
export function parseTourKey(key: string): { prKey: string; layerId: string } | null {
  if (!key.startsWith(TOUR_KEY_PREFIX)) return null;
  const rest = key.slice(TOUR_KEY_PREFIX.length);
  const at = rest.indexOf("@");
  if (at <= 0 || at === rest.length - 1) return null;
  return { layerId: rest.slice(0, at), prKey: rest.slice(at + 1) };
}

/** Coerce a raw verdict string to a known value, or undefined. */
function toVerdict(v: unknown): GuidedVerdict | undefined {
  const s = typeof v === "string" ? v.toLowerCase().trim() : "";
  return s === "approve" || s === "request_changes" || s === "comment" ? s : undefined;
}

const KINDS = new Set<StepKind>(["orient", "concern", "question", "praise"]);

/** Near-miss kind words → canonical. A genuinely-unknown *non-empty* kind
 * defaults to "concern" (below) so a flagged risk is never silently downgraded
 * to a neutral orientation stop with no warning color and no "Check with AI". */
const KIND_SYNONYMS: Record<string, StepKind> = {
  warning: "concern",
  issue: "concern",
  bug: "concern",
  risk: "concern",
  problem: "concern",
  caution: "concern",
  nit: "concern",
  ask: "question",
  clarify: "question",
  clarification: "question",
  good: "praise",
  nice: "praise",
  kudos: "praise",
  positive: "praise",
  overview: "orient",
  context: "orient",
  note: "orient",
  info: "orient",
  intro: "orient",
};

function toKind(raw: unknown): StepKind {
  const s = typeof raw === "string" ? raw.toLowerCase().trim() : "";
  if (KINDS.has(s as StepKind)) return s as StepKind;
  if (s && s in KIND_SYNONYMS) return KIND_SYNONYMS[s];
  // Empty/missing → neutral orient; unknown-but-present → concern (over-flag,
  // never hide).
  return s ? "concern" : "orient";
}

/** Normalize one raw step object → GuidedStep, or null if it lacks a usable
 * path + line anchor. Tolerant of numeric-string lines and near-miss kinds. */
function toStep(p: unknown): GuidedStep | null {
  if (typeof p !== "object" || p === null) return null;
  const o = p as Record<string, unknown>;
  if (typeof o.path !== "string" || !o.path.trim()) return null;
  const parsedLine = toInt(o.line);
  if (parsedLine === null) return null;
  const line = Math.max(1, parsedLine);
  const parsedEnd = toInt(o.endLine);
  const endLine = parsedEnd !== null && parsedEnd >= line ? parsedEnd : undefined;
  const suggestion =
    typeof o.suggestion === "string" && o.suggestion.trim() ? o.suggestion : undefined;
  return {
    path: o.path,
    line,
    endLine,
    kind: toKind(o.kind),
    title: typeof o.title === "string" && o.title.trim() ? o.title : o.path,
    detail: typeof o.detail === "string" ? o.detail : "",
    suggestion,
  };
}

/** Last-ditch recovery when the reply isn't valid JSON: scrape the steps array
 * and the top-level summary/tour by hand so a near-complete tour still renders.
 * summary/tour are scraped only from the HEADER (before the steps array) so a
 * nested step key named `summary`/`tour` can't masquerade as the plan header. */
function salvage(content: string): { summary: string; tour: string; steps: unknown[] } | null {
  const m = content.match(/"(?:steps|points)"\s*:\s*[[{]/);
  if (!m || m.index === undefined) return null;
  // The last char of the match is the opening `[` or `{` of the steps container.
  const bracketIdx = m.index + m[0].length - 1;
  const header = content.slice(0, m.index);
  const steps = extractObjects(content.slice(bracketIdx + 1));
  if (steps.length === 0) return null;
  return {
    summary: firstString(header, "summary"),
    tour: firstString(header, "tour"),
    steps,
  };
}

/** Pull the JSON guided-tour plan out of the model's reply. Defense-in-depth so
 * imperfect model output degrades gracefully instead of discarding the tour:
 * strips a wrapping ```json fence, prefers the LAST balanced {…} that carries
 * steps (robust to trailing prose / a second illustrative object), repairs
 * trailing commas, coerces a steps-map to an array and string lines to numbers,
 * normalizes near-miss kinds, salvages a truncated array, and de-dups. Accepts
 * both the `steps` and the older `points` shape. */
export function parseGuided(content: string): GuidedPlan | null {
  // De-fence a wrapping ```json … ``` while leaving internal markdown fences
  // (inside a step's `detail`) intact.
  const s = stripFence(content);

  let summary = "";
  let tour = "";
  let verdict: GuidedVerdict | undefined;
  let verdictReason = "";
  let rawSteps: unknown[] = [];

  // Prefer the LAST balanced top-level {…} that actually carries steps — robust
  // to trailing prose, a banner line, or a second illustrative JSON object
  // (gemini has no final-message isolation, so this is its dominant failure).
  const objs = extractObjects(s);
  const planObj = [...objs].reverse().find((o) => {
    if (!o || typeof o !== "object") return false;
    const r = o as Record<string, unknown>;
    return toArray(r.steps).length > 0 || toArray(r.points).length > 0;
  }) as Record<string, unknown> | undefined;

  const obj =
    planObj ??
    (() => {
      const start = s.indexOf("{");
      const end = s.lastIndexOf("}");
      return start >= 0 && end > start ? tryJson(s.slice(start, end + 1)) : undefined;
    })();

  if (obj && typeof obj === "object") {
    const r = obj as Record<string, unknown>;
    rawSteps = toArray(r.steps);
    if (rawSteps.length === 0) rawSteps = toArray(r.points);
    summary = typeof r.summary === "string" ? r.summary : "";
    tour = typeof r.tour === "string" ? r.tour : "";
    verdict = toVerdict(r.verdict);
    verdictReason = typeof r.verdictReason === "string" ? r.verdictReason : "";
  }

  // Salvage: the object was unparseable, or valid but carried no steps. A failed
  // salvage is NOT fatal on its own — a legitimate "nothing to walk through"
  // tour (summary + verdict, no stops) is accepted at the end.
  if (rawSteps.length === 0) {
    const recovered = salvage(s);
    if (recovered) {
      rawSteps = recovered.steps;
      if (!summary) summary = recovered.summary;
      if (!tour) tour = recovered.tour;
    }
  }
  // Scrape verdict / reason from the header if the structured parse missed them.
  if (!verdict || !verdictReason) {
    const arrIdx = s.search(/"(?:steps|points)"\s*:/);
    const header = arrIdx > 0 ? s.slice(0, arrIdx) : s;
    if (!verdict) verdict = toVerdict(firstString(header, "verdict"));
    if (!verdictReason) verdictReason = firstString(header, "verdictReason");
  }

  // Normalize + de-dup by path:line:title so redundant stops don't clutter the
  // timeline.
  const seen = new Set<string>();
  const steps: GuidedStep[] = [];
  for (const p of rawSteps) {
    const step = toStep(p);
    if (!step) continue;
    const sig = `${step.path}:${step.line}:${step.title}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    steps.push(step);
  }
  // A "clean bill of health" tour has no stops but still a real summary and an
  // explicit verdict — render it rather than failing. Require BOTH so a garbled
  // reply with only a stray "summary" isn't mistaken for a no-op tour.
  if (steps.length === 0) {
    if (summary.trim() && verdict) return { summary, tour, verdict, verdictReason, steps: [] };
    return null;
  }
  return { summary, tour, verdict, verdictReason, steps };
}

/** How much of the PR a layer-by-layer tour has actually read. */
export interface TourCoverage {
  done: number;
  total: number;
}

/** What the tour's verdict should look like, and whether it may act. */
export interface VerdictDisplay {
  kind: "none" | "verdict" | "withheld";
  /** Coverage to name in the label, or null when the tour read everything. */
  partial: TourCoverage | null;
  /** May acting on the tour pre-set the reviewer's review verdict? */
  seed: boolean;
}

/**
 * Decide how to present a tour's verdict given how much of the PR it read.
 *
 * The asymmetry is the point. `request_changes` needs one objecting layer and
 * is sound the moment one appears, so partial coverage doesn't weaken it — it
 * is merely scoped, so the reviewer can see how much was read. "Nothing here
 * blocks" is different: it is only true of code that has actually been read, so
 * an `approve` folded from a fraction of the layers is withheld entirely rather
 * than shown with a caveat, and never pre-sets the reviewer's verdict.
 *
 * A tour with no coverage information is a single-pass tour, which saw the
 * whole PR (up to the diff budget) in one call.
 */
export function verdictDisplay(
  verdict: GuidedVerdict | undefined,
  coverage?: TourCoverage,
): VerdictDisplay {
  if (!verdict) return { kind: "none", partial: null, seed: false };

  const partial = coverage && coverage.done < coverage.total ? coverage : null;
  if (!partial) return { kind: "verdict", partial: null, seed: true };
  if (verdict === "approve") return { kind: "withheld", partial, seed: false };
  return { kind: "verdict", partial, seed: true };
}
