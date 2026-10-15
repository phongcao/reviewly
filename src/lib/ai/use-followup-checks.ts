import { buildFollowUpCheckPrompt } from "@/lib/ai/prompts";
import { CHECK_CONCURRENCY } from "@/lib/ai/use-step-checks";
import type { CheckRecord } from "@/lib/claim-check";
import { type FollowUp, parseFollowUpCheck } from "@/lib/followups";
import type { PullFile } from "@/lib/tauri";
import { invoke } from "@/lib/tauri";
import { compareQuery } from "@/lib/use-since-review";
import { aiInvokeArgs, useAiProvider } from "@/stores/ai";
import { useReviewPrefs } from "@/stores/review-prefs";
import { checksKey, runKey, useStepCheckRuns, useStepChecks } from "@/stores/step-checks";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

/** Other changed files listed in one follow-up prompt. */
const MAX_OTHER_FILES = 40;

/** Where follow-up checks live in the step-checks store, per PR head. */
export const followUpsKey = (prKey: string, headSha: string | undefined) =>
  checksKey(`${prKey}#followups`, headSha);

export type FollowUpRecord = Extract<CheckRecord, { type: "followup" }>;

/**
 * Run follow-up checks on the viewer's own threads and persist the results.
 *
 * Like the tour checks, each call is a fresh `ai_review` process: the checker
 * never sees the conversation that produced the comment.
 */
export function useFollowUpRunner({
  owner,
  repo,
  prKey,
  headSha,
  prFiles,
  prAuthor,
  cwd,
}: {
  owner: string;
  repo: string;
  prKey: string;
  headSha: string | undefined;
  prFiles: PullFile[];
  prAuthor: string | null;
  /** Local clone, when there is one. Optional: without it the check reads the diff only. */
  cwd: string | null;
}) {
  const qc = useQueryClient();
  const key = useMemo(() => followUpsKey(prKey, headSha), [prKey, headSha]);

  /** What a fix to `f` is held against: the PR files changed since the
   * comment, or the PR's whole change when GitHub can't compare any more. */
  const changesSince = useCallback(
    async (f: FollowUp): Promise<{ changes: PullFile[]; basis: FollowUpRecord["basis"] }> => {
      if (!headSha || !f.originalCommit) return { changes: prFiles, basis: "whole-pr" };
      if (f.originalCommit === headSha) return { changes: [], basis: "since-comment" };
      const range = await qc
        .fetchQuery(compareQuery(owner, repo, f.originalCommit, headSha))
        .catch(() => null);
      if (
        !range ||
        range.files_truncated ||
        (range.status !== "ahead" && range.status !== "identical")
      ) {
        return { changes: prFiles, basis: "whole-pr" };
      }
      const inPr = new Set(prFiles.map((p) => p.filename));
      return { changes: range.files.filter((p) => inPr.has(p.filename)), basis: "since-comment" };
    },
    [qc, owner, repo, headSha, prFiles],
  );

  /** Check one thread. Throws on an AI failure; the caller decides how loud. */
  const check = useCallback(
    async (f: FollowUp): Promise<void> => {
      const rk = runKey(key, f.threadId);
      const runs = useStepCheckRuns.getState();
      if (runs.inFlight[rk]) return;
      runs.start(rk);
      try {
        const provider = useAiProvider.getState().provider;
        const { changes, basis } = await changesSince(f);
        const file = changes.find((c) => c.filename === f.path);
        const instructions = useReviewPrefs.getState().aiInstructions.trim();
        const prompt = buildFollowUpCheckPrompt({
          path: f.path,
          originalLine: f.originalLine,
          originalCommit: f.originalCommit,
          reviewer: f.root.user.login,
          comment: f.root.body,
          diffHunk: f.diffHunk,
          replies: f.replies.map((r) => ({ author: r.user.login, body: r.body })),
          prAuthor,
          resolved: f.resolved,
          resolvedBy: f.resolvedBy,
          outdated: f.outdated,
          patch: file?.patch ?? null,
          basis,
          otherFiles: changes
            .filter((c) => c.filename !== f.path)
            .slice(0, MAX_OTHER_FILES)
            .map((c) => `${c.filename} (+${c.additions} −${c.deletions})`),
          clone: !!cwd,
          custom: instructions ? `\n\n# Reviewer's instructions\n${instructions}` : "",
        });
        const out = await invoke<string>("ai_review", { ...aiInvokeArgs(), cwd, prompt });
        const record: FollowUpRecord = {
          type: "followup",
          ...parseFollowUpCheck(out, changes),
          lastCommentId: f.lastCommentId,
          basis,
          clone: !!cwd,
          checkedAt: Date.now(),
          provider,
        };
        useStepChecks.getState().set(key, f.threadId, record);
      } finally {
        useStepCheckRuns.getState().finish(rk);
      }
    },
    [key, changesSince, prAuthor, cwd],
  );

  /** Check every given thread, `CHECK_CONCURRENCY` at a time. Results land as
   * each finishes; Cancel stops new calls and keeps what already ran. */
  const checkAll = useCallback(
    async (list: FollowUp[]): Promise<{ done: number; failed: number; cancelled: boolean }> => {
      const runs = useStepCheckRuns.getState();
      if (runs.batch[key]) return { done: 0, failed: 0, cancelled: false };
      const queue = [...list];
      let done = 0;
      let failed = 0;
      runs.setBatch(key, { done: 0, total: queue.length, cancelled: false });
      const cancelled = () => !!useStepCheckRuns.getState().batch[key]?.cancelled;
      const worker = async () => {
        while (queue.length > 0 && !cancelled()) {
          const f = queue.shift();
          if (!f) break;
          try {
            await check(f);
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
