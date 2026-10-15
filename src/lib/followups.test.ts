import { buildFollowUpCheckPrompt } from "@/lib/ai/prompts";
import {
  type FollowUp,
  followUpFlags,
  followUpRank,
  hasNewReply,
  latestOtherReply,
  latestOwnReplyAfterOthers,
  myThreads,
  needsCheck,
  parseFollowUpCheck,
  sortFollowUps,
} from "@/lib/followups";
import type { PullFile, ReviewThread, ReviewThreadGraphQL } from "@/lib/tauri";
import { describe, expect, it } from "vitest";

const user = (login: string) => ({ login, avatar_url: "", html_url: "", id: 1 });

const comment = (id: number, login: string, o: Partial<ReviewThread> = {}): ReviewThread => ({
  id,
  pull_request_review_id: null,
  diff_hunk: "@@ -1 +1 @@\n+x",
  path: "src/a.ts",
  commit_id: "head000",
  original_commit_id: "old0000",
  user: user(login),
  body: `comment ${id}`,
  created_at: `2026-10-0${Math.min(id, 9)}T00:00:00Z`,
  updated_at: "",
  html_url: "",
  line: 12,
  original_line: 10,
  side: "RIGHT",
  in_reply_to_id: null,
  ...o,
});

const thread = (
  id: string,
  ids: number[],
  o: Partial<ReviewThreadGraphQL> = {},
): ReviewThreadGraphQL => ({
  id,
  is_resolved: false,
  path: "src/a.ts",
  line: 12,
  original_line: 10,
  comment_ids: ids,
  resolved_by: null,
  is_outdated: false,
  ...o,
});

describe("myThreads", () => {
  const comments = [
    comment(1, "me"),
    comment(2, "author", { in_reply_to_id: 1, body: "fixed" }),
    comment(3, "someone", { path: "src/b.ts" }),
    comment(4, "me", { in_reply_to_id: 3, path: "src/b.ts" }),
  ];
  const threads = [
    thread("T1", [1, 2], { is_resolved: true, resolved_by: "author" }),
    thread("T2", [3, 4], { path: "src/b.ts" }),
  ];

  it("keeps threads the viewer started, not ones they only replied on", () => {
    const fs = myThreads(threads, comments, "me");
    expect(fs.map((f) => f.threadId)).toEqual(["T1"]);
    const f = fs[0];
    expect(f.root.id).toBe(1);
    expect(f.replies.map((r) => r.id)).toEqual([2]);
    expect(f.originalCommit).toBe("old0000");
    expect(f.resolvedBy).toBe("author");
    expect(f.lastCommentId).toBe(2);
    expect(latestOtherReply(f)?.body).toBe("fixed");
  });

  it("finds nothing without a viewer", () => {
    expect(myThreads(threads, comments, undefined)).toEqual([]);
  });
});

describe("needsCheck", () => {
  const base = myThreads([thread("T1", [1])], [comment(1, "me")], "me")[0];

  it("checks after new commits or someone else's reply", () => {
    expect(needsCheck(base, "head000")).toBe(true);
    expect(needsCheck(base, "old0000")).toBe(false);
    const answered: FollowUp = { ...base, replies: [comment(2, "author", { in_reply_to_id: 1 })] };
    expect(needsCheck(answered, "old0000")).toBe(true);
    const selfReply: FollowUp = { ...base, replies: [comment(2, "me", { in_reply_to_id: 1 })] };
    expect(needsCheck(selfReply, "old0000")).toBe(false);
  });
});

/** New-file lines 20-23 changed since the comment; 21 and 22 are added. */
const RANGE = [
  "@@ -20,2 +20,4 @@ fn",
  " const total = 0;",
  "+if (!items) return 0;",
  "+// guard",
  " return total;",
].join("\n");
const changes: PullFile[] = [
  {
    sha: "s",
    filename: "src/a.ts",
    status: "modified",
    additions: 2,
    deletions: 0,
    changes: 2,
    patch: RANGE,
    previous_filename: null,
  },
];

const reply = (o: Record<string, unknown>) =>
  JSON.stringify({
    verdict: "addressed",
    summary: "`items` is guarded.",
    replyClaim: "fixed",
    evidence: [],
    ...o,
  });

