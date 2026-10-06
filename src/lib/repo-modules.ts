/**
 * A repository cut into modules — the unit a codebase map is planned over.
 *
 * The PR layer planner works file by file, which breaks past a few hundred
 * files: the prompt can't hold them and the model can't group them. A module
 * is a directory sized to be one idea: big directories split into their
 * children, tiny ones fold into their parent, so a mid-size repository comes
 * out as tens of modules rather than thousands of files. Directory structure
 * is the one grouping every repository already has and nobody has to infer.
 */
import type { RepoFile } from "@/lib/repo-files";

export interface RepoModule {
  /** The directory, or `(root)` for files at the top of the repository. */
  id: string;
  /** `""` for `(root)`. */
  dir: string;
  files: string[];
  lines: number;
  /** Languages by line count, largest first. `text` is left out. */
  langs: string[];
  hasTests: boolean;
}

export const ROOT_MODULE = "(root)";
/** Split a directory into its children above either of these. */
export const SPLIT_LINES = 8_000;
export const SPLIT_FILES = 60;
/** Fold a module under this many lines into its parent. */
export const MERGE_LINES = 200;

/** Files kept out of every module: no reader learns a codebase from them. */
export const isSkippedFile = (f: RepoFile): boolean =>
  f.kind === "generated" || f.kind === "binary";

/** What the map leaves out, so the UI can say so instead of hiding it. */
export function skippedTotal(files: RepoFile[]): { files: number; lines: number } {
  const skipped = files.filter(isSkippedFile);
  return { files: skipped.length, lines: skipped.reduce((n, f) => n + f.lines, 0) };
}

const parentDir = (dir: string): string =>
  dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";

function build(dir: string, files: RepoFile[]): RepoModule {
  const byLang = new Map<string, number>();
  for (const f of files)
    if (f.lang !== "text") byLang.set(f.lang, (byLang.get(f.lang) ?? 0) + f.lines);
  return {
    id: dir || ROOT_MODULE,
    dir,
    files: files.map((f) => f.path).sort(),
    lines: files.reduce((n, f) => n + f.lines, 0),
    langs: [...byLang.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l),
    hasTests: files.some((f) => f.kind === "test"),
  };
}

/**
 * Cut `dir` into modules. Files directly in it form its own module; each
 * child directory is either one module or, when too big, cut recursively.
 * Child modules under `MERGE_LINES` fold into `dir`'s own module.
 */
function cut(dir: string, files: RepoFile[]): Map<string, RepoFile[]> {
  const out = new Map<string, RepoFile[]>();
  const lines = files.reduce((n, f) => n + f.lines, 0);
  if (lines <= SPLIT_LINES && files.length <= SPLIT_FILES) {
    out.set(dir, files);
    return out;
  }
  const prefix = dir ? `${dir}/` : "";
  const direct: RepoFile[] = [];
  const children = new Map<string, RepoFile[]>();
  for (const f of files) {
    const rest = f.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash < 0) {
      direct.push(f);
    } else {
      const child = prefix + rest.slice(0, slash);
      const list = children.get(child);
      if (list) list.push(f);
      else children.set(child, [f]);
    }
  }
  // A directory whose only content is one subdirectory gains nothing from
  // splitting at this level — descend straight into the child.
  if (direct.length === 0 && children.size === 1) {
    const [[child, list]] = [...children];
    return cut(child, list);
  }
  const own = [...direct];
  for (const [child, list] of children) {
    for (const [id, mod] of cut(child, list)) {
      const modLines = mod.reduce((n, f) => n + f.lines, 0);
      if (modLines < MERGE_LINES) own.push(...mod);
      else out.set(id, mod);
    }
  }
  if (own.length > 0) out.set(dir, own);
  return out;
}

/**
 * Modules for a repository's files, largest first.
 *
 * Generated and binary files are left out (see `skippedTotal`). Root-level
 * files form the `(root)` module, and a small top-level directory folds into
 * it, the same way any small module folds into its parent.
 */
export function detectModules(files: RepoFile[]): RepoModule[] {
  const kept = files.filter((f) => !isSkippedFile(f));
  const root: RepoFile[] = [];
  const top = new Map<string, RepoFile[]>();
  for (const f of kept) {
    const slash = f.path.indexOf("/");
    if (slash < 0) {
      root.push(f);
      continue;
    }
    const d = f.path.slice(0, slash);
    const list = top.get(d);
    if (list) list.push(f);
    else top.set(d, [f]);
  }

  const modules = new Map<string, RepoFile[]>();
  for (const [d, list] of top) {
    for (const [id, mod] of cut(d, list)) {
      const lines = mod.reduce((n, f) => n + f.lines, 0);
      // A small module at the top folds into (root); deeper ones already
      // folded into their parent inside `cut`, unless they were the parent.
      if (lines < MERGE_LINES && parentDir(id) === "") root.push(...mod);
      else modules.set(id, mod);
    }
  }
  const out = [...modules].map(([dir, list]) => build(dir, list));
  if (root.length > 0) out.push(build("", root));
  return out.sort((a, b) => b.lines - a.lines || a.id.localeCompare(b.id));
}
