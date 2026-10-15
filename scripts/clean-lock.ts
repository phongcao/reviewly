/**
 * Keep bun.lock registry-neutral.
 *
 * Installing through a private registry or proxy (an `.npmrc` `registry=`)
 * makes bun write that registry's tarball URL into every entry, and some
 * proxies hand out only sha1 hashes. CI installs from npmjs with
 * `--frozen-lockfile`, so the committed lockfile must name no registry and
 * carry sha512 hashes, as one made against npmjs does.
 *
 *   bun scripts/clean-lock.ts          clean bun.lock in place
 *   bun scripts/clean-lock.ts --check  exit 1 if bun.lock names a registry or has a sha1 hash
 *
 * Cleaning drops each entry's URL (an empty one means "the configured
 * registry", so installs still go through your proxy) and replaces a sha1 hash
 * with sha512. The sha512 comes from the committed lockfile when it has the
 * same name@version; otherwise the tarball is downloaded from the entry's URL,
 * checked against its sha1, and hashed. Downloads use `curl`, which trusts the
 * system certificate store, as a corporate proxy usually needs.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const LOCK = "bun.lock";

/** One registry package: `"key": ["name@version", "url", {meta}, "integrity"],` */
const ENTRY = /^(\s*"[^"]+": \[)"([^"]+)", "([^"]*)", (.*), "(sha(?:1|512)-[^"]+)"(\],?)$/;

interface Entry {
  head: string;
  spec: string;
  url: string;
  meta: string;
  integrity: string;
  tail: string;
}

function parse(line: string): Entry | null {
  const m = ENTRY.exec(line);
  if (!m) return null;
  const [, head, spec, url, meta, integrity, tail] = m;
  // A dependency on a tarball or git URL is pinned by that URL: leave it be.
  if (spec.includes("://")) return null;
  return { head, spec, url, meta, integrity, tail };
}

const format = (e: Entry): string =>
  `${e.head}"${e.spec}", "${e.url}", ${e.meta}, "${e.integrity}"${e.tail}`;

const hash = (algo: "sha1" | "sha512", data: Buffer): string =>
  `${algo}-${createHash(algo).update(data).digest("base64")}`;

/** sha512 hashes by name@version from the committed lockfile, if there is one. */
function committedHashes(): Map<string, string> {
  const known = new Map<string, string>();
  let text = "";
  try {
    text = execFileSync("git", ["show", `HEAD:${LOCK}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return known; // not a git checkout, or no committed lockfile yet
  }
  for (const line of text.split("\n")) {
    const e = parse(line);
    if (e?.integrity.startsWith("sha512-")) known.set(e.spec, e.integrity);
  }
  return known;
}

function sha512For(e: Entry, known: Map<string, string>): string {
  const committed = known.get(e.spec);
  if (committed) return committed;
  if (!e.url) {
    throw new Error(
      `${e.spec} has only a sha1 hash and no URL to fetch it from. Run \`bun install\` through your registry, then run this again.`,
    );
  }
  const data = execFileSync("curl", ["-sSfL", "--max-time", "120", e.url], {
    maxBuffer: 256 * 1024 * 1024,
  });
  // Trust the bytes only if they are the ones the lockfile already pinned.
  const sha1 = hash("sha1", data);
  if (sha1 !== e.integrity) {
    throw new Error(`${e.spec}: downloaded ${sha1}, but the lockfile pins ${e.integrity}`);
  }
  return hash("sha512", data);
}

function clean(): void {
  const lines = readFileSync(LOCK, "utf8").split("\n");
  const known = committedHashes();
  let urls = 0;
  let upgraded = 0;
  const out = lines.map((line) => {
    const e = parse(line);
    if (!e || (!e.url && e.integrity.startsWith("sha512-"))) return line;
    if (e.integrity.startsWith("sha1-")) {
      e.integrity = sha512For(e, known);
      upgraded += 1;
    }
    if (e.url) urls += 1;
    e.url = "";
    return format(e);
  });
  if (urls === 0 && upgraded === 0) {
    console.log(`${LOCK} is already clean.`);
    return;
  }
  writeFileSync(LOCK, out.join("\n"));
  console.log(
    `${LOCK}: removed ${urls} registry URLs, upgraded ${upgraded} sha1 hashes to sha512.`,
  );
}

function check(): void {
  const bad = readFileSync(LOCK, "utf8")
    .split("\n")
    .map(parse)
    .filter((e): e is Entry => !!e && (!!e.url || e.integrity.startsWith("sha1-")));
  if (bad.length === 0) {
    console.log(`${LOCK} names no registry and has only sha512 hashes.`);
    return;
  }
  console.error(`${LOCK} has ${bad.length} entries made against a private registry or proxy:`);
  for (const e of bad.slice(0, 5)) {
    console.error(`  ${e.spec}${e.url ? ` (${e.url})` : ""} ${e.integrity.slice(0, 12)}…`);
  }
  if (bad.length > 5) console.error(`  …and ${bad.length - 5} more`);
  console.error("Run `bun run lock:clean` and commit the result.");
  process.exit(1);
}

if (process.argv.includes("--check")) check();
else clean();
