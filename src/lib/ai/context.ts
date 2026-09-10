import { type PrSize, toCoverage } from "@/lib/ai/budget";
import type { PullDetail, PullFile } from "@/lib/tauri";

/** Total character budget for the diff portion of the AI context.
 *
 * Sized for a CLI that takes the prompt on STDIN, which is how this app drives
 * `claude` and `codex` — there is no OS arg-length ceiling on that path, so the
 * limit is the model's context (180k chars is ~45k tokens, comfortable) rather
 * than the spawn. `gemini` is the exception: it takes the prompt as a single
 * argv string, and Linux caps one argument at 128 KiB (`MAX_ARG_STRLEN`), so a
 * context that spends this budget can fail to spawn there. macOS has no
 * per-argument cap, only ~1 MB across all of argv, and is fine.
 *
 * Raising this also moves the fan-out line: `coverage` is what fit over what
 * exists, and `shouldFanOut` treats a low value as "reviewing blind". A bigger
 * budget means fewer PRs are blind, so fewer trip that rule — which is the
 * rule working as intended, not a regression. The file and churn thresholds
 * are absolute and still fan out regardless. */
const DIFF_BUDGET = 180_000;

/** Budget for one layer's call in a fanned-out deep tour.
 *
 * Truncation here is what caps `reviewUnits`, and with it `layerStepCap`, so a
 * starved layer gets both less code and fewer stops to spend on it — this is
 * the number to raise when big layers come back thin.
 *
 * Two-thirds of the whole-PR budget: a tour fans out into as many as
 * `LAYER_CAP` of these calls, so full parity per slice would multiply. The stdin vs
 * argv caveat on `DIFF_BUDGET` applies here too. */
export const LAYER_DIFF_BUDGET = 120_000;

/** Floor on a single file's share of the budget. Below this a slice is a few
 * hunk headers and no code — it teaches the model nothing and only costs it
 * attention, so past the point where every file could get this much we omit the
 * tail (and say so) instead of shredding everything. */
const MIN_SLICE = 2_000;

/** Lower rank = more important to show the model first. */
function fileRank(name: string): number {
  const n = name.toLowerCase();
  if (
    /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|cargo\.lock|go\.sum|poetry\.lock|composer\.lock)$/.test(
      n,
    ) ||
    /\.(lock|min\.js|min\.css|map|snap)$/.test(n) ||
    /(^|\/)(dist|build|vendor|node_modules|__generated__|generated)\//.test(n)
  ) {
    return 3; // generated / lockfiles — least useful to a reviewer
  }
  if (/(\.test\.|\.spec\.|(^|\/)(tests?|__tests__|e2e)\/)/.test(n)) return 1; // tests
  if (/\.(json|ya?ml|toml|ini|cfg|config\.\w+)$/.test(n)) return 2; // config
  return 0; // source
}

/** One layer of a layered plan, as described to a per-layer tour call. */
export interface LayerScopeInfo {
  title: string;
  intent: string;
  focus: string[];
  /** 0-based position in the plan. */
  index: number;
  total: number;
}

export interface ContextOptions {
  /** Character budget for the diff. Defaults to `DIFF_BUDGET`. */
  budget?: number;
  /** Present when this context covers ONE layer rather than the whole PR —
   * renders the "## This slice" block that fences the call's scope. */
  scope?: LayerScopeInfo;
}

/** A built context plus what the model can actually see of the PR, which is what
 * every count budget is derived from. */
export interface ReviewContext {
  text: string;
  size: PrSize;
}

/**
 * Build a self-contained AI review context from a PR's metadata + diff.
 *
 * Files are ordered by reviewer-relevance (source → tests → config → generated),
 * big changes first. The diff is budget-bounded by **fair-share water-filling**:
 * each file may take at most `remaining / filesLeft`, recomputed every
 * iteration, so unused share flows forward and one oversize file can no longer
 * consume the budget and take the rest of the PR down with it. What got cut is
 * reported to the model in a `## Note`, and to the caller as `size.coverage`.
 */
