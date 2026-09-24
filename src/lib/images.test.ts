import { classify } from "@/lib/focus";
import { dataUrlSize, isImagePath } from "@/lib/images";
import type { PullFile } from "@/lib/tauri";
import { describe, expect, it } from "vitest";

describe("isImagePath", () => {
  it("accepts image extensions, case-insensitively", () => {
    expect(isImagePath("docs/images/overview.png")).toBe(true);
    expect(isImagePath("a/B.JPEG")).toBe(true);
    expect(isImagePath("icon.svg")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isImagePath("src/main.ts")).toBe(false);
    expect(isImagePath("png")).toBe(false);
    expect(isImagePath(".png")).toBe(false);
    expect(isImagePath(undefined)).toBe(false);
  });
});

describe("dataUrlSize", () => {
  it("measures the decoded payload, not the base64 text", () => {
    // "hello" → aGVsbG8= (5 bytes)
    expect(dataUrlSize("data:image/png;base64,aGVsbG8=")).toBe("5 B");
    expect(dataUrlSize(`data:image/png;base64,${"A".repeat(4096)}`)).toBe("3.0 KB");
  });
});

describe("classify", () => {
  const binary = (filename: string): PullFile => ({
    sha: "x",
    filename,
    status: "added",
    additions: 0,
    deletions: 0,
    changes: 0,
    patch: null,
    previous_filename: null,
  });

  it("doesn't hide an image as empty just because GitHub sends no patch", () => {
    expect(classify(binary("docs/images/overview.png"))).toBeNull();
    expect(classify(binary("empty.txt"))).toBe("empty");
  });
});
