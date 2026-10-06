import { LOOKUP_CONCURRENCY, nameInClone, pool } from "@/lib/ai/name-lookup";
import type { StepEvidence } from "@/lib/ai/verify";
import { identifiersToLookUp, verifyRepoStep } from "@/lib/ai/verify-repo";
import type { GuidedStep } from "@/lib/guided";
import { invoke } from "@/lib/tauri";
import { useEffect, useMemo, useState } from "react";

/**
 * In-memory caches, per commit. Deterministic for a given `headSha`, so they
 * never need persisting and never go stale: a new head is a new key.
 */
const tracked = new Map<string, Promise<ReadonlySet<string>>>();
const fileTexts = new Map<string, Promise<string | null>>();

const at = (repoPath: string, headSha: string, rest: string) => `${repoPath}@${headSha}|${rest}`;

function trackedPaths(repoPath: string, headSha: string): Promise<ReadonlySet<string>> {
  const k = at(repoPath, headSha, "");
  let p = tracked.get(k);
  if (!p) {
    p = invoke<string[]>("git_ls_files", { path: repoPath })
      .then((paths) => new Set(paths))
      .catch(() => new Set<string>());
    tracked.set(k, p);
  }
  return p;
}

function fileText(repoPath: string, headSha: string, path: string): Promise<string | null> {
  const k = at(repoPath, headSha, `file:${path}`);
  let p = fileTexts.get(k);
  if (!p) {
    p = invoke<string>("read_file", { path: `${repoPath}/${path}` }).catch(() => null);
    fileTexts.set(k, p);
  }
  return p;
}

/**
 * Evidence grades for codebase-tour stops at `headSha`. `null` per stop while
 * its lookups are running — the UI shows "checking…". Reads each anchored
 * file once, then looks up (4 at a time) the cited identifiers those files
 * don't contain, and grades with `verifyRepoStep`.
 */
export function useRepoEvidence(
  repoPath: string | null,
  headSha: string,
  steps: GuidedStep[],
): (StepEvidence | null)[] {
  const [grades, setGrades] = useState<(StepEvidence | null)[]>(() => steps.map(() => null));
  useEffect(() => {
    setGrades(steps.map(() => null));
    if (!repoPath || steps.length === 0) return;
    let cancelled = false;
    (async () => {
      const paths = await trackedPaths(repoPath, headSha);
      const anchored = [...new Set(steps.map((s) => s.path))].filter((p) => paths.has(p));
      const texts = new Map<string, string | null>();
      await pool(anchored, 8, async (p) => texts.set(p, await fileText(repoPath, headSha, p)));
      const ids = [
        ...new Set(steps.flatMap((s) => identifiersToLookUp(s, texts.get(s.path) ?? null))),
      ];
      const known = new Set<string>();
      await pool(ids, LOOKUP_CONCURRENCY, async (id) => {
        if (await nameInClone(repoPath, headSha, id)) known.add(id);
      });
      if (cancelled) return;
      setGrades(
        steps.map((s) =>
          verifyRepoStep(s, {
            trackedPaths: paths,
            fileText: texts.get(s.path) ?? null,
            knownIdentifiers: known,
          }),
        ),
      );
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [repoPath, headSha, steps]);
  return useMemo(() => grades, [grades]);
}
