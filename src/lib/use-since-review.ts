import {
  type SinceReview,
  lastReview,
  lastReviewedSha,
  needsOldPrFiles,
  sinceReview,
} from "@/lib/since-review";
import type { CompareResult, PullFile, Review } from "@/lib/tauri";
import { invoke } from "@/lib/tauri";
import { useViewedFiles, viewedKey } from "@/stores/viewed-files";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

/** A comparison of two commits never changes, so it is cached for good. */
export function compareQuery(
  owner: string,
  repo: string,
  base: string | null,
  head: string | null,
) {
  return {
    queryKey: ["pull-compare", owner, repo, base, head] as const,
    queryFn: () => invoke<CompareResult | null>("gh_compare_commits", { owner, repo, base, head }),
    enabled: !!base && !!head && base !== head,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  };
}

/**
 * What changed since the viewer's last review of this PR. Also carries the
 * viewer's "viewed" marks from the reviewed head to the current one for every
 * file the new commits didn't touch.
 */
export function useSinceReview(o: {
  owner: string;
  repo: string;
  number: number;
  headSha: string | null | undefined;
  prBaseSha: string | null | undefined;
  prFiles: PullFile[];
  reviews: Review[] | undefined;
  viewerLogin: string | null | undefined;
}): { state: SinceReview; review: Review | null } {
  const { owner, repo, number, headSha, prBaseSha, prFiles, reviews, viewerLogin } = o;
  const baseSha = useMemo(
    () => lastReviewedSha(reviews ?? [], viewerLogin),
    [reviews, viewerLogin],
  );
  const review = useMemo(() => lastReview(reviews ?? [], viewerLogin), [reviews, viewerLogin]);

  const range = useQuery(compareQuery(owner, repo, baseSha, headSha ?? null));
  // After a force-push: the PR's own changes as they were at the reviewed head.
  const rewritten = needsOldPrFiles(range.data);
  const old = useQuery({
    ...compareQuery(owner, repo, prBaseSha ?? null, baseSha),
    enabled: rewritten && !!prBaseSha && !!baseSha,
  });

  const state = useMemo<SinceReview>(() => {
    if (baseSha && (range.isError || (rewritten && old.isError))) {
      return { mode: "unavailable", baseSha, reason: "error" };
    }
    return sinceReview({
      baseSha,
      headSha,
      prFiles,
      range: range.data,
      oldPrFiles: rewritten ? old.data : undefined,
    });
  }, [baseSha, headSha, prFiles, range.data, range.isError, rewritten, old.data, old.isError]);

  const carryForward = useViewedFiles((s) => s.carryForward);
  useEffect(() => {
    if (!headSha || (state.mode !== "incremental" && state.mode !== "rebased")) return;
    const changed = state.changed;
    carryForward(
      viewedKey(owner, repo, number, state.baseSha),
      viewedKey(owner, repo, number, headSha),
      (path) => !changed.has(path),
    );
  }, [state, headSha, owner, repo, number, carryForward]);

  return { state, review };
}
