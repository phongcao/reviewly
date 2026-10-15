import { invoke } from "@/lib/tauri";
import { useEffect, useState } from "react";

/** Lookups at a time — each is a `git grep` process. */
export const LOOKUP_CONCURRENCY = 4;
/** Hits per lookup. `git_grep` matches case-insensitively, so the first hit
 * can be a different-case name; a few hits let us find an exact one. */
const LOOKUP_HITS = 20;

/** In-memory, per clone and commit: the answer can't change for a given
 * `headSha`, so it never needs persisting and never goes stale. */
const found = new Map<string, Promise<boolean>>();

/** Whether `name` appears, case-sensitively, in a tracked file of the clone. */
export function nameInClone(repoPath: string, headSha: string, name: string): Promise<boolean> {
  const k = `${repoPath}@${headSha}|${name}`;
  let p = found.get(k);
  if (!p) {
    p = invoke<{ text: string }[]>("git_grep", { path: repoPath, query: name, limit: LOOKUP_HITS })
      .then((hits) => hits.some((h) => h.text.includes(name)))
      // A failed lookup proves nothing either way; "not found" is the less
      // trusting reading, and it only ever withholds an upgrade.
      .catch(() => false);
    found.set(k, p);
  }
  return p;
}

/** Run `fn` over `items`, at most `n` at a time. */
export async function pool<T>(
  items: T[],
  n: number,
  fn: (t: T) => Promise<unknown>,
): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (let t = queue.shift(); t !== undefined; t = queue.shift()) await fn(t);
    }),
  );
}

const EMPTY: ReadonlySet<string> = new Set();

/**
 * Which of `names` exist in the local clone. Empty while looking up, and
 * always empty without a clone. `names` should be a stable, sorted list (see
 * `namesToLookUp`); it is compared by content, so a new array with the same
 * names doesn't restart the lookup.
 */
export function useNamesInClone(
  repoPath: string | null,
  headSha: string,
  names: string[],
): ReadonlySet<string> {
  const key = names.join("\u0000");
  const [result, setResult] = useState<ReadonlySet<string>>(EMPTY);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `names`
  useEffect(() => {
    if (!repoPath || names.length === 0) {
      setResult(EMPTY);
      return;
    }
    let cancelled = false;
    const hits = new Set<string>();
    pool(names, LOOKUP_CONCURRENCY, async (n) => {
      if (await nameInClone(repoPath, headSha, n)) hits.add(n);
    }).then(() => {
      if (!cancelled) setResult(hits.size > 0 ? hits : EMPTY);
    });
    return () => {
      cancelled = true;
    };
  }, [repoPath, headSha, key]);
  return result;
}
