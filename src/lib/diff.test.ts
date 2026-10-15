import {
  hasLineEndingChanges,
  ignoreLineEndings,
  parseHunkHeader,
  parsePatch,
  sharedRatio,
} from "@/lib/diff";
import { diffWordsWithSpace } from "diff";
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

describe("line endings", () => {
  // A CRLF file converted to LF, with line "b" also edited and "x" inserted —
  // git sees every line as changed.
  const patch = ["@@ -1,3 +1,4 @@", "-a\r", "-b\r", "-c\r", "+a", "+x", "+B", "+c"].join("\n");

  it("detects lines whose only change is the terminator", () => {
    expect(hasLineEndingChanges(parsePatch(patch))).toBe(true);
    expect(hasLineEndingChanges(parsePatch("@@ -1 +1 @@\n-a\n+b"))).toBe(false);
  });

  it("keeps only the real edits once CR is ignored", () => {
    const [hunk] = parsePatch(patch).map(ignoreLineEndings);
    expect(hunk.lines.slice(1).map((l) => [l.kind, l.oldLine, l.newLine, l.text])).toEqual([
      ["context", 1, 1, "a"],
      ["del", 2, null, "b"],
      ["add", null, 2, "x"],
      ["add", null, 3, "B"],
      ["context", 3, 4, "c"],
    ]);
    expect(hunk.lines[1].eolChange).toBe("crlf-to-lf");
    expect(hunk.lines[2].eolChange).toBeUndefined();
  });

  it("tags an LF to CRLF conversion", () => {
    const [hunk] = parsePatch("@@ -1 +1 @@\n-a\n+a\r").map(ignoreLineEndings);
    expect(hunk.lines[1]).toMatchObject({ kind: "context", eolChange: "lf-to-crlf", text: "a" });
  });
});

describe("sharedRatio", () => {
  const ratio = (a: string, b: string) => sharedRatio(diffWordsWithSpace(a, b));

  it("scores an edited line high", () => {
    expect(ratio("const x = foo(a, b);", "const x = foo(a, b, c);")).toBeGreaterThan(0.8);
  });

  it("scores unrelated lines near zero, even with shared indentation", () => {
    expect(ratio("        Path to the subdirectory.", "        return form_dir")).toBe(0);
  });

  it("treats two whitespace-only lines as identical", () => {
    expect(ratio("  ", "\t")).toBe(1);
  });
});
