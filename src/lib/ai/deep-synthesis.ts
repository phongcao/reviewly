import { firstString } from "@/lib/ai/json";
import { buildDeepSummarySystem } from "@/lib/ai/prompts";
import {
  allLayersToured,
  deepSummaryInput,
  synthKey,
  synthesisBasis,
  synthesisFresh,
} from "@/lib/deep-tour";
import { invoke } from "@/lib/tauri";
import { aiInvokeArgs } from "@/stores/ai";
import { useDeepTour } from "@/stores/deep-tour";

/**
 * `prKey` → the `head|basis` last sent. A failed or unparseable synthesis
 * must not retry in a loop every time the tour re-renders; a new basis (a
 * regenerated layer) or a new head is what earns another call. In memory on
 * purpose: after a restart one more attempt is fine.
 */
const attempted = new Map<string, string>();

/**
 * Start the whole-PR synthesis for a deep tour when every layer has landed and
 * no fresh synthesis exists. Safe to call often — from the event bridge as the
 * run drains, and from the tour pane for tours that finished before this
 * existed. One call per (head, batches); no diff in the prompt, so no `cwd`.
 */
export function maybeSynthesize(prKey: string): void {
  const entry = useDeepTour.getState().byPr[prKey];
  if (!entry || !allLayersToured(entry) || synthesisFresh(entry)) return;
  const sig = `${entry.headSha}|${synthesisBasis(entry.byLayer)}`;
  if (attempted.get(prKey) === sig) return;
  attempted.set(prKey, sig);
  invoke("ai_review_bg", {
    key: synthKey(prKey),
    ...aiInvokeArgs(),
    headSha: entry.headSha,
    cwd: null,
    prompt: `${buildDeepSummarySystem()}\n\n${deepSummaryInput(entry)}`,
  }).catch(() => {});
}

/** Parse the synthesis reply. Null when it holds no summary — the planner's
 * sentence then stays, labeled as such, which is the honest fallback. */
export function parseSynthesis(out: string): { summary: string; verdictReason: string } | null {
  const summary = firstString(out, "summary").trim();
  if (!summary) return null;
  return { summary, verdictReason: firstString(out, "verdictReason").trim() };
}

/** Land a finished synthesis — the `ai:done` side of `maybeSynthesize`. The
 * basis is read from the entry NOW: if a layer was regenerated while this was
 * in flight, the stored basis won't match and the synthesis is ignored, and
 * the next `maybeSynthesize` sends a fresh one. */
export function landSynthesis(prKey: string, out: string, headSha: string): void {
  const parsed = parseSynthesis(out);
  const entry = useDeepTour.getState().byPr[prKey];
  if (!parsed || !entry) return;
  const sig = attempted.get(prKey);
  const basis = sig ? sig.slice(sig.indexOf("|") + 1) : synthesisBasis(entry.byLayer);
  useDeepTour.getState().setSynthesis(prKey, {
    ...parsed,
    headSha,
    generatedAt: Date.now(),
    basis,
  });
}
