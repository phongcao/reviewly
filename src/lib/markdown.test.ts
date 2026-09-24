import { parsePatch } from "@/lib/diff";
import { isMarkdownPath, resolveDocUrl, sideText } from "@/lib/markdown";
import { describe, expect, it } from "vitest";

const ref = { owner: "acme", repo: "svc", sha: "abc123", path: "docs/architecture/README.md" };

describe("isMarkdownPath", () => {
  it("accepts markdown extensions, case-insensitively", () => {
    expect(isMarkdownPath("README.md")).toBe(true);
    expect(isMarkdownPath("docs/a/b.MARKDOWN")).toBe(true);
    expect(isMarkdownPath("notes.mdx")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isMarkdownPath("src/main.ts")).toBe(false);
    expect(isMarkdownPath("Makefile")).toBe(false);
    expect(isMarkdownPath(".md")).toBe(false);
    expect(isMarkdownPath(null)).toBe(false);
  });
});

describe("sideText", () => {
  it("rebuilds a whole added file and reports it complete", () => {
    const patch = ["@@ -0,0 +1,3 @@", "+# Title", "+", "+body"].join("\n");
    expect(sideText(parsePatch(patch), "new")).toEqual({ text: "# Title\n\nbody", complete: true });
  });

  it("drops the other side's lines", () => {
    const patch = ["@@ -1,2 +1,2 @@", " # Title", "-old", "+new"].join("\n");
    const hunks = parsePatch(patch);
    expect(sideText(hunks, "new").text).toBe("# Title\nnew");
    expect(sideText(hunks, "old").text).toBe("# Title\nold");
  });

  it("flags a patch that skips unchanged regions", () => {
    const patch = ["@@ -1,1 +1,1 @@", "-a", "+A", "@@ -40,1 +40,1 @@", "-b", "+B"].join("\n");
    const out = sideText(parsePatch(patch), "new");
    expect(out.complete).toBe(false);
    expect(out.text).toBe("A\nB");
  });
});

describe("resolveDocUrl", () => {
  it("routes relative images through raw.githubusercontent", () => {
    expect(resolveDocUrl("../images/overview.png", ref, "src")).toBe(
      "https://raw.githubusercontent.com/acme/svc/abc123/docs/images/overview.png",
    );
  });

  it("routes relative links to the blob at the reviewed sha", () => {
    expect(resolveDocUrl("./adr/0001.md", ref, "href")).toBe(
      "https://github.com/acme/svc/blob/abc123/docs/architecture/adr/0001.md",
    );
  });

  it("treats a leading slash as repo-root-relative", () => {
    expect(resolveDocUrl("/CONTRIBUTING.md", ref, "href")).toBe(
      "https://github.com/acme/svc/blob/abc123/CONTRIBUTING.md",
    );
  });

  it("sends in-page anchors to the rendered file on GitHub", () => {
    expect(resolveDocUrl("#goals", ref, "href")).toBe(
      "https://github.com/acme/svc/blob/abc123/docs/architecture/README.md#goals",
    );
  });

  it("leaves absolute URLs alone", () => {
    expect(resolveDocUrl("https://example.com/x.png", ref, "src")).toBe(
      "https://example.com/x.png",
    );
    expect(resolveDocUrl("mailto:a@b.c", ref, "href")).toBe("mailto:a@b.c");
  });

  it("falls back to HEAD without a sha", () => {
    expect(resolveDocUrl("x.md", { ...ref, sha: null }, "href")).toBe(
      "https://github.com/acme/svc/blob/HEAD/docs/architecture/x.md",
    );
  });
});
