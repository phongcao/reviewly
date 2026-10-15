/**
 * Follow-up on the viewer's own review comments: after new pushes, was each
 * one actually addressed?
 *
 * GitHub is the memory — every review comment records the commit it was made
 * on (`original_commit_id`), the code it was left on (`diff_hunk`), and its
 * replies. Nothing about the comments is stored locally; only the check result.
 *
 * The check is a model, so it is held to the rule the tour checks follow:
 * ambiguity falls toward LESS trust. A reply that says "fixed" is not
 * evidence — only changed code is — so an "addressed" verdict with no cited
 * line inside the changes since the comment is downgraded to "unclear".
 *
 * An author may instead defer the fix to a later PR and say so ("tracking
 * here: #175"). The check reads that issue: "deferred" needs an issue it
 * actually read and that asks for the work, not just a reply that names one.
 */
import { extractObjects, stripFence, toArray, toInt } from "@/lib/ai/json";
import { type Evidence, prCorpus, verifyClaim } from "@/lib/ai/verify";
import type { IssueSummary, PullFile, ReviewThread, ReviewThreadGraphQL } from "@/lib/tauri";

export type FollowUpVerdict =
  | "addressed"
  | "partial"
  | "not_addressed"
  | "declined"
  | "deferred"
  | "unclear";

/** What the latest reply from someone other than the reviewer says it did. */
export type ReplyClaim = "fixed" | "declined" | "deferred" | "question" | "none";

/** One thread the viewer started, with everything the check needs. */
export interface FollowUp {
  threadId: string;
  path: string;
  /** New-file line at the current head; null once the line is gone (outdated). */
  line: number | null;
  originalLine: number | null;
  /** The commit the comment was made on. */
  originalCommit: string | null;
  diffHunk: string | null;
  root: ReviewThread;
  /** Later comments in the thread, oldest first (the viewer's own included). */
  replies: ReviewThread[];
  resolved: boolean;
  resolvedBy: string | null;
  outdated: boolean;
  /** Newest comment id — a newer one makes a stored check stale. */
  lastCommentId: number;
}

/**
 * Threads the viewer started, in file order. A thread is the viewer's when its
 * first comment is — replying on someone else's thread doesn't make it theirs.
 */
export function myThreads(
  threads: ReviewThreadGraphQL[],
  comments: ReviewThread[],
  viewerLogin: string | null | undefined,
): FollowUp[] {
  if (!viewerLogin) return [];
  const byId = new Map(comments.map((c) => [c.id, c]));
  const out: FollowUp[] = [];
  for (const t of threads) {
    const cs = t.comment_ids
      .map((id) => byId.get(id))
      .filter((c): c is ReviewThread => !!c)
      .sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at));
    const root = cs.find((c) => c.in_reply_to_id == null) ?? cs[0];
    if (!root || root.user.login !== viewerLogin) continue;
    out.push({
      threadId: t.id,
      path: t.path,
      line: t.line,
      originalLine: t.original_line ?? root.original_line,
      originalCommit: root.original_commit_id ?? null,
      diffHunk: root.diff_hunk,
      root,
      replies: cs.filter((c) => c !== root),
      resolved: t.is_resolved,
      resolvedBy: t.resolved_by ?? null,
      outdated: t.is_outdated ?? false,
      lastCommentId: Math.max(...cs.map((c) => c.id)),
    });
  }
  return out.sort(
    (a, b) => a.path.localeCompare(b.path) || (a.originalLine ?? 0) - (b.originalLine ?? 0),
  );
}

/**
 * Whether there is anything to check: new commits since the comment, or a
 * reply from someone else (which may decline the comment with no code change).
 */
export function needsCheck(f: FollowUp, headSha: string | null | undefined): boolean {
  const moved = !!headSha && !!f.originalCommit && f.originalCommit !== headSha;
  const answered = f.replies.some((r) => r.user.login !== f.root.user.login);
  return moved || answered;
}

/**
 * Whether someone other than the reviewer replied after the comment a check
 * last saw. The reviewer's own replies (e.g. posting the suggested follow-up)
 * don't make a check stale: they can't change what the author did.
 */
