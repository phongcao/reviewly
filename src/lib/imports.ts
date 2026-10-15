/**
 * Import parsing and resolution — which file a source file pulls in.
 *
 * Knows nothing about layers, PRs, or repositories: it maps a file's text to
 * the specs it imports, and a spec to a path among a set of known paths. A PR
 * passes its changed files; a repository passes every tracked file. Anything
 * that resolves outside that set (a package, a file the PR didn't touch)
 * resolves to null, which is the honest answer — a link to a file we don't
 * have is a link we can't draw.
 *
 * Regex, not a parser. That misses imports built from strings and can catch
 * one inside a comment, but it needs no grammar per language and runs on a
 * partial file (a diff's lines, the head of a file) where a parser would fail.
 * The edges it produces are a reading aid, never a gate.
 */

const JS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const JS_FILE = /\.(?:[cm]?[jt]sx?)$/i;
const PY_FILE = /\.pyi?$/i;

/** Prefix → directory. `"@/"` → `"src/"` maps `@/lib/x` to `src/lib/x`. */
export type Aliases = Record<string, string>;

const JS_PATTERNS = [
  // import x from "a" · import { a, b } from "a" · export * from "a" · import type …
  /\b(?:import|export)\b[^;'"`]*?\bfrom\s*['"]([^'"\n]+)['"]/g,
  // import "a" (side effect)
  /\bimport\s*['"]([^'"\n]+)['"]/g,
  // import("a")
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  // require("a")
  /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
];

/** The import specs in `text`, in first-seen order, without duplicates.
 * Languages other than TS/JS and Python return `[]`; add them here. */
export function extractImports(path: string, text: string): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    const spec = s.trim();
    if (spec && !out.includes(spec)) out.push(spec);
  };
  if (JS_FILE.test(path)) {
    // Order by position, not by pattern, so the result reads like the file.
    const hits: { at: number; spec: string }[] = [];
    for (const re of JS_PATTERNS) {
      for (const m of text.matchAll(re)) hits.push({ at: m.index ?? 0, spec: m[1] });
    }
    for (const h of hits.sort((a, b) => a.at - b.at)) add(h.spec);
  } else if (PY_FILE.test(path)) {
    for (const line of text.split("\n")) {
      const from = line.match(/^\s*from\s+(\.*[\w.]*)\s+import\s+(.+)$/);
      if (from) {
        const mod = from[1];
        if (/^\.+$/.test(mod)) {
          // `from . import a, b` — each name is a sibling module.
          for (const name of from[2].replace(/[()]/g, "").split(",")) {
            const n = name.trim().split(/\s+as\s+/)[0];
            if (/^\w+$/.test(n)) add(`${mod}${n}`);
          }
        } else if (mod) {
          add(mod);
        }
        continue;
      }
      const imp = line.match(
        /^\s*import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)/,
      );
      if (imp) {
        for (const part of imp[1].split(",")) add(part.trim().split(/\s+as\s+/)[0]);
      }
    }
  }
  return out;
}

/** `src/` exists → `@/` points at it, the convention this app and most Vite
 * projects use. Anything richer comes from `aliasesFromTsconfig`. */
export function defaultAliases(paths: Iterable<string>): Aliases {
  for (const p of paths) if (p.startsWith("src/")) return { "@/": "src/" };
  return {};
}

/** Strip `//` and `/* *\/` comments outside strings, and trailing commas —
 * tsconfig is JSONC. */
