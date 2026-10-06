import { aliasesFromTsconfig, defaultAliases, extractImports, resolveImport } from "@/lib/imports";
import { describe, expect, it } from "vitest";

describe("extractImports — TS/JS", () => {
  it("finds every import form, in order, once each", () => {
    const text = [
      'import React from "react";',
      "import {",
      "  a,",
      "  b,",
      '} from "./multi";',
      'import type { T } from "@/lib/types";',
      'export * from "./reexport";',
      'export { x } from "../up";',
      'import "./side-effect.css";',
      'const lazy = () => import("./lazy");',
      'const cjs = require("./cjs");',
      'import again from "./multi";',
    ].join("\n");
    expect(extractImports("src/a.tsx", text)).toEqual([
      "react",
      "./multi",
      "@/lib/types",
      "./reexport",
      "../up",
      "./side-effect.css",
      "./lazy",
      "./cjs",
    ]);
  });

  it("handles every JS/TS extension", () => {
    for (const ext of ["ts", "tsx", "js", "jsx", "mjs", "cjs"]) {
      expect(extractImports(`a.${ext}`, 'import x from "./b";')).toEqual(["./b"]);
    }
  });
});

describe("extractImports — Python", () => {
  it("finds from-imports, relative imports, and dotted imports", () => {
    const text = [
      "from billing.price import total",
      "from .models import Order",
      "from .. import utils, helpers as h",
      "import os.path, json as j",
      "import app.core.config",
    ].join("\n");
    expect(extractImports("pkg/mod.py", text)).toEqual([
      "billing.price",
      ".models",
      "..utils",
      "..helpers",
      "os.path",
      "json",
      "app.core.config",
    ]);
  });
});

describe("extractImports — other languages", () => {
  it("returns nothing", () => {
    expect(extractImports("main.go", 'import "fmt"')).toEqual([]);
    expect(extractImports("README.md", 'import x from "./y"')).toEqual([]);
  });
});

describe("resolveImport", () => {
  const known = new Set([
    "src/lib/a.ts",
    "src/lib/b.tsx",
    "src/lib/util/index.ts",
    "src/components/c.tsx",
    "src/esm.ts",
    "pkg/models.py",
    "pkg/sub/__init__.py",
    "pkg/sub/deep.py",
    "other/pkg/sub/deep.py",
  ]);

  it("resolves relative specs with an extension or index", () => {
    expect(resolveImport("src/lib/a.ts", "./b", known)).toBe("src/lib/b.tsx");
    expect(resolveImport("src/lib/a.ts", "./util", known)).toBe("src/lib/util/index.ts");
    expect(resolveImport("src/components/c.tsx", "../lib/a", known)).toBe("src/lib/a.ts");
  });

  it("maps a TS ESM `.js` spec to its `.ts` file", () => {
    expect(resolveImport("src/lib/a.ts", "../esm.js", known)).toBe("src/esm.ts");
  });

  it("resolves an alias", () => {
    const aliases = defaultAliases(known);
    expect(aliases).toEqual({ "@/": "src/" });
    expect(resolveImport("src/components/c.tsx", "@/lib/a", known, aliases)).toBe("src/lib/a.ts");
  });

  it("ignores bare packages and files outside the known set", () => {
    expect(resolveImport("src/lib/a.ts", "react", known)).toBeNull();
    expect(resolveImport("src/lib/a.ts", "./missing", known)).toBeNull();
    expect(resolveImport("src/lib/a.ts", "@/lib/a", known)).toBeNull(); // no alias given
  });

  it("resolves Python relative and package imports", () => {
    expect(resolveImport("pkg/views.py", ".models", known)).toBe("pkg/models.py");
    expect(resolveImport("pkg/sub/deep.py", "..models", known)).toBe("pkg/models.py");
    expect(resolveImport("pkg/views.py", ".sub", known)).toBe("pkg/sub/__init__.py");
  });

  it("matches a dotted Python module by path suffix, nearest first", () => {
    expect(resolveImport("pkg/views.py", "sub.deep", known)).toBe("pkg/sub/deep.py");
    expect(resolveImport("other/x.py", "pkg.sub.deep", known)).toBe("other/pkg/sub/deep.py");
    expect(resolveImport("pkg/views.py", "requests", known)).toBeNull();
  });
});

describe("aliasesFromTsconfig", () => {
  it("reads compilerOptions.paths from JSONC", () => {
    const tsconfig = `{
      // comment
      "compilerOptions": {
        "baseUrl": ".",
        "paths": { "@/*": ["./src/*"], "~lib/*": ["src/lib/*"], },
      },
    }`;
    expect(aliasesFromTsconfig(tsconfig)).toEqual({ "@/": "src/", "~lib/": "src/lib/" });
  });

  it("returns nothing for junk", () => {
    expect(aliasesFromTsconfig("not json")).toEqual({});
  });
});
