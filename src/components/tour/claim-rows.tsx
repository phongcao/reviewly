import { TooltipFor } from "@/components/tooltip-for";
import { CodeSpans } from "@/components/tour/code-spans";
import { Button } from "@/components/ui/button";
import type { CheckRecord, CheckedClaim, Trust } from "@/lib/claim-check";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { type AiProvider, PROVIDER_LABEL } from "@/stores/ai";
import { Check, HelpCircle, MapPinOff, RefreshCw, ShieldCheck, ShieldX } from "lucide-react";
import type { ComponentType } from "react";

/** How a trust value reads on a stop. `unchecked` has no chip at all. */
export const TRUST_META: Record<
  Exclude<Trust, "unchecked">,
  { label: string; chip: string; title: string }
> = {
  verified: {
    label: "Checked",
    chip: "bg-success/12 text-success",
    title:
      "Anchored in the diff, and an AI check backed every claim. The check is itself an AI call and can be wrong.",
  },
  contradicted: {
    label: "Disputed",
    chip: "bg-destructive/12 text-destructive",
    title: "An AI check found code that disagrees with this stop. Read the claim rows below.",
  },
  // Same word as the grade count and the stop's "Couldn't verify" note, so
  // one failure has one name. The trust value stays `unanchored` in the data.
  unanchored: {
    label: "Unverified",
    chip: "bg-warning/12 text-warning",
    title:
      "This stop's line, or a name it cites, couldn't be found, so no AI check can confirm it. The note on the stop says which.",
  },
};

export function TrustChip({ trust }: { trust: Exclude<Trust, "unchecked"> }) {
  const m = TRUST_META[trust];
  return (
    <TooltipFor label={m.title}>
      <span className={cn("shrink-0 rounded-full px-1.5 py-px text-3xs font-medium", m.chip)}>
        {m.label}
      </span>
    </TooltipFor>
  );
}

const CLAIM_META: Record<
  CheckedClaim["verdict"],
  { icon: ComponentType<{ className?: string }>; text: string; label: string }
> = {
  supported: { icon: Check, text: "text-success", label: "supported" },
  misplaced: { icon: MapPinOff, text: "text-warning", label: "misplaced" },
  contradicted: { icon: ShieldX, text: "text-destructive", label: "contradicted" },
  unverifiable: { icon: HelpCircle, text: "text-muted-foreground", label: "unverifiable" },
};

/**
 * A claim check's result: one row per atomic claim, each with the line the
 * checker cited. The rows are the evidence — the stop's trust chip is only a
 * summary of them, and a reviewer who disagrees needs to see which claim
 * moved it.
 */
export function ClaimRows({
  record,
  checking,
  onRecheck,
  onOpenFile,
}: {
  record: Extract<CheckRecord, { type: "claims" }>;
  checking: boolean;
  onRecheck: () => void;
  onOpenFile: (path: string, line?: number) => void;
}) {
  const n = (v: CheckedClaim["verdict"]) => record.claims.filter((c) => c.verdict === v).length;
  return (
    <div className="mt-3 rounded-lg border border-border/50 bg-foreground/[0.02] p-2.5">
      <div className="flex items-center gap-2 text-2xs text-muted-foreground">
        <ShieldCheck className="size-3 shrink-0" />
        <span className="font-medium text-foreground/75">AI claim check</span>
        <span className="min-w-0 truncate tabular-nums">
          {record.unparsed
            ? "couldn't read the check's reply"
            : record.claims.length === 0
              ? "no factual claims"
              : `${n("supported")} supported · ${n("misplaced") > 0 ? `${n("misplaced")} misplaced · ` : ""}${n("contradicted")} contradicted · ${n("unverifiable")} unverifiable`}
        </span>
        <span className="ml-auto shrink-0 text-muted-foreground/60">
          {PROVIDER_LABEL[record.provider as AiProvider] ?? record.provider} ·{" "}
          {relativeTime(new Date(record.checkedAt).toISOString())}
        </span>
        <Button size="xs" variant="ghost" loading={checking} onClick={onRecheck}>
          <RefreshCw className="size-3" />
          Re-check
        </Button>
      </div>
      {record.claims.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {record.claims.map((c, i) => {
            const M = CLAIM_META[c.verdict];
            return (
              <li
                key={i}
                className={cn(
                  "flex items-start gap-2 rounded px-1.5 py-1 text-xs",
                  c.verdict === "contradicted" && "bg-destructive/[0.06]",
                  c.verdict === "unverifiable" && "opacity-70",
                )}
              >
                <M.icon className={cn("mt-0.5 size-3 shrink-0", M.text)} aria-label={M.label} />
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      "text-foreground/90",
                      c.verdict === "contradicted" && "text-destructive",
                    )}
                  >
                    <CodeSpans text={c.text} />
                  </span>
                  {(c.note || c.downgraded) && (
                    <span className="block text-2xs text-muted-foreground">
                      {c.note && <CodeSpans text={c.note} />}
                      {c.downgraded && (
                        <span className="italic">
                          {c.note ? " · " : ""}
                          {c.downgraded}
                        </span>
                      )}
                    </span>
                  )}
                </span>
                {c.path && c.line != null && (
                  <button
                    type="button"
                    onClick={() => onOpenFile(c.path as string, c.line)}
                    className="shrink-0 font-mono text-2xs text-muted-foreground hover:text-foreground"
                  >
                    {c.path.split("/").pop()}:{c.line}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
