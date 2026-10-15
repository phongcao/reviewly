import { buildClaimCheckPrompt, buildConcernCheckPrompt } from "@/lib/ai/prompts";
import { findFile } from "@/lib/ai/verify";
import {
  type CheckRecord,
  checkTypeFor,
  parseCheckResult,
  parseClaimCheck,
} from "@/lib/claim-check";
import { stepId } from "@/lib/deep-tour";
import type { GuidedStep } from "@/lib/guided";
import type { PullFile } from "@/lib/tauri";
import { invoke } from "@/lib/tauri";
import { aiInvokeArgs, useAiProvider } from "@/stores/ai";
import { checksKey, runKey, useStepCheckRuns, useStepChecks } from "@/stores/step-checks";
import { useCallback, useMemo } from "react";

/**
 * How many checks a "Check all" runs at once. Same budget and reasoning as
 * `DEEP_TOUR_CONCURRENCY`: each check is an AI CLI process, and the app may
 * already be running a tour or a chat beside it.
 */
export const CHECK_CONCURRENCY = 2;

/** Lines of file around a repository stop's anchor sent to the claim check. */
export const REPO_EXCERPT_LINES = 40;

/** Stops a "Check all" would send: unchecked claim-check stops not already
 * running. `allKinds` for a codebase tour, where every stop gets a claim check. */
export function pendingClaimChecks(
  steps: GuidedStep[],
  checks: Record<string, CheckRecord> | undefined,
  inFlight: (id: string) => boolean,
  allKinds = false,
): GuidedStep[] {
  return steps.filter((s) => {
    if (!allKinds && checkTypeFor(s.kind) !== "claims") return false;
    const id = stepId(s);
    return !checks?.[id] && !inFlight(id);
  });
}

/**
 * Run checks on tour stops and persist the results.
 *
 * Each call is an `ai_review` — a fresh CLI process with no session resume —
 * so the checker never sees the conversation that produced the tour. That
 * separation is the point of the check; do not route these through a chat.
 */
export function useStepCheckRunner({
  subject,
  headSha,
  files,
  cwd,
  repo,
}: {
  /** The PR key (`owner/repo#n`), or `repo:owner/repo` for a codebase tour. */
  subject: string;
  headSha?: string;
  files: PullFile[];
  /** Local clone, when there is one. Required for concern checks. */
  cwd: string | null;
  /** Set for a codebase tour: every stop gets a claim check against the file
   * at `HEAD` (read from `cwd`), not against a patch. */
  repo?: boolean;
}) {
  const key = useMemo(() => checksKey(subject, headSha), [subject, headSha]);

  /** Check one stop. Throws on an AI failure; the caller decides how loud. */
  const check = useCallback(
    async (step: GuidedStep): Promise<void> => {
      const id = stepId(step);
      const rk = runKey(key, id);
      const runs = useStepCheckRuns.getState();
      if (runs.inFlight[rk]) return;
      const type = repo ? "claims" : checkTypeFor(step.kind);
      if (type === "concern" && !cwd) throw new Error("a concern check needs a local clone");
      runs.start(rk);
      try {
        const provider = useAiProvider.getState().provider;
        // A repository stop is checked against the file itself: the lines
        // around the anchor, numbered, and the file's length for the parser.
        const fileText =
          repo && cwd
            ? await invoke<string>("read_file", { path: `${cwd}/${step.path}`, root: cwd }).catch(
                () => "",
              )
            : null;
        const fileLines = fileText === null ? [] : fileText.split("\n");
        const from = Math.max(1, step.line - REPO_EXCERPT_LINES);
        const to = (step.endLine ?? step.line) + REPO_EXCERPT_LINES;
        const prompt =
          type === "concern"
            ? buildConcernCheckPrompt(step)
            : buildClaimCheckPrompt({
                path: step.path,
                line: step.line,
                endLine: step.endLine,
                title: step.title,
                detail: step.detail,
                patch: findFile(files, step.path)?.patch ?? null,
                clone: !!cwd,
                ...(fileText !== null
                  ? { file: { text: fileLines.slice(from - 1, to).join("\n"), startLine: from } }
                  : {}),
              });
        const out = await invoke<string>("ai_review", { ...aiInvokeArgs(), cwd, prompt });
        const checkedAt = Date.now();
        const record: CheckRecord =
          type === "concern"
            ? { type, ...parseCheckResult(out), checkedAt, provider }
            : {
                type,
                ...parseClaimCheck(out, {
                  step,
                  files,
                  clone: !!cwd,
                  ...(fileText !== null
                    ? {
                        repoFile: {
                          path: step.path,
                          lines: fileLines.length - (fileText.endsWith("\n") ? 1 : 0),
                        },
                      }
                    : {}),
                }),
                checkedAt,
                provider,
              };
        useStepChecks.getState().set(key, id, record);
      } finally {
        useStepCheckRuns.getState().finish(rk);
      }
    },
    [key, files, cwd, repo],
  );

  /**
   * Claim-check every given stop, `CHECK_CONCURRENCY` at a time. Results are
   * written as each lands, so cancelling keeps everything already checked.
   * Cancel stops new calls; the ones already running finish and are kept —
   * `ai_review` has no key to kill it by.
   */
  const checkAll = useCallback(
    async (steps: GuidedStep[]): Promise<{ done: number; failed: number; cancelled: boolean }> => {
      const runs = useStepCheckRuns.getState();
      if (runs.batch[key]) return { done: 0, failed: 0, cancelled: false };
      const queue = [...steps];
      let done = 0;
      let failed = 0;
      runs.setBatch(key, { done: 0, total: queue.length, cancelled: false });
      const cancelled = () => !!useStepCheckRuns.getState().batch[key]?.cancelled;
      const worker = async () => {
        while (queue.length > 0 && !cancelled()) {
          const step = queue.shift();
          if (!step) break;
          try {
            await check(step);
          } catch {
            failed++;
          }
          done++;
          const cur = useStepCheckRuns.getState().batch[key];
          if (cur) useStepCheckRuns.getState().setBatch(key, { ...cur, done });
        }
      };
      await Promise.all(Array.from({ length: CHECK_CONCURRENCY }, worker));
      const wasCancelled = cancelled();
      useStepCheckRuns.getState().setBatch(key, undefined);
      return { done, failed, cancelled: wasCancelled };
    },
    [key, check],
  );

  const cancelAll = useCallback(() => {
    const cur = useStepCheckRuns.getState().batch[key];
    if (cur) useStepCheckRuns.getState().setBatch(key, { ...cur, cancelled: true });
  }, [key]);

  return { key, check, checkAll, cancelAll };
}
