import type { StepKind } from "@/lib/guided";
import { AlertTriangle, Compass, HelpCircle, ThumbsUp } from "lucide-react";
import type { ComponentType } from "react";

/** How each stop kind looks: shared by the PR tour and the codebase tour. */
export interface KindMeta {
  icon: ComponentType<{ className?: string }>;
  text: string;
  /** Progress-rail / focus-chip fill for this kind. */
  dot: string;
  label: string;
}

export const KIND: Record<StepKind, KindMeta> = {
  orient: {
    icon: Compass,
    text: "text-muted-foreground",
    dot: "bg-foreground/55",
    label: "Orientation",
  },
  concern: {
    icon: AlertTriangle,
    text: "text-warning",
    dot: "bg-warning",
    label: "Worth a comment",
  },
  question: { icon: HelpCircle, text: "text-info", dot: "bg-info", label: "Question" },
  praise: { icon: ThumbsUp, text: "text-success", dot: "bg-success", label: "Nice" },
};

/** A surface's own words for kinds, over `KIND`'s. The codebase tour calls a
 * `concern` a "Pitfall": there is no PR to comment on, only a trap to warn a
 * newcomer about. */
export type KindLabels = Partial<Record<StepKind, string>>;

export const kindMeta = (kind: StepKind, labels?: KindLabels): KindMeta => {
  const base = KIND[kind] ?? KIND.orient;
  return labels?.[kind] ? { ...base, label: labels[kind] as string } : base;
};