function stripJsonc(text: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
      out += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else {
      out += ch;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** Aliases from a `tsconfig.json`'s `compilerOptions.paths` (`"@/*": ["./src/*"]`),
 * relative to `baseUrl` and to the tsconfig's own directory `dir`. */
export function aliasesFromTsconfig(text: string, dir = ""): Aliases {
  let cfg: { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
  try {
    cfg = JSON.parse(stripJsonc(text));
  } catch {
    return {};
  }
  const base = normalize(join(dir, cfg.compilerOptions?.baseUrl ?? "."));
  const out: Aliases = {};
  for (const [key, targets] of Object.entries(cfg.compilerOptions?.paths ?? {})) {
    const target = targets?.[0];
    if (!target || !key.endsWith("*") || !target.endsWith("*")) continue;
    const to = normalize(join(base, target.slice(0, -1)));
    out[key.slice(0, -1)] = to ? `${to.replace(/\/$/, "")}/` : "";
  }
  return out;
}

const dirname = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const join = (a: string, b: string): string => (a ? `${a}/${b}` : b);

/** Resolve `.` and `..` segments; leading `..` past the root is dropped. */
function normalize(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

/** Basename → paths, built once per known-path set for Python suffix lookups. */
const byBase = new WeakMap<ReadonlySet<string>, Map<string, string[]>>();
function baseIndex(known: ReadonlySet<string>): Map<string, string[]> {
  let idx = byBase.get(known);
  if (!idx) {
    idx = new Map();
    for (const p of known) {
      const b = p.slice(p.lastIndexOf("/") + 1);
      const list = idx.get(b);
      if (list) list.push(p);
      else idx.set(b, [p]);
    }
    byBase.set(known, idx);
  }
  return idx;
}

/** Length of the shared leading directory segments — the tie-break when a
 * dotted Python module matches several files. */
function sharedDirs(a: string, b: string): number {
  const x = dirname(a).split("/");
  const y = dirname(b).split("/");
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}

function resolveJs(fromPath: string, spec: string, known: ReadonlySet<string>, aliases: Aliases) {
  let base: string | null = null;
  if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") {
    base = normalize(join(dirname(fromPath), spec));
  } else {
    // Longest alias prefix first, so `@/lib/` beats `@/`.
    const prefix = Object.keys(aliases)
      .sort((a, b) => b.length - a.length)
      .find((p) => spec.startsWith(p));
    if (prefix === undefined) return null; // a bare package
    base = normalize(aliases[prefix] + spec.slice(prefix.length));
  }
  const tries = [base, ...JS_EXTS.map((e) => base + e), ...JS_EXTS.map((e) => `${base}/index${e}`)];
  // TS ESM writes `./x.js` for `./x.ts`.
  const m = base.match(/^(.*)\.(?:[cm]?js|jsx)$/);
  if (m) tries.push(...JS_EXTS.map((e) => m[1] + e));
  return tries.find((p) => known.has(p)) ?? null;
}

function resolvePy(fromPath: string, spec: string, known: ReadonlySet<string>) {
  const dots = spec.match(/^\.*/)?.[0].length ?? 0;
  const rest = spec.slice(dots).split(".").filter(Boolean).join("/");
  if (dots > 0) {
    let dir = dirname(fromPath);
    for (let i = 1; i < dots; i++) dir = dirname(dir);
    const base = normalize(join(dir, rest));
    return [`${base}.py`, `${base}/__init__.py`].find((p) => known.has(p)) ?? null;
  }
  if (!rest) return null;
  // Absolute dotted module: match by path suffix (`a.b.c` → `…/a/b/c.py`).
  const idx = baseIndex(known);
  const leaf = rest.slice(rest.lastIndexOf("/") + 1);
  const hits = [
    ...(idx.get(`${leaf}.py`) ?? []).filter((p) => p === `${rest}.py` || p.endsWith(`/${rest}.py`)),
    ...(idx.get("__init__.py") ?? []).filter(
      (p) => p === `${rest}/__init__.py` || p.endsWith(`/${rest}/__init__.py`),
    ),
  ];
  if (hits.length === 0) return null;
  return hits.sort(
    (a, b) => sharedDirs(b, fromPath) - sharedDirs(a, fromPath) || a.length - b.length,
  )[0];
}

/**
 * The known path `spec` (imported from `fromPath`) refers to, or null.
 *
 * `knownPaths` is the PR's changed files for a PR, or every tracked file for
 * a repository. Only paths in it are returned, so a bare package name, or a
 * file outside the set, is null.
 */
export function resolveImport(
  fromPath: string,
  spec: string,
  knownPaths: ReadonlySet<string>,
  aliases: Aliases = {},
): string | null {
  const hit = PY_FILE.test(fromPath)
    ? resolvePy(fromPath, spec, knownPaths)
    : JS_FILE.test(fromPath)
      ? resolveJs(fromPath, spec, knownPaths, aliases)
      : null;
  return hit && hit !== fromPath ? hit : null;
}
