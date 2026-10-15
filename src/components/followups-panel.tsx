import { MarkdownBody } from "@/components/markdown-body";
import { ReviewThreadGroup } from "@/components/review-thread";
import { TooltipFor } from "@/components/tooltip-for";
import { CodeSpans } from "@/components/tour/code-spans";
import { GradeLabel } from "@/components/tour/grade";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useAiAvailable } from "@/lib/ai/use-ai-available";
import { type FollowUpRecord, useFollowUpRunner } from "@/lib/ai/use-followup-checks";
import type { Evidence } from "@/lib/ai/verify";
import {
  DONE_RANK,
  type FollowUp,
  type FollowUpVerdict,
  followUpFlags,
  hasNewReply,
  latestOtherReply,
  latestOwnReplyAfterOthers,
  needsCheck,
  sortFollowUps,
} from "@/lib/followups";
import { invoke } from "@/lib/tauri";
import type { PullFile, ReviewThread, ReviewThreadGraphQL } from "@/lib/tauri";
import { toastError } from "@/lib/ui";
import { cn } from "@/lib/utils";
import { runKey, useStepCheckRuns, useStepChecks } from "@/stores/step-checks";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ChevronRight, MessageSquareText, X } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { toast } from "sonner";

const VERDICT: Record<
  FollowUpVerdict,
  { label: string; variant: "success" | "warning" | "error" | "secondary" | "info" }
> = {
  addressed: { label: "Addressed", variant: "success" },
  partial: { label: "Partly addressed", variant: "warning" },
  not_addressed: { label: "Not addressed", variant: "error" },
  declined: { label: "Declined", variant: "secondary" },
  unclear: { label: "Unclear", variant: "info" },
};

/** What a grade means on a follow-up, graded against the changes since the comment. */
const FOLLOWUP_GRADE_HELP: Record<Evidence, string> = {
  exact: "On a line changed since your comment.",
  strong: "Next to a change made since your comment.",
  heuristic: "Not in the changes since your comment.",
};

/**
 * "Your comments" — every thread the viewer started, and whether the code
 * pushed since actually addresses it. Checks run only on request.
 */