describe("parseFollowUpCheck", () => {
  it("keeps an addressed verdict backed by a changed line", () => {
    const r = parseFollowUpCheck(
      reply({ evidence: [{ path: "src/a.ts", line: 21, note: "adds the guard" }] }),
      changes,
    );
    expect(r.verdict).toBe("addressed");
    expect(r.evidence[0].grade).toBe("exact");
    expect(r.downgraded).toBeUndefined();
  });

  it("downgrades addressed with no cite, or a cite outside the changes", () => {
    expect(parseFollowUpCheck(reply({}), changes)).toMatchObject({ verdict: "unclear" });
    const out = parseFollowUpCheck(reply({ evidence: [{ path: "src/a.ts", line: 90 }] }), changes);
    expect(out.verdict).toBe("unclear");
    expect(out.downgraded).toMatch(/none of its cited lines/);
    expect(out.evidence[0].grade).toBe("heuristic");
  });

  it("never turns junk into addressed", () => {
    expect(parseFollowUpCheck(reply({ verdict: "looks good" }), changes).verdict).toBe("unclear");
    const r = parseFollowUpCheck("I could not decide.", changes);
    expect(r).toMatchObject({ verdict: "unclear", unparsed: true });
  });

  it("reads a fenced, chatty reply", () => {
    const out = `Here you go:\n\`\`\`json\n${reply({ verdict: "not_addressed", followUp: "Still no guard." })}\n\`\`\``;
    const r = parseFollowUpCheck(out, changes);
    expect(r.verdict).toBe("not_addressed");
    expect(r.followUp).toBe("Still no guard.");
  });

  it("drops a suggested reply on a verdict that needs none", () => {
    const r = parseFollowUpCheck(reply({ verdict: "declined", followUp: "x" }), changes);
    expect(r.verdict).toBe("declined");
    expect(r.followUp).toBeUndefined();
  });
});

describe("followUpFlags", () => {
  it("flags resolved-but-open and a reply that claims a fix the code lacks", () => {
    expect(
      followUpFlags({ verdict: "not_addressed", replyClaim: "fixed" }, { resolved: true }),
    ).toEqual({
      resolvedNotAddressed: true,
      replyClaimMismatch: true,
    });
    expect(
      followUpFlags({ verdict: "addressed", replyClaim: "fixed" }, { resolved: true }),
    ).toEqual({
      resolvedNotAddressed: false,
      replyClaimMismatch: false,
    });
    // Unclear is not evidence of a mismatch.
    expect(
      followUpFlags({ verdict: "unclear", replyClaim: "fixed" }, { resolved: false })
        .replyClaimMismatch,
    ).toBe(false);
  });
});

describe("buildFollowUpCheckPrompt", () => {
  const input = {
    path: "src/a.ts",
    originalLine: 10,
    originalCommit: "old0000aaa",
    reviewer: "me",
    comment: "Guard against a null `items`.",
    diffHunk: "@@ -1 +1 @@\n+x",
    replies: [{ author: "author", body: "fixed" }],
    prAuthor: "author",
    resolved: true,
    resolvedBy: "author",
    outdated: false,
    patch: RANGE,
    basis: "since-comment" as const,
    otherFiles: ["src/b.ts (+1 −0)"],
    clone: false,
    custom: "",
  };

  it("carries the comment, replies, thread state and verdict list", () => {
    const p = buildFollowUpCheckPrompt(input);
    expect(p).toContain("Guard against a null `items`.");
    expect(p).toContain("@author (PR author): fixed");
    expect(p).toContain("resolved by @author");
    expect(p).toContain("src/b.ts (+1 −0)");
    expect(p).toContain('"verdict":"addressed"|"partial"|"not_addressed"|"declined"|"unclear"');
    expect(p).toContain("is NOT evidence");
    expect(p).toContain("There is NO checkout");
  });

  it("says when it can read a clone, or only has the whole PR", () => {
    const p = buildFollowUpCheckPrompt({ ...input, clone: true, basis: "whole-pr", patch: null });
    expect(p).toContain("local checkout");
    expect(p).not.toContain("There is NO checkout");
    expect(p).toContain("could not compare");
    expect(p).toContain("This file has not changed since the comment.");
  });
});

