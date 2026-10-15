import { EmptyState } from "@/components/empty-state";
import { MarkdownPreview } from "@/components/markdown-preview";
import { SourceView } from "@/components/source-view";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { type RepoRef, isMarkdownPath } from "@/lib/markdown";
import { invoke } from "@/lib/tauri";
import { useQuery } from "@tanstack/react-query";
import { FileCode } from "lucide-react";

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;

export function RepoCodeView({
  root,
  path,
  line,
  lineNonce,
  preview,
}: {
  /** The clone `path` is in; reads are refused outside it. */
  root: string;
  path: string | null;
  /** 1-based line to scroll to and mark — set by the Explain tab. */
  line?: number | null;
  /** Bump to scroll again when the same line is requested twice. */
  lineNonce?: number;
  /** Render a Markdown file as a document, its links resolved against this
   * ref (repository-relative `path`). Ignored for any other file. */
  preview?: RepoRef | null;
}) {
  const isImage = !!path && IMAGE_RE.test(path);
  const file = useQuery({
    queryKey: ["file", path],
    queryFn: () => invoke<string>("read_file", { path: path as string, root }),
    enabled: !!path && !isImage,
    retry: false,
    staleTime: 30_000,
  });
  const image = useQuery({
    queryKey: ["file-image", path],
    queryFn: () => invoke<string>("read_file_data_url", { path: path as string, root }),
    enabled: isImage,
    retry: false,
    staleTime: 30_000,
  });

  if (!path) {
    return (
      <EmptyState icon={FileCode} title="Pick a file" description="Browse the tree to view code." />
    );
  }

  // Images preview as a centered, contained render on a checkerboard (so
  // transparency reads), instead of the text path that rejects binary content.
  if (isImage) {
    if (image.isLoading) {
      return (
        <div className="flex h-full items-center justify-center p-8">
          <Skeleton className="size-48" />
        </div>
      );
    }
    if (image.isError) {
      return (
        <div className="p-6 text-xs text-muted-foreground">
          Can't preview this image — {String(image.error)}
        </div>
      );
    }
    return (
      <div
        className="flex h-full items-center justify-center overflow-auto p-8"
        style={{
          background:
            "repeating-conic-gradient(rgba(128,128,128,0.08) 0% 25%, transparent 0% 50%) 0 0 / 18px 18px",
        }}
      >
        <img
          src={image.data}
          alt={path.split("/").pop() ?? "image"}
          className="max-h-full max-w-full rounded-md border border-border/40 object-contain"
        />
      </div>
    );
  }

  if (file.isLoading) {
    return (
      <div className="space-y-2 p-4">
        {[...Array(10)].map((_, i) => (
          <Skeleton key={i} className="h-4 w-full" />
        ))}
      </div>
    );
  }
  if (file.isError) {
    return (
      <div className="p-6 text-xs text-muted-foreground">
        Can't preview this file — {String(file.error)}
      </div>
    );
  }

  if (preview && isMarkdownPath(path)) {
    return (
      <ScrollArea className="h-full">
        <MarkdownPreview
          path={preview.path}
          owner={preview.owner}
          repo={preview.repo}
          headSha={preview.sha}
          fileLines={(file.data ?? "").split("\n")}
          hunks={[]}
        />
      </ScrollArea>
    );
  }

  return (
    <ScrollArea className="h-full">
      <SourceView
        path={path}
        content={file.data ?? ""}
        anchorLine={line ?? null}
        anchorNonce={lineNonce}
      />
    </ScrollArea>
  );
}
