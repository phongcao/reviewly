import { parseHunkHeader } from "@/lib/diff";
import { describe, expect, it } from "vitest";

describe("parseHunkHeader", () => {
  it("reads the new-file start line", () => {
    expect(parseHunkHeader("@@ -10,7 +24,9 @@").newStart).toBe(24);
  });

  it("reads the enclosing-symbol hint when git supplies one", () => {
    const h = parseHunkHeader("@@ -10,7 +24,9 @@ def process(order):");
    expect(h.symbol).toBe("def process(order):");
    expect(h.range).toBe("@@ -10,7 +24,9 @@");
    expect(h.newStart).toBe(24);
  });

  it("handles single-line ranges with no count", () => {
    expect(parseHunkHeader("@@ -1 +1 @@").newStart).toBe(1);
  });

  it("handles a new file starting at line 1", () => {
    const h = parseHunkHeader("@@ -0,0 +1,50 @@");
    expect(h.newStart).toBe(1);
    expect(h.symbol).toBe("");
  });

  it("returns newStart 0 for anything that isn't a hunk header", () => {
    const h = parseHunkHeader("not a header");
    expect(h.newStart).toBe(0);
    expect(h.range).toBe("not a header");
  });
});
