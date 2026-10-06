/**
 * Small, made-up inputs for the review-report tests. They deliberately
 * exercise every field a reader sees: a deep tour that is still partial, a
 * stale head, every trust value, a dismissed stop, a claim check, a concern
 * check, and unexamined, pending, and sensitive files.
 */
import type { CheckRecord } from "@/lib/claim-check";
import { stepId } from "@/lib/deep-tour";
import type { GuidedPlan, GuidedStep } from "@/lib/guided";
import type { LayerPlan } from "@/lib/layers";
import type { ReviewReportInput } from "@/lib/report";
import type { PullFile } from "@/lib/tauri";

const file = (filename: string, patch: string | null, additions = 3, deletions = 1): PullFile => ({
  sha: "f00",
  filename,
  status: "modified",
  additions,
  deletions,
  changes: additions + deletions,
  patch,
  previous_filename: null,
});

export const SAMPLE_FILES: PullFile[] = [
  file(
    "src/billing/price.ts",
    [
      "@@ -10,3 +10,6 @@ export function total(items: Item[]) {",
      "   let sum = 0;",
      "   for (const item of items) {",
      "+    if (item.quantity <= 0) {",
      "+      continue;",
      "+    }",
      "     sum += item.price * item.quantity;",
    ].join("\n"),
  ),
  file(
    "src/auth/session.ts",
    [
      "@@ -1,4 +1,4 @@",
      " export const MAX_RETRIES = 3;",
      "-export function refresh(token: string) {",
      "+export function refresh(token: string, force = false) {",
      "   return fetchToken(token);",
    ].join("\n"),
    1,
    1,
  ),
  file(
    "src/auth/permissions.ts",
    "@@ -1,1 +1,2 @@\n export const ROLES = [];\n+export const ADMIN = 'admin';",
    1,
    0,
  ),
  file("src/ui/cart.tsx", "@@ -5,1 +5,2 @@\n <Cart />\n+<Total />", 1, 0),
  file("bun.lock", "@@ -1,1 +1,1 @@\n-a\n+b", 1, 1),
];

const step = (o: Partial<GuidedStep>): GuidedStep => ({
  path: "src/billing/price.ts",
  line: 13,
  kind: "orient",
  title: "Pricing skips empty items",
  detail: "`total` skips items where `quantity <= 0`.",
  layerId: "l1",
  ...o,
});

export const SAMPLE_STEPS: GuidedStep[] = [
  step({ endLine: 15 }),
  step({
    line: 15,
    kind: "praise",
    title: "Sum uses the item price",
    detail: "`sum` adds `price` times `quantity`.",
  }),
  step({
    path: "src/auth/session.ts",
    line: 2,
    kind: "concern",
    title: "New `force` flag is unused",
    detail: "`refresh` takes `force` but never reads it.",
    suggestion: "Is `force` meant to skip the cache here?",
  }),
  step({
    path: "src/auth/session.ts",
    line: 1,
    kind: "orient",
    title: "Retry limit",
    detail: "`MAX_RETRIES` is `3`.",
  }),
  step({
    path: "src/billing/price.ts",
    line: 90,
    kind: "question",
    title: "Calls `TaxEngine`?",
    detail: "Does `TaxEngine` see the skipped items?",
  }),
];

export const SAMPLE_PLAN: GuidedPlan = {
  summary: "Pricing skips empty items and `refresh` gains a `force` flag.",
  tour: "Start with pricing, then the session.",
  verdict: "comment",
  verdictReason: "The `force` flag needs an answer from the author.",
  steps: SAMPLE_STEPS,
  layers: [{ id: "l1", title: "Core logic", index: 1, total: 2, steps: 5 }],
};

export const SAMPLE_LAYERS: LayerPlan = {
  summary: "Pricing and session changes.",
  strategy: "Logic first, then UI.",
  layers: [
    {
      id: "l1",
      title: "Core logic",
      intent: "Pricing and session rules.",
      focus: ["`total` never counts empty items"],
      risk: "high",
      files: ["src/billing/price.ts", "src/auth/session.ts", "src/auth/permissions.ts"],
    },
    {
      id: "l2",
      title: "Cart UI",
      intent: "Shows the new total.",
      focus: [],
      risk: "low",
      files: ["src/ui/cart.tsx", "bun.lock"],
    },
  ],
};

const claims = (result: "supported" | "contradicted"): CheckRecord => ({
  type: "claims",
  result,
  claims: [
    {
      text: "`total` skips items where `quantity <= 0`",
      verdict: result,
      path: "src/billing/price.ts",
      line: 13,
      note: result === "supported" ? "line 13 is the guard" : "line 13 skips only negatives",
    },
  ],
  checkedAt: 1_759_600_000_000,
  provider: "claude",
});

export const SAMPLE_INPUT: ReviewReportInput = {
  pr: {
    key: "acme/shop#42",
    title: "Skip empty cart items",
    url: "https://github.com/acme/shop/pull/42",
    headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  },
  plan: SAMPLE_PLAN,
  tour: {
    type: "deep",
    headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    provider: "claude",
    generatedAt: 1_759_500_000_000,
    layersToured: { done: 1, total: 2 },
  },
  layers: { plan: SAMPLE_LAYERS, toured: new Set(["l1"]) },
  files: SAMPLE_FILES,
  checks: {
    [stepId(SAMPLE_STEPS[0])]: claims("supported"),
    [stepId(SAMPLE_STEPS[1])]: claims("contradicted"),
    [stepId(SAMPLE_STEPS[2])]: {
      type: "concern",
      verdict: "valid",
      finding: "`force` is never read.",
      checkedAt: 1_759_600_000_000,
      provider: "claude",
    },
  },
  dismissedIds: new Set([stepId(SAMPLE_STEPS[3])]),
  pendingPaths: new Set(["src/ui/cart.tsx", "bun.lock"]),
  exportedAt: 1_759_700_000_000,
  app: "0.0.0-test",
};
