import { EmptyState } from "@/components/empty-state";
import { IconButton } from "@/components/icon-button";
import { SourceView } from "@/components/source-view";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { canGoBack, canGoForward, currentLocation, rankPaths } from "@/lib/review-context";
import { invoke } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useLocalRepos } from "@/stores/local-repos";
import { useReviewContext } from "@/stores/review-context";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, FileSearch, PanelRightClose, Search } from "lucide-react";
import { useDeferredValue, useMemo, useRef, useState } from "react";

/**
 * The third pane: surrounding code, beside the diff rather than instead of it.
 *
 * Deliberately reads from the PR's head SHA over the GitHub API rather than the
 * working tree, so what it shows is the PR's code even when the local clone is
 * on another branch or dirty — and so it works with no clone at all. The clone,
 * when mapped, is used only to *list* candidate paths.
 *
 * It never marks anything viewed. Reading a dependency is not reviewing a
 * change, and conflating the two would quietly inflate review progress.
 */
export function ReviewContextPane({
  owner,
  repo,
  prKey,
  headSha,
  changedPaths,
}: {
  owner: string;
  repo: string;
  prKey: string;
  headSha: string | null;
  /** Fallback candidates when there's no clone to list. */
  changedPaths: string[];
}) {
  const history = useReviewContext((s) => s.byPr[prKey]) ?? { entries: [], index: -1 };
  const back = useReviewContext((s) => s.back);
  const forward = useReviewContext((s) => s.forward);
  const navigate = useReviewContext((s) => s.navigate);
  const setOpen = useReviewContext((s) => s.setOpen);
  const location = currentLocation(history);

  const localRepo = useLocalRepos((s) => s.repos.find((r) => r.owner === owner && r.repo === repo));
  const [picking, setPicking] = useState(false);

  const content = useQuery({
    queryKey: ["file-content", owner, repo, headSha, location?.path],
    queryFn: () =>
      invoke<string>("gh_get_file_content", {
        owner,
        repo,
        path: location?.path as string,
        ref: headSha as string,
      }),
    enabled: !!headSha && !!location?.path,
    staleTime: 5 * 60_000,
    retry: false,
    placeholderData: keepPreviousData,
  });

  return (
    <div className="flex h-full flex-col border-l border-hairline">
      <div className="flex items-center gap-1 border-b border-hairline p-1.5">
        <IconButton
          label="Back"
          disabled={!canGoBack(history)}
          onClick={() => back(prKey)}
          icon={ArrowLeft}
        />
        <IconButton
          label="Forward"
          disabled={!canGoForward(history)}
          onClick={() => forward(prKey)}
          icon={ArrowRight}
        />
        <button
          type="button"
          onClick={() => setPicking(true)}
          className="min-w-0 flex-1 truncate rounded px-1.5 py-1 text-left text-xs text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground"
          title={location?.path ?? "Open a file"}
        >
          {location ? (
            <span className="text-foreground">{location.path}</span>
          ) : (
            <span className="flex items-center gap-1.5">
              <Search className="size-3" /> Open a file…
            </span>
          )}
        </button>
        <IconButton label="Close context" onClick={() => setOpen(false)} icon={PanelRightClose} />
      </div>

      {picking && (
        <PathPicker
          repoPath={localRepo?.path ?? null}
          changedPaths={changedPaths}
          onPick={(path) => {
            setPicking(false);
            navigate(prKey, { path });
          }}
          onClose={() => setPicking(false)}
        />
      )}

      <div className="min-h-0 flex-1">
        {!location ? (
          <EmptyState
            icon={FileSearch}
            title="Nothing open"
            description="Open any file in the repository to read it beside the diff — it won't affect your review progress."
          />
        ) : content.isLoading && !content.data ? (
          <div className="space-y-2 p-4">
            {[...Array(10)].map((_, i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
        ) : content.isError ? (
          <div className="p-6 text-xs text-muted-foreground">
            Couldn't load {location.path} at this commit — {String(content.error)}
          </div>
        ) : (
          <ScrollArea className="h-full">
            <SourceView
              path={location.path}
              content={content.data ?? ""}
              anchorLine={location.line ?? null}
              anchorNonce={history.index}
            />
          </ScrollArea>
        )}
      </div>
    </div>
  );
}

/**
 * Inline file finder. Lists the whole clone when one is mapped — the point of
 * the pane is reaching files the PR *didn't* touch — and falls back to the
 * changed files otherwise, which is all the GitHub API can enumerate cheaply.
 */
function PathPicker({
  repoPath,
  changedPaths,
  onPick,
  onClose,
}: {
  repoPath: string | null;
  changedPaths: string[];
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const dq = useDeferredValue(query);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Same query key as the repo browser's quick-open, so the two share a cache.
  const tracked = useQuery({
    queryKey: ["ls-files", repoPath],
    queryFn: () => invoke<string[]>("git_ls_files", { path: repoPath as string }),
    enabled: !!repoPath,
    staleTime: 60_000,
  });

  const pool = tracked.data ?? changedPaths;
  const results = useMemo(() => rankPaths(pool, dq, 30), [pool, dq]);
  const clamped = Math.min(active, Math.max(0, results.length - 1));

  return (
    <div className="border-b border-hairline">
      <input
        ref={inputRef}
        autoFocus
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          else if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => Math.min(i + 1, results.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter" && results[clamped]) {
            onPick(results[clamped]);
          }
        }}
        placeholder={repoPath ? "Find a file in the repo…" : "Find a changed file…"}
        className="w-full bg-transparent px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground/70"
      />
      <ScrollArea className="max-h-64">
        <ul className="pb-1">
          {results.map((p, i) => (
            <li key={p}>
              <button
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => onPick(p)}
                className={cn(
                  "flex w-full items-baseline gap-1.5 px-2 py-1 text-left text-xs",
                  i === clamped ? "bg-primary/15 text-foreground" : "hover:bg-foreground/[0.04]",
                )}
              >
                <span className="shrink-0">{p.split("/").pop()}</span>
                <span className="min-w-0 truncate text-2xs text-muted-foreground">{p}</span>
              </button>
            </li>
          ))}
          {results.length === 0 && (
            <li className="px-2 py-2 text-2xs text-muted-foreground">
              {repoPath
                ? "No matching file."
                : "No matching changed file. Map a local clone to search the whole repository."}
            </li>
          )}
        </ul>
      </ScrollArea>
    </div>
  );
}
