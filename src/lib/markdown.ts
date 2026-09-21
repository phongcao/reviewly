import type { Hunk } from "@/lib/diff";

/** File extensions we can render as a document instead of a diff. */
const MARKDOWN_EXT = new Set(["md", "markdown", "mdown", "mkd", "mdx"]);

/** True when `path` is a Markdown document (by extension). */
export function isMarkdownPath(path: string | null | undefined): boolean {
  if (!path) return false;
  const base = path.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot < 1) return false;
  return MARKDOWN_EXT.has(base.slice(dot + 1).toLowerCase());
}

export interface PatchText {
  text: string;
  /**
   * True when the text is the whole file — the hunks start at line 1 and run
   * without gaps. False means unchanged regions were never sent in the patch,
   * so the rendered document is missing pieces.
   */
  complete: boolean;
}

/**
 * Reconstruct one side of a file from its parsed patch — the fallback source
 * for the rendered preview when the full HEAD content isn't available (still
 * loading, or the file was deleted and has no HEAD blob at all).
 *
 * Only hunk content exists in a patch, so unchanged regions between hunks are
 * simply absent; `complete` says whether that happened, and the preview warns
 * when it did rather than silently showing a document with holes in it.
 */
export function sideText(hunks: Hunk[], side: "new" | "old"): PatchText {
  const keep = side === "new" ? "del" : "add";
  const out: string[] = [];
  let next = 1;
  let complete = true;
  for (const h of hunks) {
    const start = side === "new" ? h.newStart : h.oldStart;
    if (start !== next) complete = false;
    for (const l of h.lines) {
      if (l.kind === "hunk" || l.kind === keep) continue;
      out.push(l.text);
      next = (side === "new" ? l.newLine : l.oldLine) ?? next;
      next += 1;
    }
  }
  return { text: out.join("\n"), complete };
}

export interface RepoRef {
  owner: string;
  repo: string;
  /** Commit sha the document is being read at; null falls back to the branch-less blob path. */
  sha: string | null | undefined;
  /** Repo-relative path of the document itself — relative links resolve against its folder. */
  path: string;
}

/**
 * Resolve a link/image URL found inside a Markdown document to something that
 * works outside the repo checkout.
 *
 * Relative image sources become `raw.githubusercontent.com` URLs, which
 * `GhAttachment` then fetches through Rust with the stored token (so private
 * repos load); relative links become `github.com/.../blob/...` URLs the OS
 * browser can open. Absolute URLs, `mailto:` and in-page anchors are returned
 * untouched.
 */
export function resolveDocUrl(url: string, ref: RepoRef, kind: "src" | "href"): string {
  if (!url) return url;
  if (url.startsWith("#")) {
    // No heading ids are generated in the preview, so an in-page anchor can't
    // scroll here — send it to the rendered file on GitHub, where it works.
    return `${blobBase(ref)}${url}`;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//")) return url;
  const target = joinPath(dirname(ref.path), url);
  if (kind === "src") {
    return `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${ref.sha ?? "HEAD"}/${target}`;
  }
  return `https://github.com/${ref.owner}/${ref.repo}/blob/${ref.sha ?? "HEAD"}/${target}`;
}

function blobBase(ref: RepoRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}/blob/${ref.sha ?? "HEAD"}/${ref.path}`;
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** Join `base` with a relative path, collapsing `.` and `..` segments. */
function joinPath(base: string, rel: string): string {
  const stripped = rel.replace(/^\.\//, "");
  const parts = stripped.startsWith("/")
    ? stripped.slice(1).split("/")
    : [...base.split("/").filter(Boolean), ...stripped.split("/")];
  const out: string[] = [];
  for (const p of parts) {
    if (!p || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}