export function hasNewReply(
  f: Pick<FollowUp, "root" | "replies">,
  checkedCommentId: number,
): boolean {
  return f.replies.some((r) => r.id > checkedCommentId && r.user.login !== f.root.user.login);
}

/** The latest reply from someone other than the reviewer. */
export function latestOtherReply(f: FollowUp): ReviewThread | null {
  for (let i = f.replies.length - 1; i >= 0; i--) {
    if (f.replies[i].user.login !== f.root.user.login) return f.replies[i];
  }
  return null;
}

/**
 * The reviewer's own latest reply, when it's newer than any reply from someone
 * else — a note like "parking lot for a future PR" that settles the thread.
 */
export function latestOwnReplyAfterOthers(f: FollowUp): ReviewThread | null {
  const last = f.replies[f.replies.length - 1];
  return last && last.user.login === f.root.user.login ? last : null;
}

/** An issue or PR a reply points to, e.g. "tracking here: #175". */
export interface IssueRef {
  owner: string;
  repo: string;
  number: number;
}

/** A linked issue as the check read it. */
export interface LinkedIssue extends IssueRef {
  /** How the prompt names it: `#175` in this repo, `owner/repo#175` elsewhere. */
  ref: string;
  /** Null when it could not be read (no access, deleted, not found). */
  issue: IssueSummary | null;
}

/** The issue a "deferred" verdict rests on. */
export interface Tracking {
  ref: string;
  title: string;
  /** `open` or `closed`, when checked. */
  state: string;
  stateReason: string | null;
  isPull: boolean;
  url: string;
  /** The issue asks for all of what the comment asked, or only part of it. */
  covers: "all" | "part";
}

/** Most linked issues one check reads. */
export const MAX_LINKED_ISSUES = 3;