describe("followUpRank / sortFollowUps", () => {
  const r = (verdict: "addressed" | "partial" | "not_addressed" | "declined" | "unclear") => ({
    verdict,
    replyClaim: "none" as const,
  });

  it("puts open work first and resolved or addressed threads last", () => {
    expect(followUpRank({ resolved: false }, r("not_addressed"))).toBe(0);
    expect(followUpRank({ resolved: false }, r("partial"))).toBe(0);
    expect(followUpRank({ resolved: false }, r("unclear"))).toBe(1);
    expect(followUpRank({ resolved: false }, null)).toBe(2);
    expect(followUpRank({ resolved: false }, r("addressed"))).toBe(3);
    expect(followUpRank({ resolved: true }, r("addressed"))).toBe(4);
    expect(followUpRank({ resolved: true }, null)).toBe(4);
  });

  it("keeps a resolved thread the code doesn't back up at the top", () => {
    expect(followUpRank({ resolved: true }, r("not_addressed"))).toBe(0);
    expect(followUpRank({ resolved: false }, { verdict: "declined", replyClaim: "fixed" })).toBe(0);
  });

  it("sorts by rank and keeps file order within a rank", () => {
    const items = [
      { id: "a", resolved: true },
      { id: "b", resolved: false },
      { id: "c", resolved: false },
      { id: "d", resolved: false },
    ];
    const verdicts: Record<string, ReturnType<typeof r> | null> = {
      a: r("addressed"),
      b: r("addressed"),
      c: null,
      d: r("not_addressed"),
    };
    expect(sortFollowUps(items, (f) => verdicts[f.id]).map((x) => x.f.id)).toEqual([
      "d",
      "c",
      "b",
      "a",
    ]);
  });
});

describe("stale follow-ups", () => {
  it("only counts replies from someone other than the reviewer", () => {
    const f = { root: comment(1, "me"), replies: [comment(2, "author"), comment(3, "me")] };
    expect(hasNewReply(f, 1)).toBe(true);
    expect(hasNewReply(f, 2)).toBe(false);
  });

  it("lifts a stale addressed or resolved thread above the done group", () => {
    const addressed = { verdict: "addressed" as const, replyClaim: "none" as const };
    expect(followUpRank({ resolved: false }, addressed, true)).toBe(1);
    expect(followUpRank({ resolved: true }, addressed, true)).toBe(1);
    // Already at the top: a new reply doesn't demote it.
    expect(
      followUpRank({ resolved: false }, { verdict: "not_addressed", replyClaim: "none" }, true),
    ).toBe(0);
  });
});

describe("threads the reviewer resolved", () => {
  const me = comment(1, "me");
  const notAddressed = { verdict: "not_addressed" as const, replyClaim: "none" as const };

  it("treats a self-resolved thread as settled, without the resolved-not-fixed warning", () => {
    const f = { resolved: true, resolvedBy: "me", root: me };
    expect(followUpFlags(notAddressed, f).resolvedNotAddressed).toBe(false);
    expect(followUpRank(f, notAddressed)).toBe(4);
    expect(followUpRank(f, null)).toBe(4);
    // A later reply from someone else still brings it back up.
    expect(followUpRank(f, notAddressed, true)).toBe(1);
  });

  it("still warns when someone else, or an unknown user, resolved it", () => {
    for (const resolvedBy of ["author", null]) {
      const f = { resolved: true, resolvedBy, root: me };
      expect(followUpFlags(notAddressed, f).resolvedNotAddressed).toBe(true);
      expect(followUpRank(f, notAddressed)).toBe(0);
    }
  });

  it("previews the reviewer's own reply only when it is the newest", () => {
    const base = { root: me, replies: [comment(2, "author"), comment(3, "me")] } as FollowUp;
    expect(latestOwnReplyAfterOthers(base)?.id).toBe(3);
    const answered = { ...base, replies: [comment(3, "me"), comment(4, "author")] } as FollowUp;
    expect(latestOwnReplyAfterOthers(answered)).toBeNull();
  });
});
