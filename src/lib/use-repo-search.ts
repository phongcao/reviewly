import { invoke } from "@/lib/tauri";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

/** Trailing debounce — throttles the *network*, which `useDeferredValue` can't. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

// GitHub's search endpoint allows ~30 req/min, so wait for a pause in typing
// and ignore one-character queries.
const DEBOUNCE_MS = 250;
const MIN_QUERY = 2;

export interface RepoSearch {
  /** Local matches first, then the repos only the search API can see. */
  results: string[];
  /** The initial `/user/repos` fetch — the list is empty until it lands. */
  isLoading: boolean;
  /** A typeahead request is in flight; more results may still arrive. */
  isSearching: boolean;
}

/**
 * Repo typeahead backing the pickers. Two sources, merged:
 *
 *  - `gh_list_repos` (`/user/repos`) — fast, cached, filtered client-side, so
 *    typing narrows instantly with no network round-trip.
 *  - `gh_search_repos` (`/search/repositories`) — debounced, and the only way
 *    to reach repos `/user/repos` omits, notably `internal` ones the user can
 *    read through org base permissions rather than a team.
 *
 * Local hits rank first (they're what the user most likely means, and they
 * appear with no latency); search-only hits are appended, deduped.
 */
export function useRepoSearch(query: string, enabled = true): RepoSearch {
  const local = useQuery({
    queryKey: ["repos"],
    queryFn: () => invoke<string[]>("gh_list_repos"),
    enabled,
    staleTime: 5 * 60_000,
  });

  const q = query.trim();
  const debounced = useDebounced(q, DEBOUNCE_MS);
  const searchable = debounced.length >= MIN_QUERY;

  const remote = useQuery({
    queryKey: ["repo-search", debounced],
    queryFn: () => invoke<string[]>("gh_search_repos", { query: debounced }),
    enabled: enabled && searchable,
    staleTime: 60_000,
    // A failed typeahead should quietly show local hits, not retry-storm a
    // rate-limited endpoint.
    retry: false,
  });

  const results = useMemo(() => {
    const all = local.data ?? [];
    if (!q) return all;
    const f = q.toLowerCase();
    const hits = all.filter((r) => r.toLowerCase().includes(f));
    const seen = new Set(hits);
    return [...hits, ...(remote.data ?? []).filter((r) => !seen.has(r))];
  }, [local.data, remote.data, q]);

  return {
    results,
    isLoading: local.isLoading,
    isSearching: searchable && remote.isFetching,
  };
}
