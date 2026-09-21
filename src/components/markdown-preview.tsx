import { MarkdownBody } from "@/components/markdown-body";
import type { Hunk } from "@/lib/diff";
import { type RepoRef, resolveDocUrl, sideText } from "@/lib/markdown";
import { cn } from "@/lib/utils";
import { FileWarning } from "lucide-react";
import { useMemo } from "react";
import { defaultUrlTransform } from "react-markdown";

interface Props {
  path: string;
  owner: string;
  repo: string;
  /** Head sha of the PR — relative links/images resolve at this commit. */
  headSha?: string | null;
  /** Full HEAD content of the file, when it has been fetched. Preferred source. */
  fileLines?: string[];
  /** Parsed patch — the fallback source while HEAD content is missing. */
  hunks: Hunk[];
  /** True while the HEAD content request is still in flight. */
  loading?: boolean;
  className?: string;
}

/**
 * Render a Markdown file in the diff pane as the document it is, instead of as
 * `+`/`-` lines. Reading twenty ADRs as raw Markdown is the slow half of
 * reviewing a docs-heavy PR — tables, links and nested lists only make sense
 * rendered — so the diff viewer offers this as a toggle per the reviewer's
 * preference, never as a replacement for the diff.
 *
 * Content comes from the file's HEAD blob when available (the whole document,
 * exactly as it will land), and otherwise from the patch's new side, which
 * carries only the changed regions — called out in a banner, because a
 * document silently missing its unchanged middle is worse than no preview.
 */
export function MarkdownPreview({
  path,
  owner,
  repo,
  headSha,
  fileLines,
  hunks,
  loading = false,
  className,
}: Props) {
  const source = useMemo(() => {
    if (fileLines && fileLines.length > 0) {
      return { text: fileLines.join("\n"), complete: true, fromPatch: false };
    }
    // A deleted file has no HEAD blob; show what the patch removed rather
    // than an empty pane.
    const next = sideText(hunks, "new");
    const src = next.text.trim() ? next : sideText(hunks, "old");
    return { ...src, fromPatch: true };
  }, [fileLines, hunks]);

  const ref = useMemo<RepoRef>(
    () => ({ owner, repo, sha: headSha, path }),
    [owner, repo, headSha, path],
  );
  // `defaultUrlTransform` still runs last, so a rewritten URL is protocol-
  // checked exactly like an untouched one.
  const urlTransform = useMemo(
    () => (url: string, key: string) =>
      defaultUrlTransform(resolveDocUrl(url, ref, key === "src" ? "src" : "href")),
    [ref],
  );

  return (
    <div className={cn("px-5 py-4", className)}>
      {source.fromPatch && !source.complete && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-warning/30 bg-warning/[0.07] px-3 py-2 text-xs text-muted-foreground">
          <FileWarning className="mt-px size-3.5 shrink-0 text-warning" />
          <span>
            {loading
              ? "Loading the full document — showing the changed sections only."
              : "Only the changed sections are shown: the full file couldn't be loaded, and a patch carries no unchanged context."}
          </span>
        </div>
      )}
      {source.text.trim() ? (
        <MarkdownBody className="max-w-[72ch]" urlTransform={urlTransform}>
          {source.text}
        </MarkdownBody>
      ) : (
        <p className="text-xs text-muted-foreground">Nothing to render — this file is empty.</p>
      )}
    </div>
  );
}
