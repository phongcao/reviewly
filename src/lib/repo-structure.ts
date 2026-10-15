import { type Aliases, aliasesFromTsconfig, defaultAliases } from "@/lib/imports";
import type { LayerEdge } from "@/lib/layer-edges";
import { classifyRepoFile } from "@/lib/repo-files";
import { moduleEdges, moduleOrder } from "@/lib/repo-map";
import { type RepoModule, detectModules, skippedTotal } from "@/lib/repo-modules";
import { type FileHead, type FileStat, type RepoInfo, invoke } from "@/lib/tauri";

/** Lines read from the top of each file for its imports — see `read_file_heads`. */
export const HEAD_LINES = 200;
const IMPORT_FILE = /\.(?:[cm]?[jt]sx?|pyi?)$/i;
const MANIFESTS = ["package.json", "Cargo.toml", "pyproject.toml", "go.mod"];

/** Everything the map computes before (and without) any model call. */
export interface RepoStructure {
  head: string;
  dirty: boolean;
  modules: RepoModule[];
  edges: LayerEdge[];
  order: string[][];
  skipped: { files: number; lines: number };
  /** Every file in a module — what an entry point must be one of. */
  paths: string[];
  readme: string | null;
  manifests: { path: string; text: string }[];
}

const tryRead = (root: string, path: string): Promise<string | null> =>
  invoke<string>("read_file", { path, root }).catch(() => null);

/**
 * Compute a repository's structure from its clone: file stats → modules →
 * import links from each file's head → reading order. One `git_file_stats`
 * and one `read_file_heads` call, so a repository of thousands of files
 * maps in a few seconds before any AI call.
 */
export async function computeRepoStructure(root: string): Promise<RepoStructure> {
  const [info, stats] = await Promise.all([
    invoke<RepoInfo>("git_repo_info", { path: root }),
    invoke<FileStat[]>("git_file_stats", { path: root }),
  ]);
  const files = stats.map(classifyRepoFile);
  const modules = detectModules(files);
  const paths = modules.flatMap((m) => m.files);
  const importable = paths.filter((p) => IMPORT_FILE.test(p));
  const heads = await invoke<FileHead[]>("read_file_heads", {
    path: root,
    files: importable,
    maxLines: HEAD_LINES,
  });
  const tracked = stats.map((s) => s.path);
  const tsconfig = tracked.includes("tsconfig.json") ? await tryRead(root, "tsconfig.json") : null;
  const aliases: Aliases = {
    ...defaultAliases(tracked),
    ...(tsconfig ? aliasesFromTsconfig(tsconfig) : {}),
  };
  const edges = moduleEdges(modules, new Map(heads.map((h) => [h.path, h.text])), aliases);
  const readmePath = tracked.find((p) => /^readme(\.(md|markdown|rst|txt))?$/i.test(p));
  const manifests = (
    await Promise.all(
      MANIFESTS.filter((m) => tracked.includes(m)).map(async (path) => ({
        path,
        text: (await tryRead(root, path)) ?? "",
      })),
    )
  ).filter((m) => m.text);
  return {
    head: info.head,
    dirty: info.dirty,
    modules,
    edges,
    order: moduleOrder(modules, edges),
    skipped: skippedTotal(files),
    paths,
    readme: readmePath ? await tryRead(root, readmePath) : null,
    manifests,
  };
}
