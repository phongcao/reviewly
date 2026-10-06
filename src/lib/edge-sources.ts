import { type Aliases, aliasesFromTsconfig, defaultAliases } from "@/lib/imports";
import { patchText } from "@/lib/layer-edges";
import type { PullFile } from "@/lib/tauri";
import { invoke } from "@/lib/tauri";

/** Where a set of edges was read from — the UI says which, because the two
 * fail differently: a clone may sit at another commit, a diff misses every
 * import the PR didn't touch. */
export type EdgeSource = "clone" | "diff";

export interface EdgeTexts {
  texts: Map<string, string>;
  source: EdgeSource;
  aliases: Aliases;
}

/** Reads at a time — `read_file` is cheap, but a 300-file PR shouldn't open
 * 300 at once. */
const READ_CONCURRENCY = 8;

/**
 * The text each changed file's imports are read from. With a clone, the
 * file on disk (and `tsconfig.json`'s path aliases); without one — or for a
 * file the clone can't give us, such as one the PR deletes — the patch's
 * context and added lines.
 */
export async function loadEdgeTexts(files: PullFile[], cwd: string | null): Promise<EdgeTexts> {
  const fromPatch = () => new Map(files.map((f) => [f.filename, patchText(f.patch)]));
  const known = files.map((f) => f.filename);
  if (!cwd) return { texts: fromPatch(), source: "diff", aliases: defaultAliases(known) };

  const texts = fromPatch();
  const queue = [...files];
  const worker = async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const file = f;
      await invoke<string>("read_file", { path: `${cwd}/${file.filename}` })
        .then((t) => texts.set(file.filename, t))
        .catch(() => {});
    }
  };
  await Promise.all(Array.from({ length: READ_CONCURRENCY }, worker));
  const tsconfig = await invoke<string>("read_file", { path: `${cwd}/tsconfig.json` }).catch(
    () => "",
  );
  const fromConfig = tsconfig ? aliasesFromTsconfig(tsconfig) : {};
  return {
    texts,
    source: "clone",
    aliases: { ...defaultAliases(known), ...fromConfig },
  };
}
