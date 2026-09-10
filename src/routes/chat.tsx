import { AiReview } from "@/components/ai-review";
import type { AiAction } from "@/lib/ai-actions";
import { useAttachBridge } from "@/lib/ai/attach-bridge";
import { buildReviewContext } from "@/lib/ai/context";
import { parsePatch } from "@/lib/diff";
import { type PullDetail, type PullFile, invoke } from "@/lib/tauri";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";

/**
 * The AI chat, detached into its own resizable Tauri window. Loaded at
 * `/chat/$owner/$repo/$number`; the root layout renders this window bare (no
 * sidebar / app-wide sync hooks) because its label starts with `chat-`.
 *
 * It re-fetches the PR's detail + diff itself (a separate window is a separate
 * query cache) and rebuilds the review context. Streaming answers arrive over
 * the app-wide `ai:chunk` / `ai:complete` events, which broadcast to every
 * window, so the chat works exactly like the inline panel. The conversation
 * lives in the persisted `useAiChat` store keyed by the same `owner/repo#number`.
 */
export function ChatWindowPage() {
  const { owner, repo, number: numberStr } = useParams({ from: "/chat/$owner/$repo/$number" });
  const number = Number(numberStr);
  const prKey = `${owner}/${repo}#${number}`;
  // Attachments pinned in the main window arrive over this bridge (and our own
  // removals go back the same way).
  useAttachBridge(prKey);

  const detail = useQuery({
    queryKey: ["pull", owner, repo, number],
    queryFn: () => invoke<PullDetail>("gh_get_pull", { owner, repo, number }),
    staleTime: 30_000,
  });
  const files = useQuery({
    queryKey: ["pull-files", owner, repo, number],
    queryFn: () => invoke<PullFile[]>("gh_list_pull_files", { owner, repo, number }),
    staleTime: 60_000,
  });

  const context = useMemo(
    () =>
      detail.data
        ? buildReviewContext(detail.data, files.data ?? [], `${owner}/${repo}`, number).text
        : "",
    [detail.data, files.data, owner, repo, number],
  );
  const headSha = detail.data?.head.sha;

  // A self-contained version of the main window's action runner: it posts via
  // the same authenticated commands. Cache invalidations are skipped — this
  // window doesn't render the timeline, and the main window refetches on focus.
  async function executeAction(a: AiAction): Promise<void> {
    switch (a.type) {
      case "comment":
        await invoke("gh_create_issue_comment", { owner, repo, number, body: a.body });
        break;
      case "review":
        await invoke("gh_submit_review", {
          owner,
          repo,
          number,
          body: a.body,
          event: a.event,
          comments: [],
          commitId: headSha,
        });
        break;
      case "inline_comment": {
        if (!headSha) throw new Error("PR head commit unavailable — reopen the chat.");
        const target = (files.data ?? []).find((f) => f.filename === a.path);
        const commentable =
          !!target?.patch &&
          parsePatch(target.patch).some((h) =>
            h.lines.some((l) => l.kind !== "hunk" && l.newLine === a.line),
          );
        if (!commentable) {
          toast.warning(
            `Line ${a.line} isn't in ${a.path.split("/").pop()}'s diff — posting as a file comment.`,
          );
          await invoke("gh_create_issue_comment", {
            owner,
            repo,
            number,
            body: `**${a.path}:${a.line}**\n\n${a.body}`,
          });
          break;
        }
        await invoke("gh_create_review_comment", {
          owner,
          repo,
          number,
          commitId: headSha,
          path: a.path,
          line: a.line,
          side: a.side,
          body: a.body,
        });
        break;
      }
      case "label": {
        const names = new Set((detail.data?.labels ?? []).map((l) => l.name));
        for (const n of a.add) names.add(n);
        for (const n of a.remove) names.delete(n);
        await invoke("gh_set_pr_labels", { owner, repo, number, labels: [...names] });
        break;
      }
    }
    toast.success("Posted to GitHub");
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header
        data-tauri-drag-region
        className="flex items-center gap-1.5 border-b border-hairline px-3 py-2.5 text-[13px] font-medium text-muted-foreground"
      >
        <Sparkles className="size-3.5 shrink-0 text-primary" />
        <span className="truncate">
          {owner}/{repo} #{number}
        </span>
      </header>
      <div className="min-h-0 flex-1 px-3 py-3">
        {detail.isLoading ? (
          <p className="px-1 py-6 text-center text-xs text-muted-foreground">
            Loading pull request…
          </p>
        ) : detail.error || !detail.data ? (
          <p className="px-1 py-6 text-center text-xs text-destructive">Couldn't load this PR.</p>
        ) : (
          <AiReview
            prKey={prKey}
            context={context}
            executeAction={executeAction}
            files={files.data ?? []}
          />
        )}
      </div>
    </div>
  );
}