const ISSUE_URL = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)/g;
// `#175` or `owner/repo#175`, not an HTML entity (`&#39;`) or a URL fragment.
const SHORT_REF = /(?<![\w&/#])(?:([\w.-]+)\/([\w.-]+))?#(\d+)\b/g;

const sameRepo = (a: { owner: string; repo: string }, b: { owner: string; repo: string }) =>
  a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();

/** `#175` in the PR's repo, `owner/repo#175` elsewhere. */
export const issueRefLabel = (r: IssueRef, here: { owner: string; repo: string }): string =>
  sameRepo(r, here) ? `#${r.number}` : `${r.owner}/${r.repo}#${r.number}`;

/**
 * Issues and PRs the thread's replies link to, newest reply first, without the
 * PR itself. Code spans are skipped: `#3` in code is not a reference.
 */
export function linkedIssueRefs(
  f: Pick<FollowUp, "replies">,
  here: { owner: string; repo: string; number: number },
): IssueRef[] {
  const out: IssueRef[] = [];
  const add = (owner: string, repo: string, n: string) => {
    const r = { owner, repo, number: Number(n) };
    if (r.number < 1 || (sameRepo(r, here) && r.number === here.number)) return;
    if (out.some((o) => o.number === r.number && sameRepo(o, r))) return;
    out.push(r);
  };
  for (let i = f.replies.length - 1; i >= 0; i--) {
    let text = f.replies[i].body.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
    for (const m of text.matchAll(ISSUE_URL)) add(m[1], m[2], m[3]);
    text = text.replace(ISSUE_URL, " ");
    for (const m of text.matchAll(SHORT_REF)) {
      add(m[1] ?? here.owner, m[2] ?? here.repo, m[3]);
    }
  }
  return out.slice(0, MAX_LINKED_ISSUES);
}

/** The linked issue the checker named, read or not. */
function findIssue(name: string, issues: LinkedIssue[]): LinkedIssue | undefined {
  const url = [...name.matchAll(ISSUE_URL)][0];
  if (url) {
    const r = { owner: url[1], repo: url[2] };
    return issues.find((i) => i.number === Number(url[3]) && sameRepo(i, r));
  }
  const m = name.match(/(?:([\w.-]+)\/([\w.-]+))?#?(\d+)\s*$/);
  if (!m) return undefined;
  const r = m[1] && m[2] ? { owner: m[1], repo: m[2] } : null;
  const hits = issues.filter((i) => i.number === Number(m[3]) && (!r || sameRepo(i, r)));
  // A bare number is only safe when one linked issue has it.
  return hits.length === 1 ? hits[0] : undefined;
}

/** One cited line range that shows the fix. */
export interface FollowUpEvidence {
  path: string;
  line: number;
  endLine?: number;
  note: string;
  /** Graded against the changes since the comment: `exact` = touches a changed
   * line, `strong` = inside a changed hunk, `heuristic` = outside every one. */
  grade: Evidence;
}

export interface FollowUpResult {
  verdict: FollowUpVerdict;
  summary: string;
  replyClaim: ReplyClaim;
  evidence: FollowUpEvidence[];
  /** A ready-to-post reply, when the comment is not (fully) addressed, or the
   * issue it was deferred to leaves part of it out. */
  followUp?: string;
  /** For "deferred": the issue that tracks the work. */
  tracking?: Tracking;
  /** Set when the parser overrode the checker's verdict, and why. */
  downgraded?: string;
  /** The reply held no readable JSON at all. */
  unparsed?: boolean;
}

const VERDICTS = new Set<FollowUpVerdict>([
  "addressed",
  "partial",
  "not_addressed",
  "declined",
  "deferred",
  "unclear",
]);
const CLAIMS = new Set<ReplyClaim>(["fixed", "declined", "deferred", "question", "none"]);

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * Parse the checker's reply. `changes` are the files changed since the
 * comment — what a cited fix is held against. `issues` are the linked issues
 * the check was shown — what a deferral is held against.
 */
export function parseFollowUpCheck(
  out: string,
  changes: PullFile[],
  issues: LinkedIssue[] = [],
): FollowUpResult {
  const obj = extractObjects(stripFence(out)).find(
    (o): o is Record<string, unknown> => !!o && typeof o === "object" && "verdict" in o,
  );
  if (!obj) {
    return {
      verdict: "unclear",
      summary: out.trim().slice(0, 500),
      replyClaim: "none",
      evidence: [],
      unparsed: true,
    };
  }
  const rawVerdict = str(obj.verdict) as FollowUpVerdict;
  let verdict: FollowUpVerdict = VERDICTS.has(rawVerdict) ? rawVerdict : "unclear";
  const replyClaim = CLAIMS.has(str(obj.replyClaim) as ReplyClaim)
    ? (str(obj.replyClaim) as ReplyClaim)
    : "none";

  const corpus = prCorpus(changes);
  const evidence: FollowUpEvidence[] = [];
  for (const e of toArray(obj.evidence)) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const path = str(o.path);
    const line = toInt(o.line);
    if (!path || line == null || line < 1) continue;
    const end = toInt(o.endLine);
    const endLine = end != null && end >= line ? end : undefined;
    const note = str(o.note);
    // Only the location is graded — the note is prose about the fix, and its
    // names may legitimately live in the unchanged code around it.
    const { grade } = verifyClaim({ path, line, endLine, text: "" }, changes, corpus);
    evidence.push({ path, line, endLine, note, grade });
  }

  let downgraded: string | undefined;
  if (
    (verdict === "addressed" || verdict === "partial") &&
    !evidence.some((e) => e.grade === "exact" || e.grade === "strong")
  ) {
    downgraded =
      evidence.length === 0
        ? `The checker said "${verdict}" but cited no line that shows the fix.`
        : `The checker said "${verdict}" but none of its cited lines are in the changes since the comment.`;
    verdict = "unclear";
  }

  let tracking: Tracking | undefined;
  if (verdict === "deferred") {
    const t = obj.tracking && typeof obj.tracking === "object" ? obj.tracking : {};
    const named = str((t as Record<string, unknown>).issue);
    const hit = named ? findIssue(named, issues) : undefined;
    if (hit?.issue) {
      const i = hit.issue;
      tracking = {
        ref: hit.ref,
        title: i.title,
        state: i.state,
        stateReason: i.state_reason ?? null,
        isPull: i.pull_request != null,
        url: i.html_url,
        covers: str((t as Record<string, unknown>).covers) === "all" ? "all" : "part",
      };
    } else {
      downgraded =
        issues.length === 0
          ? 'The checker said "deferred" but no reply links an issue.'
          : hit
            ? `The checker said "deferred" but ${hit.ref} could not be read.`
            : 'The checker said "deferred" but did not name a linked issue that tracks it.';
      verdict = "unclear";
    }
  }

  const followUp = str(obj.followUp);
  const wantsReply =
    verdict === "not_addressed" || verdict === "partial" || tracking?.covers === "part";
  return {
    verdict,
    summary: str(obj.summary),
    replyClaim,
    evidence,
    ...(followUp && wantsReply ? { followUp } : {}),
    ...(tracking ? { tracking } : {}),
    ...(downgraded ? { downgraded } : {}),
  };
}

/** Resolve state of a thread; `resolvedBy` and `root` tell who settled it. */
type ResolveState = Pick<FollowUp, "resolved"> & Partial<Pick<FollowUp, "resolvedBy" | "root">>;

/**
 * The reviewer resolved their own thread: they've accepted where it landed
 * (fixed, deferred, or dropped), whatever the code says. Unknown resolver
 * counts as someone else, so the warning errs toward showing.
 */
export function resolvedByReviewer(f: ResolveState): boolean {
  return f.resolved && !!f.resolvedBy && f.resolvedBy === f.root?.user.login;
}

/** Mismatches worth a warning, computed from the result and the thread as it
 * is NOW (resolve state can change after the check). */
export function followUpFlags(
  r: Pick<FollowUpResult, "verdict" | "replyClaim">,
  f: ResolveState,
): { resolvedNotAddressed: boolean; replyClaimMismatch: boolean } {
  const open = r.verdict === "not_addressed" || r.verdict === "partial";
  return {
    // Meant to catch the author closing a thread without fixing it.
    resolvedNotAddressed: f.resolved && open && !resolvedByReviewer(f),
    replyClaimMismatch:
      r.replyClaim === "fixed" && r.verdict !== "addressed" && r.verdict !== "unclear",
  };
}

/**
 * Where a thread sits in the "Your comments" list — what still needs the
 * reviewer first, what's done last:
 *  0. open in the code (not addressed / partly), or a resolve or reply that
 *     the code doesn't back up;
 *  1. needs a judgment call (unclear, declined, or deferred to an issue that
 *     is closed or covers only part of it) — even once resolved, until the
 *     reviewer resolves it themselves — or a reply arrived after the check,
 *     so its verdict may be out of date;
 *  2. unresolved and not checked yet;
 *  3. addressed, or deferred to an open issue that covers all of it, not yet
 *     resolved;
 *  4. resolved (and not contradicted by a check), or resolved by the reviewer.
 */
export function followUpRank(
  f: ResolveState,
  r: Pick<FollowUpResult, "verdict" | "replyClaim" | "tracking"> | null,
  stale = false,
): number {
  if (resolvedByReviewer(f)) return stale ? 1 : 4;
  if (!r) return f.resolved ? 4 : 2;
  const flags = followUpFlags(r, f);
  if (r.verdict === "not_addressed" || r.verdict === "partial" || flags.replyClaimMismatch) {
    return 0;
  }
  if (stale) return 1;
  // A judgment call stays in view when someone else resolves the thread: the
  // author closing it doesn't mean the reviewer accepted the reason. The
  // reviewer resolving it themselves is handled above.
  if (r.verdict === "deferred") {
    const tracked = r.tracking?.state === "open" && r.tracking.covers === "all";
    return tracked ? (f.resolved ? 4 : 3) : 1;
  }
  if (r.verdict === "unclear" || r.verdict === "declined") return 1;
  return f.resolved ? 4 : 3;
}

/** The rank from which a thread counts as done — nothing left to look at. */
export const DONE_RANK = 3;

/** Threads ordered by `followUpRank`, file order kept within a rank. */
export function sortFollowUps<T extends ResolveState>(
  items: T[],
  recordOf: (f: T) => Pick<FollowUpResult, "verdict" | "replyClaim" | "tracking"> | null,
  isStale: (f: T) => boolean = () => false,
): { f: T; rank: number }[] {
  return items
    .map((f, i) => ({ f, i, rank: followUpRank(f, recordOf(f), isStale(f)) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map(({ f, rank }) => ({ f, rank }));
}
