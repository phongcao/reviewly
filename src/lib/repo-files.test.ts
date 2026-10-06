import { classifyRepoFile } from "@/lib/repo-files";
import { describe, expect, it } from "vitest";

const kind = (path: string, binary = false) =>
  classifyRepoFile({ path, bytes: 10, lines: binary ? 0 : 3, binary }).kind;

describe("classifyRepoFile", () => {
  it("classifies source", () => {
    expect(kind("src/lib/report.ts")).toBe("source");
    expect(kind("app/main.py")).toBe("source");
  });
  it("classifies tests", () => {
    expect(kind("src/lib/report.test.ts")).toBe("test");
    expect(kind("tests/test_api.py")).toBe("test");
    expect(kind("pkg/conftest.py")).toBe("test");
  });
  it("classifies config", () => {
    expect(kind("package.json")).toBe("config");
    expect(kind(".github/workflows/ci.yml")).toBe("config");
    expect(kind("pyproject.toml")).toBe("config");
  });
  it("classifies docs", () => {
    expect(kind("README.md")).toBe("doc");
    expect(kind("docs/setup.md")).toBe("doc");
    expect(kind("LICENSE")).toBe("doc");
  });
  it("classifies generated files", () => {
    expect(kind("bun.lock")).toBe("generated");
    expect(kind("Cargo.lock")).toBe("generated");
    expect(kind("dist/app.js")).toBe("generated");
    expect(kind("src/api.pb.ts")).toBe("generated");
    expect(kind("types/global.d.ts")).toBe("generated");
  });
  it("classifies binary files ahead of everything else", () => {
    expect(kind("assets/logo.png", true)).toBe("binary");
    expect(kind("src/weird.ts", true)).toBe("binary");
  });
  it("keeps size and language", () => {
    expect(classifyRepoFile({ path: "a.py", bytes: 99, lines: 7, binary: false })).toEqual({
      path: "a.py",
      bytes: 99,
      lines: 7,
      lang: "python",
      kind: "source",
    });
  });
});
