/**
 * What the tour did NOT look at.
 *
 * `verify.ts` checks that what the AI said is true. Nothing checks what it
 * didn't say — and on a large PR that is where a missed defect lives. A tour is
 * a sequence of stops, each anchored to one file, and the step budget
 * (`layerStepCap`) caps stops per layer, so a 121-file PR cannot get a stop on
 * every file by construction. Today the reviewer sees "28 stops" and has no way
 * to learn that 107 files carry no stop at all.
 *
 * This module answers that deterministically — no model call, no AST — by
 * bucketing every changed file:
 *
 *   toured      — at least one stop lands on it
 *   pending     — belongs to a layer whose tour hasn't run yet (NOT a gap)
 *   skippable   — lockfile / generated / snapshot / format-only (`classify`)
 *   tests       — test files, read differently and rarely worth a stop
 *   unexamined  — none of the above: changed, unexplained, and nobody looked
 *
 * Only the last bucket is a real gap, and separating `pending` from it is what
 * keeps the number honest while a deep tour is still filling in — an in-flight
 * tour should not be accused of missing what it hasn't reached.
 *
 * The risk list is the other half. An unexamined lockfile is fine; an
 * unexamined change to authorization is not, so sensitive paths are called out
 * regardless of how tidy the rest of the coverage looks. Categories are
 * path-and-content regexes, deliberately narrow: a risk flag that cries wolf
 * gets ignored exactly when it matters.
 */
import { type HideReason, classify, isTestFile } from "@/lib/focus";
import type { GuidedStep } from "@/lib/guided";
import type { PullFile } from "@/lib/tauri";

export type CoverageBucket = "toured" | "pending" | "skippable" | "tests" | "unexamined";

/** Change categories that warrant reading the raw diff no matter how confident
 * the summary sounds. Mirrors the spec's risk-aware raw review. */
export type RiskCategory =
  | "auth"
  | "crypto"
  | "sql"
  | "concurrency"
  | "migration"
  | "money"
  | "destructive";

export interface FileCoverage {
  file: PullFile;
  bucket: CoverageBucket;
  /** Why it's skippable, when it is. */
  hidden: HideReason | null;
  /** How many tour stops land on this file. */
  stops: number;
  /** Sensitive categories this file matches, in declaration order. */
  risks: RiskCategory[];
}

export interface CoverageReport {
  files: FileCoverage[];
  /** File counts per bucket. */
  counts: Record<CoverageBucket, number>;
  /** Changed lines per bucket — the honest size of each gap. */
  churn: Record<CoverageBucket, number>;
  /** Unexamined files touching a sensitive category. The list to read first. */
  atRisk: FileCoverage[];
}

/* ─────────────────────── risk patterns ─────────────────────── */

/**
 * Path signals are the primary evidence — a file under `auth/` is about auth
 * whatever its contents. Content signals catch the sensitive change that lives
 * in an innocently-named file, and are kept strict enough that ordinary code
 * doesn't trip them.
 */
