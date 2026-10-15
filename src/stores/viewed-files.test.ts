import { useViewedFiles } from "@/stores/viewed-files";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(() => useViewedFiles.setState({ viewed: {} }));

describe("carryForward", () => {
  it("copies marks for unchanged files only", () => {
    const s = useViewedFiles.getState();
    s.setViewed("o/r#1@old", "a.ts", true);
    s.setViewed("o/r#1@old", "b.ts", true);

    const added = s.carryForward("o/r#1@old", "o/r#1@new", (p) => p !== "b.ts");

    expect(added).toBe(1);
    expect(useViewedFiles.getState().viewed["o/r#1@new"]).toEqual({ "a.ts": true });
  });

  it("keeps marks already made on the new head, and does nothing the second time", () => {
    const s = useViewedFiles.getState();
    s.setViewed("o/r#1@old", "a.ts", true);
    s.setViewed("o/r#1@new", "c.ts", true);

    expect(s.carryForward("o/r#1@old", "o/r#1@new", () => true)).toBe(1);
    expect(useViewedFiles.getState().carryForward("o/r#1@old", "o/r#1@new", () => true)).toBe(0);
    expect(useViewedFiles.getState().viewed["o/r#1@new"]).toEqual({ "a.ts": true, "c.ts": true });
  });

  it("is a no-op without old marks or for the same key", () => {
    const s = useViewedFiles.getState();
    expect(s.carryForward("o/r#1@none", "o/r#1@new", () => true)).toBe(0);
    s.setViewed("o/r#1@h", "a.ts", true);
    expect(s.carryForward("o/r#1@h", "o/r#1@h", () => true)).toBe(0);
  });
});
