import { dataUrlSize } from "@/lib/images";
import { invoke } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { ImageOff, Loader2 } from "lucide-react";
import { type ReactNode, useState } from "react";

interface Props {
  owner: string;
  repo: string;
  path: string;
  /** GitHub file status: added, removed, modified, renamed, … */
  status?: string;
  /** Pre-rename path — the "before" side is read from here. */
  previousPath?: string | null;
  headSha?: string | null;
  baseSha?: string | null;
  className?: string;
}

/**
 * Show an image file the way it changed: just the new image when added, just
 * the old one when removed, and before/after side by side otherwise. Images
 * have no text patch, so without this the reviewer's only option was to leave
 * the app for GitHub.
 *
 * Bytes come through Rust with the stored token (private repos), keyed by
 * commit sha so a side is fetched once per PR head.
 */
export function ImagePreview({
  owner,
  repo,
  path,
  status,
  previousPath,
  headSha,
  baseSha,
  className,
}: Props) {
  const hasBefore = status !== "added" && status !== "copied";
  const hasAfter = status !== "removed";
  const before = useFileImage(owner, repo, previousPath || path, hasBefore ? baseSha : null);
  const after = useFileImage(owner, repo, path, hasAfter ? headSha : null);

  // A pure rename keeps identical bytes — one image says it all.
  const same = before.data != null && before.data === after.data;

  return (
    <div
      className={cn(
        "grid gap-4 px-5 py-4",
        hasBefore && hasAfter && !same && "grid-cols-[repeat(auto-fit,minmax(16rem,1fr))]",
        className,
      )}
    >
      {hasBefore && !same && (
        <ImagePane label={hasAfter ? "Before" : "Deleted"} tone="removed" q={before} />
      )}
      {hasAfter && (
        <ImagePane
          label={same ? "Unchanged" : hasBefore ? "After" : "Added"}
          tone={same ? "neutral" : "added"}
          q={after}
        />
      )}
    </div>
  );
}

function useFileImage(owner: string, repo: string, path: string, ref: string | null | undefined) {
  return useQuery({
    queryKey: ["file-data-url", owner, repo, ref, path],
    queryFn: () =>
      invoke<string>("gh_get_file_data_url", { owner, repo, path, ref: ref as string }),
    enabled: !!ref,
    // Content at a sha never changes.
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

function ImagePane({
  label,
  tone,
  q,
}: {
  label: string;
  tone: "added" | "removed" | "neutral";
  q: ReturnType<typeof useFileImage>;
}) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [broken, setBroken] = useState(false);

  let body: ReactNode;
  if (q.isLoading || (q.fetchStatus === "idle" && q.data == null && !q.error)) {
    body = (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        Loading image…
      </span>
    );
  } else if (q.error || broken || !q.data) {
    body = (
      <span className="inline-flex max-w-sm items-start gap-1.5 text-left text-xs text-muted-foreground">
        <ImageOff className="mt-px size-3.5 shrink-0" />
        {broken
          ? // Typically a Git LFS pointer, or a format the webview can't decode.
            "This file can't be displayed as an image."
          : `Couldn't load the image: ${q.error instanceof Error ? q.error.message : String(q.error ?? "no content")}`}
      </span>
    );
  } else {
    body = (
      <img
        src={q.data}
        alt={label}
        className="max-h-[70vh] max-w-full object-contain"
        onLoad={(e) =>
          setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
        }
        onError={() => setBroken(true)}
      />
    );
  }

  return (
    <figure className="m-0 flex min-w-0 flex-col gap-1.5">
      <figcaption className="flex items-center gap-2 text-xs">
        <span
          className={cn(
            "rounded px-1.5 py-px font-medium",
            tone === "added" && "bg-success/15 text-success",
            tone === "removed" && "bg-destructive/15 text-destructive",
            tone === "neutral" && "bg-foreground/[0.07] text-muted-foreground",
          )}
        >
          {label}
        </span>
        {q.data && !broken && (
          <span className="tabular-nums text-muted-foreground">
            {dims ? `${dims.w} × ${dims.h} · ` : ""}
            {dataUrlSize(q.data)}
          </span>
        )}
      </figcaption>
      <div className="image-checker flex min-h-32 items-center justify-center rounded-md p-3">
        {body}
      </div>
    </figure>
  );
}