const RISK: { category: RiskCategory; path?: RegExp; content?: RegExp }[] = [
  {
    category: "auth",
    path: /(^|\/|_|-)(auth|authz|authn|login|logout|session|token|permission|role|tenant|acl|rbac|oauth|jwt|credential|password)(s)?($|\/|_|-|\.)/i,
    content:
      /\b(authenticate|authorize|isAdmin|is_admin|hasPermission|has_permission|checkAccess|check_access|verify_token|verifyToken|Bearer)\b/,
  },
  {
    category: "crypto",
    path: /(^|\/|_|-)(crypt|crypto|cipher|signature|tls|ssl|certificate)($|\/|_|-|\.)/i,
    content:
      /\b(createCipheriv|createHmac|randomBytes|hashlib|bcrypt|scrypt|pbkdf2|HMAC|secrets\.token)\b/,
  },
  {
    category: "sql",
    path: /\.sql$|(^|\/)(repositor(y|ies)|dao|queries)($|\/)/i,
    content: /\b(SELECT\s+.+\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i,
  },
  {
    category: "concurrency",
    path: /(^|\/|_|-)(worker|queue|scheduler|lock|mutex|thread|concurrency|retry|idempoten\w*)($|\/|_|-|\.)/i,
    content:
      /\b(Mutex|RwLock|sync\.Wait|goroutine|threading\.|asyncio\.gather|Promise\.all|Semaphore|AtomicInteger|compare_and_swap)\b/,
  },
  {
    category: "migration",
    path: /(^|\/)migrations?(\/|$)/i,
    content: /\b(ALTER\s+TABLE|CREATE\s+(UNIQUE\s+)?INDEX|DROP\s+COLUMN|ADD\s+CONSTRAINT)\b/i,
  },
  {
    category: "money",
    path: /(^|\/|_|-)(billing|payment|invoice|pricing|charge|refund|payout|currency|tax)(s)?($|\/|_|-|\.)/i,
    content: /\b(stripe|Decimal\(|BigDecimal|amount_cents|unit_amount)\b/i,
  },
  {
    category: "destructive",
    // No path signal — destructiveness is a property of the statement, never of
    // the filename.
    content: /\b(DROP\s+TABLE|TRUNCATE\s+TABLE|rm\s+-rf|deleteMany|destroy_all|DELETE\s+FROM)\b/i,
  },
];

/** Only the changed lines carry risk — untouched context in a hunk is not
 * something this PR is asking anyone to accept. */
function changedText(patch: string | null): string {
  if (!patch) return "";
  return patch
    .split("\n")
    .filter(
      (l) =>
        (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---"),
    )
    .join("\n");
}

/** Sensitive categories a file's path or changed lines match. */
export function fileRisks(file: PullFile): RiskCategory[] {
  const body = changedText(file.patch);
  return RISK.filter((r) => r.path?.test(file.filename) || (body && r.content?.test(body))).map(
    (r) => r.category,
  );
}

/* ─────────────────────── the report ─────────────────────── */

const EMPTY = (): Record<CoverageBucket, number> => ({
  toured: 0,
  pending: 0,
  skippable: 0,
  tests: 0,
  unexamined: 0,
});

/**
 * Bucket every changed file by whether the tour actually looked at it.
 *
 * `pendingPaths` are the files belonging to layers that haven't been toured
 * yet; pass them so an in-flight deep tour reports honestly instead of
 * indicting itself for work still queued. Omit for a finished or classic tour.
 */
export function tourCoverage(
  steps: GuidedStep[],
  files: PullFile[],
  pendingPaths?: ReadonlySet<string>,
): CoverageReport {
  const stopsByPath = new Map<string, number>();
  for (const s of steps) stopsByPath.set(s.path, (stopsByPath.get(s.path) ?? 0) + 1);

  const counts = EMPTY();
  const churn = EMPTY();
  const out: FileCoverage[] = [];

  for (const file of files) {
    const stops = stopsByPath.get(file.filename) ?? 0;
    const hidden = classify(file);

    // Precedence matters: a stop beats everything (the AI did look at it, even
    // if the file is also a lockfile), and a queued layer beats the skip
    // heuristics so a pending file is never miscounted as a decided skip.
    const bucket: CoverageBucket =
      stops > 0
        ? "toured"
        : pendingPaths?.has(file.filename)
          ? "pending"
          : hidden
            ? "skippable"
            : isTestFile(file.filename)
              ? "tests"
              : "unexamined";

    counts[bucket]++;
    churn[bucket] += file.changes;
    out.push({ file, bucket, hidden, stops, risks: fileRisks(file) });
  }

  // Biggest gaps first — churn is the best available proxy for how much is
  // riding on a file nobody read.
  const atRisk = out
    .filter((f) => f.bucket === "unexamined" && f.risks.length > 0)
    .sort((a, b) => b.file.changes - a.file.changes);

  return { files: out, counts, churn, atRisk };
}

/** The headline: changed files nobody looked at and nothing excused. */
export const blindSpots = (r: CoverageReport): FileCoverage[] =>
  r.files.filter((f) => f.bucket === "unexamined").sort((a, b) => b.file.changes - a.file.changes);

export const RISK_LABEL: Record<RiskCategory, string> = {
  auth: "auth",
  crypto: "crypto",
  sql: "SQL",
  concurrency: "concurrency",
  migration: "migration",
  money: "money",
  destructive: "destructive",
};
