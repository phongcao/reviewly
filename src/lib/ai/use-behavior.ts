/**
 * The one place a behavior explanation is requested.
 *
 * Three surfaces ask for the same thing — a tour stop, a hunk header, and a
 * diff selection — and they must ask it identically: same prompt, same parse,
 * same failure handling. A shared hook is what keeps "explain behavior" a
 * single feature with three entry points rather than three features that drift.
 *
 * Deliberately holds no result. Each caller owns where the answer is rendered
 * (inline in a step card, inline under a hunk), and the answer stays ephemeral
 * for the reason given in `@/lib/behavior`: it describes the diff as it stands
 * at the moment it was asked.
 */
import { buildBehaviorPrompt } from "@/lib/ai/prompts";
import { type BehaviorDiff, parseBehavior } from "@/lib/behavior";
import { invoke } from "@/lib/tauri";
import { aiInvokeArgs } from "@/stores/ai";
import { useCallback, useState } from "react";
import { toast } from "sonner";

export interface BehaviorRequest {
  path: string;
  line: number;
  endLine?: number;
  /** The file's unified diff. Both sides of the change live here, which is why
   * this works with no local checkout. */
  patch: string | null | undefined;
  /** What to describe: a tour stop's title, or the symbol git names in the hunk
   * header. Omitted for a bare line selection. */
  subject?: string;
}

export function useBehavior(cwd: string | null) {
  const [pending, setPending] = useState<string | null>(null);

  const explain = useCallback(
    async (req: BehaviorRequest, key: string): Promise<BehaviorDiff | null> => {
      // One at a time — but SAY so. Returning null silently here is
      // indistinguishable from a failure at the call site, which is how a
      // dropped click reads to the reviewer as "nothing happened".
      if (pending) {
        toast.info("Still explaining the previous selection — one at a time.");
        return null;
      }
      if (!req.patch) {
        toast.warning(`${req.path} has no diff to explain — it may be binary or too large.`);
        return null;
      }
      setPending(key);
      try {
        const out = await invoke<string>("ai_review", {
          ...aiInvokeArgs(),
          cwd,
          prompt: buildBehaviorPrompt({
            path: req.path,
            line: req.line,
            endLine: req.endLine,
            subject: req.subject,
            patch: req.patch,
            clone: !!cwd,
          }),
        });
        const parsed = parseBehavior(out);
        if (!parsed) toast.error("Couldn't read a behavior summary from the reply.");
        return parsed;
      } catch (e) {
        toast.error(`Behavior summary failed — ${String(e)}`);
        return null;
      } finally {
        setPending(null);
      }
    },
    [cwd, pending],
  );

  return { explain, pending };
}