export function FollowUpsPanel({
  owner,
  repo,
  number,
  prKey,
  headSha,
  prFiles,
  prAuthor,
  cwd,
  followUps,
  gqlThreads,
  comments,
  viewerLogin,
  onJump,
  onClose,
}: {
  owner: string;
  repo: string;
  number: number;
  prKey: string;
  headSha: string | undefined;
  prFiles: PullFile[];
  prAuthor: string | null;
  cwd: string | null;
  followUps: FollowUp[];
  gqlThreads: ReviewThreadGraphQL[];
  comments: ReviewThread[];
  viewerLogin: string | undefined;
  onJump: (path: string, line: number | null) => void;
  onClose: () => void;
}) {
  const { available } = useAiAvailable();
  const runner = useFollowUpRunner({ owner, repo, prKey, headSha, prFiles, prAuthor, cwd });
  const checks = useStepChecks((s) => s.byKey[runner.key]);
  const inFlight = useStepCheckRuns((s) => s.inFlight);
  const batch = useStepCheckRuns((s) => s.batch[runner.key]);

  const recordOf = (f: FollowUp): FollowUpRecord | null => {
    const r = checks?.[f.threadId];
    return r?.type === "followup" ? r : null;
  };
  const isStale = (f: FollowUp, r: FollowUpRecord | null) => !!r && hasNewReply(f, r.lastCommentId);
  const running = (f: FollowUp) => !!inFlight[runKey(runner.key, f.threadId)];

  const pending = followUps.filter((f) => {
    const r = recordOf(f);
    return needsCheck(f, headSha) && (!r || isStale(f, r)) && !running(f);
  });

  const counts = useMemo(() => {
    const c: Partial<Record<FollowUpVerdict, number>> = {};
    for (const f of followUps) {
      const r = checks?.[f.threadId];
      if (r?.type === "followup") c[r.verdict] = (c[r.verdict] ?? 0) + 1;
    }
    return c;
  }, [followUps, checks]);

  // Open work first; addressed and resolved threads sink below a divider.
  // A reply after the check lifts it out of the done group until re-checked.
  const sorted = sortFollowUps(followUps, recordOf, (f) => isStale(f, recordOf(f)));
  const firstDone = sorted.findIndex((x) => x.rank >= DONE_RANK);
  const doneCount = firstDone < 0 ? 0 : sorted.length - firstDone;
  // Nothing left to look at down there, so it starts folded away.
  const [showDone, setShowDone] = useState(false);

  const checkAll = async () => {
    const r = await runner.checkAll(pending);
    if (r.failed > 0) toast.error(`${r.failed} check${r.failed === 1 ? "" : "s"} failed`);
  };
  const checkOne = (f: FollowUp) => {
    runner.check(f).catch((e) => toast.error(`Check failed — ${String(e)}`));
  };

  return (
    <div className="flex h-full flex-col border-l border-hairline">
      <div className="flex items-center gap-2 border-b border-hairline px-3 py-2">
        <MessageSquareText className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">Your comments</span>
        <span className="text-2xs text-muted-foreground tabular-nums">{followUps.length}</span>
        <span className="ml-auto flex items-center gap-1">
          {batch ? (
            <Button size="xs" variant="ghost" onClick={runner.cancelAll} disabled={batch.cancelled}>
              <Spinner className="size-3" />
              {batch.done}/{batch.total} · Cancel
            </Button>
          ) : (
            <Button
              size="xs"
              variant="secondary"
              onClick={() => void checkAll()}
              disabled={pending.length === 0 || available === false}
            >
              Check all{pending.length > 0 ? ` (${pending.length})` : ""}
            </Button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close your comments"
            className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </span>
      </div>

      <div className="border-b border-hairline px-3 py-1.5 text-2xs text-muted-foreground">
        {(Object.keys(VERDICT) as FollowUpVerdict[])
          .filter((v) => counts[v])
          .map((v) => `${counts[v]} ${VERDICT[v].label.toLowerCase()}`)
          .join(" · ") ||
          (followUps.length > 0 && followUps.every((f) => !needsCheck(f, headSha))
            ? "Nothing to check yet: no new commits or replies since your comments. Checks unlock after the author pushes or replies."
            : "Not checked yet.")}
        {!cwd && " Diff only — map a local clone to let the check read the code."}
        {available === false && " The AI provider isn't available."}
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {followUps.length === 0 && (
          <p className="p-3 text-xs text-muted-foreground">
            You haven't started any review threads on this PR.
          </p>
        )}
        {sorted.map(({ f }, i) => (
          <Fragment key={f.threadId}>
            {i === firstDone && (
              <button
                type="button"
                onClick={() => setShowDone((v) => !v)}
                aria-expanded={showDone}
                className="flex w-full items-center gap-2 px-1 pt-2 text-2xs text-muted-foreground hover:text-foreground"
              >
                <ChevronRight
                  className={cn("size-3 shrink-0 transition-transform", showDone && "rotate-90")}
                />
                <span className="shrink-0">Addressed or resolved · {doneCount}</span>
                <span className="h-px flex-1 bg-hairline" />
              </button>
            )}
            {(showDone || firstDone < 0 || i < firstDone) && (
              <FollowUpRow
                f={f}
                record={recordOf(f)}
                stale={isStale(f, recordOf(f))}
                running={running(f)}
                idle={!needsCheck(f, headSha)}
                canCheck={available !== false}
                onCheck={() => checkOne(f)}
                onJump={onJump}
                owner={owner}
                repo={repo}
                number={number}
                thread={gqlThreads.find((t) => t.id === f.threadId)}
                comments={comments}
                viewerLogin={viewerLogin}
              />
            )}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function FollowUpRow({
  f,
  record,
  stale,
  running,
  idle,
  canCheck,
  onCheck,
  onJump,
  owner,
  repo,
  number,
  thread,
  comments,
  viewerLogin,
}: {
  f: FollowUp;
  record: FollowUpRecord | null;
  stale: boolean;
  running: boolean;
  /** No commits and no replies since the comment: nothing to check. */
  idle: boolean;
  canCheck: boolean;
  onCheck: () => void;
  onJump: (path: string, line: number | null) => void;
  owner: string;
  repo: string;
  number: number;
  thread: ReviewThreadGraphQL | undefined;
  comments: ReviewThread[];
  viewerLogin: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  // The suggested reply being edited, or null. The model wrote it from text in
  // the PR, so it is never posted as is: it opens here first, for a person to
  // read and change.
  const [draft, setDraft] = useState<string | null>(null);
  const qc = useQueryClient();
  // The author's latest reply, then the reviewer's own if it came after.
  const replies = [latestOtherReply(f), latestOwnReplyAfterOthers(f)].filter(
    (r): r is ReviewThread => !!r,
  );
  const flags = record ? followUpFlags(record, f) : null;
  const where = `${f.path.split("/").pop()}:${f.line ?? f.originalLine ?? "?"}`;

  const post = useMutation({
    mutationFn: (body: string) =>
      invoke("gh_reply_review_comment", { owner, repo, number, commentId: f.root.id, body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pull-review-comments", owner, repo, number] });
      qc.invalidateQueries({ queryKey: ["pull-review-threads-gql", owner, repo, number] });
      toast.success("Reply posted");
    },
    onError: toastError,
  });

  const threadComments = thread
    ? thread.comment_ids
        .map((id) => comments.find((c) => c.id === id))
        .filter((c): c is ReviewThread => !!c)
    : [];

  return (
    <div
      className={cn(
        "rounded-lg border border-hairline bg-card/40 p-2.5 text-xs",
        f.resolved && !flags?.resolvedNotAddressed && "opacity-75",
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {record ? (
          <Badge variant={VERDICT[record.verdict].variant} size="sm">
            {VERDICT[record.verdict].label}
          </Badge>
        ) : idle ? (
          <Badge variant="outline" size="sm">
            No changes since
          </Badge>
        ) : (
          <Badge variant="outline" size="sm">
            Not checked
          </Badge>
        )}
        {stale && (
          <TooltipFor label="A new reply arrived after this check.">
            <Badge variant="warning" size="sm">
              Stale
            </Badge>
          </TooltipFor>
        )}
        {flags?.resolvedNotAddressed && (
          <Badge variant="warning" size="sm">
            <AlertTriangle /> Resolved, not fixed
          </Badge>
        )}
        {flags?.replyClaimMismatch && (
          <Badge variant="warning" size="sm">
            <AlertTriangle /> Reply says fixed
          </Badge>
        )}
        {f.resolved && (
          <span className="text-2xs text-success">
            resolved{f.resolvedBy ? ` by @${f.resolvedBy}` : ""}
          </span>
        )}
        <button
          type="button"
          onClick={() => onJump(f.path, f.line ?? f.originalLine)}
          className="ml-auto truncate font-mono text-2xs text-muted-foreground hover:text-foreground hover:underline"
          title={f.path}
        >
          {where}
          {f.outdated && " (outdated)"}
        </button>
      </div>

      <div className="mt-1.5 line-clamp-3 text-foreground/90">
        <CodeSpans text={f.root.body} />
      </div>
      {replies.map((reply) => (
        <div
          key={reply.id}
          className="mt-1 line-clamp-2 border-l-2 border-hairline pl-2 text-muted-foreground"
        >
          <span className="font-medium">@{reply.user.login}:</span> <CodeSpans text={reply.body} />
        </div>
      ))}

      {record && (
        <div className="mt-2 space-y-1 rounded-md bg-foreground/[0.03] p-2">
          {record.summary && (
            <p>
              <CodeSpans text={record.summary} />
            </p>
          )}
          {record.downgraded && <p className="text-2xs text-warning">{record.downgraded}</p>}
          {record.basis === "whole-pr" && (
            <p className="text-2xs text-muted-foreground">
              Checked against the whole PR: GitHub can no longer compare with the commit you
              commented on.
            </p>
          )}
          {record.evidence.map((e) => (
            <button
              key={`${e.path}:${e.line}`}
              type="button"
              onClick={() => onJump(e.path, e.line)}
              className="flex w-full items-start gap-1.5 text-left hover:text-foreground"
            >
              <GradeLabel grade={e.grade} help={FOLLOWUP_GRADE_HELP} />
              <span className="font-mono text-2xs text-muted-foreground">
                {e.path.split("/").pop()}:{e.line}
                {e.endLine ? `-${e.endLine}` : ""}
              </span>
              {e.note && (
                <span className="min-w-0 text-2xs">
                  <CodeSpans text={e.note} />
                </span>
              )}
            </button>
          ))}
          {record.followUp && (
            <div className="mt-1 border-t border-hairline pt-1.5">
              <div className="text-2xs text-muted-foreground">Suggested reply</div>
              {draft === null ? (
                <MarkdownBody className="text-xs">{record.followUp}</MarkdownBody>
              ) : (
                <Textarea
                  className="mt-1 min-h-20 text-xs"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  autoFocus
                />
              )}
              <div className="mt-1 flex gap-1">
                {draft === null ? (
                  <Button
                    size="xs"
                    variant="secondary"
                    onClick={() => setDraft(record.followUp as string)}
                  >
                    Edit reply
                  </Button>
                ) : (
                  <>
                    <Button
                      size="xs"
                      variant="secondary"
                      disabled={post.isPending || !draft.trim()}
                      onClick={() => post.mutate(draft, { onSuccess: () => setDraft(null) })}
                    >
                      Post reply
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => setDraft(null)}>
                      Cancel
                    </Button>
                  </>
                )}
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    void navigator.clipboard.writeText(record.followUp as string);
                    toast.success("Copied");
                  }}
                >
                  Copy
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {f.outdated && f.diffHunk && open && (
        <pre className="mt-2 max-h-40 overflow-auto rounded bg-foreground/[0.04] p-2 font-mono text-2xs">
          {f.diffHunk}
        </pre>
      )}

      <div className="mt-2 flex items-center gap-1">
        {(!idle || stale) && (
          <Button
            size="xs"
            variant={stale ? "secondary" : "ghost"}
            onClick={onCheck}
            disabled={running || !canCheck}
          >
            {running ? <Spinner className="size-3" /> : null}
            {running ? "Checking…" : stale ? "Re-check new reply" : record ? "Re-check" : "Check"}
          </Button>
        )}
        <Button size="xs" variant="ghost" onClick={() => setOpen((o) => !o)} disabled={!thread}>
          {open ? "Hide thread" : "Show thread"}
        </Button>
        {record && (
          <span className="ml-auto text-2xs text-muted-foreground/70">
            {record.clone ? "read clone" : "diff only"} · {record.provider}
          </span>
        )}
      </div>

      {open && thread && threadComments.length > 0 && (
        <ReviewThreadGroup
          owner={owner}
          repo={repo}
          number={number}
          thread={thread}
          comments={threadComments}
          viewerLogin={viewerLogin}
          hideLocation
          className="mt-2"
        />
      )}
    </div>
  );
}
