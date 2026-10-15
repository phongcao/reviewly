import { addToPendingReview, canAnchor, isCommentableLine } from "@/lib/review-draft-bridge";
import type { PullFile } from "@/lib/tauri";
import { useReviewDraft } from "@/stores/review-draft";
import { beforeEach, describe, expect, it } from "vitest";

const pr = { owner: "o", repo: "r", number: 1 };
const files = [
  { filename: "a.ts", patch: "@@ -1,2 +1,3 @@\n line1\n+added\n line2" },
] as PullFile[];
const draft = () => useReviewDraft.getState().get(pr);

beforeEach(() => useReviewDraft.setState({ drafts: {} }));

describe("isCommentableLine", () => {
  it("accepts only new-file lines inside the diff", () => {
    expect(isCommentableLine(files, "a.ts", 2)).toBe(true);
    expect(isCommentableLine(files, "a.ts", 40)).toBe(false);
    expect(isCommentableLine(files, "b.ts", 2)).toBe(false);
  });
});

describe("addToPendingReview", () => {
  it("adds a pending inline comment for a line in the diff", async () => {
    const where = await addToPendingReview(pr, files, {
      path: "a.ts",
      line: 2,
      side: "RIGHT",
      body: "nit",
    });
    expect(where).toBe("comment");
    expect(draft().comments).toMatchObject([{ path: "a.ts", line: 2, side: "RIGHT", body: "nit" }]);
    expect(draft().body).toBe("");
  });

  it("appends an off-diff line to the review body instead", async () => {
    useReviewDraft.getState().setBody(pr, "Summary");
    const where = await addToPendingReview(pr, files, {
      path: "a.ts",
      line: 40,
      side: "RIGHT",
      body: "nit",
    });
    expect(where).toBe("body");
    expect(draft().comments).toEqual([]);
    expect(draft().body).toBe("Summary\n\n**a.ts:40**\n\nnit");
  });
});

describe("canAnchor", () => {
  const renamed = [
    ...files,
    { filename: "moved.json", status: "renamed", patch: undefined },
  ] as unknown as PullFile[];

  it("rejects a line in a renamed-only file (no patch)", () => {
    expect(canAnchor(renamed, { path: "moved.json", line: 2, side: "RIGHT", body: "x" })).toBe(
      false,
    );
  });

  it("checks LEFT comments against old-file lines", () => {
    // Old line 2 is the context line "line2"; old line 3 doesn't exist.
    expect(canAnchor(files, { path: "a.ts", line: 2, side: "LEFT", body: "x" })).toBe(true);
    expect(canAnchor(files, { path: "a.ts", line: 3, side: "LEFT", body: "x" })).toBe(false);
  });

  it("gives files that aren't loaded the benefit of the doubt", () => {
    expect(canAnchor([], { path: "a.ts", line: 99, side: "RIGHT", body: "x" })).toBe(true);
  });
});
