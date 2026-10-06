import { toSubmittable, useReviewDraft } from "@/stores/review-draft";
import { beforeEach, describe, expect, it } from "vitest";

const pr = { owner: "o", repo: "r", number: 1 };
const comments = () => useReviewDraft.getState().get(pr).comments;

beforeEach(() => useReviewDraft.setState({ drafts: {} }));

describe("pending comments", () => {
  it("get an id on add, and edit/remove by it", () => {
    const s = useReviewDraft.getState();
    s.addComment(pr, { path: "a.ts", body: "one", line: 1, side: "RIGHT" });
    s.addComment(pr, { path: "a.ts", body: "two", line: 2, side: "RIGHT" });
    const [a, b] = comments();
    expect(a.id).toBeTruthy();
    expect(a.id).not.toBe(b.id);

    s.updateComment(pr, b.id, "two, edited");
    expect(comments().map((c) => c.body)).toEqual(["one", "two, edited"]);

    s.removeComment(pr, a.id);
    expect(comments().map((c) => c.id)).toEqual([b.id]);
  });

  it("keep their id when re-added (undo)", () => {
    const s = useReviewDraft.getState();
    s.addComment(pr, { path: "a.ts", body: "x", line: 1 });
    const [c] = comments();
    s.removeComment(pr, c.id);
    s.addComment(pr, c);
    expect(comments()[0].id).toBe(c.id);
  });

  it("drop the local id when submitted", () => {
    const sent = toSubmittable({ id: "x", path: "a.ts", body: "b", line: 3, side: "RIGHT" });
    expect(sent).toEqual({ path: "a.ts", body: "b", line: 3, side: "RIGHT" });
  });

  it("stored before ids existed are given one on load", () => {
    const migrate = useReviewDraft.persist.getOptions().migrate;
    const v0 = {
      drafts: { "o/r#1": { body: "", updatedAt: 1, comments: [{ path: "a.ts", body: "old" }] } },
    };
    const out = migrate?.(v0, 0) as ReturnType<typeof useReviewDraft.getState>;
    expect(out.drafts["o/r#1"].comments[0].id).toBeTruthy();
  });
});