export function buildReviewContext(
  detail: PullDetail,
  files: PullFile[],
  repoKey: string,
  number: number,
  opts?: ContextOptions,
): ReviewContext {
  const d = detail;
  const head = [
    `Pull request ${repoKey}#${number}: ${d.title}`,
    `Author: @${d.user.login}`,
    `Branches: ${d.head.ref} → ${d.base.ref}`,
    `Changed files: ${d.changed_files ?? "?"} (+${d.additions ?? "?"} / -${d.deletions ?? "?"})`,
    "",
    "## Description",
    d.body?.trim() || "(no description)",
  ].join("\n");

  const sorted = [...files].sort((a, b) => {
    const r = fileRank(a.filename) - fileRank(b.filename);
    if (r !== 0) return r;
    return b.additions + b.deletions - (a.additions + a.deletions);
  });

  let remaining = opts?.budget ?? DIFF_BUDGET;
  let left = sorted.length;
  const blocks: string[] = [];
  const omitted: string[] = [];
  let truncated = 0;
  let churn = 0;
  let shownFiles = 0;
  let shownChurn = 0;

  for (const f of sorted) {
    // Recomputed per file, so budget an earlier file didn't need is available
    // to this one — while no single file can starve the ones behind it.
    const share = Math.max(MIN_SLICE, Math.floor(remaining / Math.max(1, left)));
    left--;

    const fileChurn = f.additions + f.deletions;
    churn += fileChurn;

    const label = `### ${f.filename} (+${f.additions} / -${f.deletions})`;
    if (!f.patch) {
      // Binary, or a pure rename — listed so the model knows it changed, but
      // there is nothing to read and nothing to charge against the budget.
      blocks.push(`${label}\n(no textual diff)`);
      continue;
    }

    const full = `${label}\n\`\`\`diff\n${f.patch}\n\`\`\``;
    if (full.length <= share && full.length <= remaining) {
      blocks.push(full);
      remaining -= full.length;
      shownFiles++;
      shownChurn += fileChurn;
      continue;
    }

    // Doesn't fit its share: show as much as the share allows rather than
    // dropping the file entirely.
    const room = Math.min(share, remaining) - label.length - 40;
    if (room > 400) {
      const raw = f.patch.slice(0, room);
      // Cut on a line boundary so the model never sees half a diff line — but
      // don't give back more than 200 chars chasing one.
      const nl = raw.lastIndexOf("\n");
      const cut = nl >= room - 200 ? raw.slice(0, nl) : raw;
      blocks.push(`${label}\n\`\`\`diff\n${cut}\n… (diff truncated)\n\`\`\``);
      truncated++;
      remaining = Math.max(0, remaining - (cut.length + label.length + 40));
      shownFiles++;
      // Truncation-aware: a half-shown file contributes half its lines, so
      // `coverage` reflects what the model can really review.
      shownChurn += Math.round(fileChurn * (cut.length / f.patch.length));
    } else {
      omitted.push(f.filename);
    }
  }

  const notes: string[] = [];
  if (truncated > 0) notes.push(`${truncated} file(s) had their diff truncated for length.`);
  if (omitted.length > 0) {
    const shown = omitted.slice(0, 10).join(", ");
    notes.push(
      `${omitted.length} file(s) omitted for length (not shown to you): ${shown}${omitted.length > 10 ? ", …" : ""}.`,
    );
  }
  const footer = notes.length > 0 ? `\n\n## Note\n${notes.join(" ")}` : "";

  const scope = opts?.scope ? `\n\n${renderScope(opts.scope, files.length)}` : "";

  return {
    text: `${head}${scope}\n\n## Diff\n\n${blocks.join("\n\n")}${footer}`,
    size: {
      files: files.length,
      churn,
      shownFiles,
      shownChurn,
      coverage: toCoverage(shownChurn, churn),
    },
  };
}

/**
 * The "you are reading one slice" block. It has to be emphatic: a per-layer call
 * sees a fraction of the PR, and without an explicit fence the model treats the
 * files it wasn't given as missing and flags their absence.
 */
function renderScope(s: LayerScopeInfo, fileCount: number): string {
  const lines = [
    `## This slice (layer ${s.index + 1} of ${s.total}: "${s.title}")`,
    `You are touring ONE layer of a larger pull request.${s.intent ? ` What this layer changes: ${s.intent}` : ""}`,
  ];
  if (s.focus.length > 0) lines.push(`Verify while reading: ${s.focus.join("; ")}`);
  lines.push(
    `The ${fileCount} file(s) below are the ENTIRE scope of this call. Every other file in the PR is being toured separately by another call — never anchor a step outside these files, and never flag a file as missing just because it isn't here.`,
  );
  return lines.join("\n");
}

/**
 * The review context plus an EXHAUSTIVE list of the PR's paths, for the layered
 * planner. The diff itself is budget-bounded — on a large PR some files are
 * truncated or dropped entirely — but a layering must account for every single
 * file, so the planner gets the full inventory even when it can't see every
 * patch. It doubles as the planner's checklist and as the only paths it's
 * allowed to name.
 */
export function buildLayerContext(context: string, files: PullFile[]): string {
  const inventory = files
    .map((f) => `${f.filename} (${f.status}, +${f.additions} / -${f.deletions})`)
    .join("\n");
  return `${context}\n\n## Complete file list (${files.length} files — every one must land in exactly one layer)\n${inventory}`;
}
