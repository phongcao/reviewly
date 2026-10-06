import { BehaviorPanel } from "@/components/behavior-panel";
import { Composer } from "@/components/composer";
import { DiffSelectionToolbar } from "@/components/diff-selection-toolbar";
import { IconButton } from "@/components/icon-button";
import { KiteLoader } from "@/components/kite-loader";
import { MarkdownBody } from "@/components/markdown-body";
import { renderMermaidSvg } from "@/components/mermaid-diagram";
import { TooltipFor } from "@/components/tooltip-for";
import { ClaimRows } from "@/components/tour/claim-rows";
import { CodeSpans } from "@/components/tour/code-spans";
import { GradeLabel, PR_GRADE_HELP } from "@/components/tour/grade";
import { KIND } from "@/components/tour/kinds";
import { type TourProgress, idKeyedProgress } from "@/components/tour/progress";
import { StepHeader } from "@/components/tour/step-header";
import { type StopFilterKind, StopFilters } from "@/components/tour/stop-filters";
import { LayerDivider, TourEnd, TourStepper } from "@/components/tour/tour-chrome";
import { TourRail } from "@/components/tour/tour-rail";
import { useEvent } from "@/components/tour/use-event";
import { useTourNavigation } from "@/components/tour/use-tour-navigation";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { refFromStopNote } from "@/lib/ai/attach";
import { STEP_CAP_SINGLE, shouldFanOut, stepBudget } from "@/lib/ai/budget";
import type { ContextOptions, ReviewContext } from "@/lib/ai/context";
import { maybeSynthesize } from "@/lib/ai/deep-synthesis";
import { useNamesInClone } from "@/lib/ai/name-lookup";
import { CLONE_ABSENT_CLAUSE, buildGuidedSystem } from "@/lib/ai/prompts";
import { useAiAvailable } from "@/lib/ai/use-ai-available";
import { useBehavior } from "@/lib/ai/use-behavior";
import { useDeepTourRunner } from "@/lib/ai/use-deep-tour";
import {
  CHECK_CONCURRENCY,
  pendingClaimChecks,
  useStepCheckRunner,
} from "@/lib/ai/use-step-checks";
import { groundInClone, namesToLookUp, prCorpus, verifyStep, verifySteps } from "@/lib/ai/verify";
import type { BehaviorDiff } from "@/lib/behavior";
import { type CheckRecord, checkTypeFor, stepTrust } from "@/lib/claim-check";
import { type CoverageReport, RISK_LABEL, blindSpots, tourCoverage } from "@/lib/coverage";
import {
  type DeepTourProgress,
  deepTourProgress,
  mergeDeepTour,
  stepId,
  synthesisFresh,
} from "@/lib/deep-tour";
import { anchorWindow } from "@/lib/diff";
import { loadEdgeTexts } from "@/lib/edge-sources";
import { relativeTime } from "@/lib/format";
import {
  type GuidedPlan,
  type GuidedStep,
  type GuidedVerdict,
  type StepKind,
  type TourLayer,
  activeLayerPos,
  layerReadCounts,
  parseTourKey,
  tourLayerIndex,
  verdictDisplay,
} from "@/lib/guided";
import { detectLanguage, highlightLine } from "@/lib/lang";
import { layerEdges, layerMermaid } from "@/lib/layer-edges";
import { type LayerPlan, heuristicLayers, reconcileLayers } from "@/lib/layers";
import { type SummarySource, buildReviewReport, reportFilename } from "@/lib/report";
import { renderReportHtml } from "@/lib/report-html";
import type { DraftComment, PullFile } from "@/lib/tauri";
import { invoke } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { type AiProvider, PROVIDER_LABEL, aiInvokeArgs, useAiProvider } from "@/stores/ai";
import { type DeepTourEntry, useDeepTour } from "@/stores/deep-tour";
import { useDeepTourGen } from "@/stores/deep-tour-gen";
import { useGuided } from "@/stores/guided";
import { useGuidedGen } from "@/stores/guided-gen";
import { useLayers } from "@/stores/layers";
import { useLocalRepos } from "@/stores/local-repos";
import { useReviewPrefs } from "@/stores/review-prefs";
import { type ReviewEvent, useReviewVerdict } from "@/stores/review-verdict";
import { checksKey, runKey, useStepCheckRuns, useStepChecks } from "@/stores/step-checks";
import { getVersion } from "@tauri-apps/api/app";
import { save } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Compass,
  FileCode,
  FileDown,
  GitCompare,
  Layers,
  ListOrdered,
  MessageSquare,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  ThumbsUp,
  X,
} from "lucide-react";
import {
  type ComponentType,
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

interface Props {
  prKey: string;
  /** Self-contained PR context (metadata + diff) plus the size the model can
   * actually see, which sets how many stops the tour asks for. */
  context: ReviewContext;
  /** Rebuild the context for an arbitrary subset of the PR's files. A deep tour
   * needs one context per layer; going through the owner avoids threading the
   * raw PR detail down here just to call `buildReviewContext` again. */
  buildContext: (subset: PullFile[], opts?: ContextOptions) => ReviewContext;
  files: PullFile[];
  /** Head SHA of the PR right now — used to flag a stale (out-of-date) tour. */
  headSha?: string;
  /** PR title and web URL, for the exported review report. */
  prTitle?: string;
  prUrl?: string;
  /** Add a suggested comment to the pending review. */
  onAddComment: (c: DraftComment) => void;
  /** Post a suggested comment straight to GitHub as an inline review comment. */
  onPostComment?: (c: { path: string; line: number; body: string }) => Promise<void>;
  /** Open a file in the diff (when the reader wants the full context). */
  onOpenFile: (path: string, line?: number) => void;
  /** Report whether the guided reading pane has scrolled past its intro. */
  onScrolledChange?: (scrolled: boolean) => void;
  /** Opens (or focuses) the chat once a highlighted passage is attached. */
  onAskAi?: () => void;
}

/** The tour's suggested verdict → its chip + the review event it seeds. */
const VERDICT_META: Record<
  GuidedVerdict,
  { label: string; event: ReviewEvent; icon: ComponentType<{ className?: string }>; chip: string }
> = {
  approve: {
    label: "Suggests approve",
    event: "APPROVE",
    icon: ThumbsUp,
    chip: "text-success bg-success/12",
  },
  request_changes: {
    label: "Suggests changes",
    event: "REQUEST_CHANGES",
    icon: AlertTriangle,
    chip: "text-warning bg-warning/12",
  },
  comment: {
    label: "Suggests comment",
    event: "COMMENT",
    icon: MessageSquare,
    chip: "text-info bg-info/12",
  },
};

/** Seconds elapsed while `running` is true; resets to 0 when it flips off. */
function useElapsed(running: boolean): number {
  const [secs, setSecs] = useState(0);
  const start = useRef(0);
  useEffect(() => {
    if (!running) {
      setSecs(0);
      return;
    }
    start.current = Date.now();
    setSecs(0);
    const t = setInterval(() => setSecs(Math.round((Date.now() - start.current) / 1000)), 1000);
    return () => clearInterval(t);
  }, [running]);
  return secs;
}

export function GuidedReview({
  prKey,
  context,
  buildContext,
  files,
  headSha,
  prTitle,
  prUrl,
  onAddComment,
  onPostComment,
  onOpenFile,
  onScrolledChange,
  onAskAi,
}: Props) {
  const provider = useAiProvider((s) => s.provider);
  const { available } = useAiAvailable();
  const aiInstructions = useReviewPrefs((s) => s.aiInstructions);
  const localRepos = useLocalRepos((s) => s.repos);
  const entry = useGuided((s) => s.byPr[prKey]);
  const resetPlan = useGuided((s) => s.reset);
  const pending = useGuidedGen((s) => !!s.inFlight[prKey]);
  const genError = useGuidedGen((s) => s.error[prKey]);
  const aiName = PROVIDER_LABEL[provider];

  // Recover the "generating" state if a background tour for this PR is still
  // running after navigating away or refreshing (the Rust task outlives both).
  useEffect(() => {
    invoke<string[]>("ai_inflight")
      .then((keys) => {
        if (keys.includes(prKey)) useGuidedGen.getState().start(prKey);
        // Re-attach to any deep-tour layers the backend is still running. Jobs
        // that were queued but never started are gone (prompts are in-memory
        // only) — the "Continue" button re-derives those from what's stored.
        const mine = keys
          .map(parseTourKey)
          .filter((t): t is { prKey: string; layerId: string } => t?.prKey === prKey)
          .map((t) => t.layerId);
        if (mine.length > 0) useDeepTourGen.getState().adopt(prKey, mine);
      })
      .catch(() => {});
  }, [prKey]);

  // The PR's local clone path (if checked out) — lets the agent read the repo
  // for both the tour and the per-step AI checks.
  const cwd = useMemo(() => {
    const [owner, repo] = prKey.split("#")[0].split("/");
    return localRepos.find((r) => r.owner === owner && r.repo === repo)?.path ?? null;
  }, [prKey, localRepos]);

  const deepEntry = useDeepTour((s) => s.byPr[prKey]);
  const deepGen = useDeepTourGen((s) => s.byPr[prKey]);
  const deepBusy = (deepGen?.running.length ?? 0) > 0 || (deepGen?.queued.length ?? 0) > 0;

  /** The reviewer's custom instructions, as a prompt section. */
  const custom = useMemo(
    () => (aiInstructions.trim() ? `\n\n# Reviewer's instructions\n${aiInstructions.trim()}` : ""),
    [aiInstructions],
  );

  const startDeep = useDeepTourRunner({ prKey, files, headSha, buildContext });

  // Kick off generation in the background task. It keeps running (and lands the
  // result via the app-wide `ai:done` listener) regardless of this component.
  const startSingle = useCallback(() => {
    useGuidedGen.getState().start(prKey);
    invoke("ai_review_bg", {
      key: prKey,
      ...aiInvokeArgs(),
      headSha: headSha ?? "",
      cwd,
      // No local clone → the model sees only the diff; the clause forbids the
      // unverifiable repo-wide claims that produce fabricated false alarms.
      prompt: `${buildGuidedSystem({ steps: stepBudget(context.size), size: context.size })}${custom}${cwd ? "" : CLONE_ABSENT_CLAUSE}\n\n# Pull request\n${context.text}`,
    }).catch((e) => useGuidedGen.getState().fail(prKey, String(e)));
  }, [prKey, headSha, custom, context, cwd]);

  // How many layers a deep tour would cover, kept reactive so the count updates
  // if a layer plan lands while this pane is open. Memoized because the offline
  // fallback walks every file in the PR.
  const layersEntry = useLayers((s) => s.byPr[prKey]);
  const deepLayerCount = useMemo(() => {
    if (files.length === 0) return 0;
    const base = layersEntry?.plan ?? heuristicLayers(files);
    return reconcileLayers(base, files).layers.length;
  }, [layersEntry, files]);

  // The layer partition, for the classic tour's exported report. A whole-PR
  // tour saw every layer, so each is marked toured; the report's coverage
  // section is what says which files it actually reached.
  const classicLayers = useMemo(() => {
    if (!layersEntry?.plan) return undefined;
    const plan = reconcileLayers(layersEntry.plan, files);
    return { plan, toured: new Set(plan.layers.map((l) => l.id)) };
  }, [layersEntry, files]);

  // A PR past the fan-out threshold cannot be covered honestly by one call, so
  // that's the default there. The reviewer can still force either mode.
  const fanOut = shouldFanOut(context.size);
  const start = useCallback(() => {
    if (fanOut) startDeep();
    else startSingle();
  }, [fanOut, startDeep, startSingle]);

  // Auto-start the tour on first open when the reviewer opted in (Settings →
  // Guided tour). Guarded so it fires at most once per PR and never when a tour
  // already exists or is generating.
  const autoStartTour = useReviewPrefs((s) => s.autoStartTour);
  // Tracks the PR we've already auto-started for, so it fires once per PR.
  const autoStartedFor = useRef<string | null>(null);
  useEffect(() => {
    if (autoStartedFor.current === prKey) return;
    // A deep tour already covering this PR (stored or in flight) is a tour —
    // auto-start must not fan out over it a second time.
    if (deepEntry || deepBusy) return;
    if (autoStartTour && !entry && !pending && available === true) {
      autoStartedFor.current = prKey;
      start();
    }
  }, [prKey, autoStartTour, entry, pending, available, start, deepEntry, deepBusy]);

  // Discarding a deep tour throws away real AI spend, so it follows the house
  // rule for destructive-but-recoverable actions (see the AI chat's clear):
  // act immediately, and offer an undo that puts the batches back.
  const startOver = useCallback(() => {
    const snapshot = useDeepTour.getState().byPr[prKey];
    useDeepTourGen.getState().cancelAll(prKey);
    useDeepTour.getState().reset(prKey);
    // With auto-start on, discarding would otherwise fall straight back into
    // the effect above and spend a fresh fan-out on the way out of the click.
    autoStartedFor.current = prKey;
    if (!snapshot) return;
    // Checks live in their own store, keyed by stable step
    // id — and a re-toured layer often yields the very same ids, so without
    // this the fresh tour would open with the old tour's verdicts on it. Only
    // this tour's stops (`<layerId>#…`) go; a classic tour's (`#…`) stay.
    const key = checksKey(prKey, headSha);
    const runs = useStepCheckRuns.getState();
    const running = runs.batch[key];
    if (running) runs.setBatch(key, { ...running, cancelled: true });
    const layerIds = new Set([
      ...snapshot.plan.layers.map((l) => l.id),
      ...Object.keys(snapshot.byLayer),
    ]);
    const forgotten = useStepChecks
      .getState()
      .forget(key, (id) => layerIds.has(id.slice(0, id.indexOf("#"))));
    const layers = Object.keys(snapshot.byLayer).length;
    toast(`Tour discarded — ${layers} layer${layers === 1 ? "" : "s"}`, {
      action: {
        label: "Undo",
        onClick: () => {
          useDeepTour.getState().restore(prKey, snapshot);
          // Newer wins per stop, so a check made since the discard survives.
          useStepChecks.getState().importEntries({ [key]: forgotten });
        },
      },
    });
  }, [prKey, headSha]);

  // Stop a running generation (kills the AI CLI on the backend).
  const cancel = useCallback(() => {
    invoke("ai_cancel", { key: prKey }).catch(() => {});
    useGuidedGen.getState().done(prKey);
  }, [prKey]);

  // The classic tour's progress is stored BY INDEX, which is safe here because
  // its step list is written once and never grows.
  const markSeen = useGuided((s) => s.markSeen);
  const setLastActive = useGuided((s) => s.setLastActive);
  const dismissStep = useGuided((s) => s.dismiss);
  const restoreDismissed = useGuided((s) => s.restoreDismissed);
  const dismissed = entry?.dismissed;
  const lastActive = entry?.lastActive;
  const seen = entry?.seen;
  const progress = useMemo<TourProgress>(
    () => ({
      dismissed: new Set(dismissed ?? []),
      seen: new Set(seen ?? []),
      lastActive: lastActive ?? 0,
      markSeen: (i) => markSeen(prKey, i),
      setLastActive: (i) => setLastActive(prKey, i),
      dismiss: (i) => dismissStep(prKey, i),
      restoreDismissed: () => restoreDismissed(prKey),
    }),
    [prKey, dismissed, seen, lastActive, markSeen, setLastActive, dismissStep, restoreDismissed],
  );

  // A deep tour outranks a classic one: it's strictly more coverage of the same
  // PR, and it's what the reviewer asked for (or what the size triggered).
  if (deepEntry || deepBusy) {
    return (
      <DeepTour
        prKey={prKey}
        entry={deepEntry}
        files={files}
        headSha={headSha}
        prInfo={{ title: prTitle ?? prKey, url: prUrl ?? "" }}
        aiName={aiName}
        onRun={startDeep}
        onStartOver={startOver}
        onSinglePass={() => {
          useDeepTourGen.getState().cancelAll(prKey);
          useDeepTour.getState().reset(prKey);
          startSingle();
        }}
        onAddComment={onAddComment}
        onPostComment={onPostComment}
        onOpenFile={onOpenFile}
        onScrolledChange={onScrolledChange}
        onAskAi={onAskAi}
      />
    );
  }

  if (!entry) {
    return (
      <Intro
        aiName={aiName}
        available={available}
        pending={pending}
        error={genError ?? null}
        onStart={start}
        onCancel={cancel}
        deep={
          deepLayerCount > 1
            ? {
                layers: deepLayerCount,
                nudge: stepBudget(context.size).max >= STEP_CAP_SINGLE,
                onStart: () => startDeep(),
              }
            : undefined
        }
      />
    );
  }

  const stale = !!headSha && !!entry.headSha && entry.headSha !== headSha;

  return (
    <Tour
      prKey={prKey}
      plan={entry.plan}
      provider={entry.provider}
      generatedAt={entry.generatedAt}
      progress={progress}
      stale={stale}
      files={files}
      headSha={headSha}
      report={{
        pr: { title: prTitle ?? prKey, url: prUrl ?? "" },
        type: "classic",
        tourHeadSha: entry.headSha,
        layers: classicLayers,
      }}
      regenerating={pending}
      onRegenerate={() => {
        resetPlan(prKey);
        startSingle();
      }}
      onAddComment={onAddComment}
      onPostComment={onPostComment}
      onOpenFile={onOpenFile}
      onScrolledChange={onScrolledChange}
      onAskAi={onAskAi}
    />
  );
}

/**
 * A tour that was fanned out over the PR's layers: one AI call per layer, merged
 * for display. Total stops are unbounded because they're the sum across layers,
 * and each call only ever had to hold one slice.
 *
 * Batches land independently and out of order, so everything here derives from
 * whatever has arrived: the plan is re-merged on every render, and progress is
 * keyed by stable step id rather than array index, because the step list grows
 * underneath the reviewer while they're reading it.
 */
function DeepTour({
  prKey,
  entry,
  files,
  headSha,
  prInfo,
  aiName,
  onRun,
  onSinglePass,
  onStartOver,
  onAddComment,
  onPostComment,
  onOpenFile,
  onScrolledChange,
  onAskAi,
}: {
  prKey: string;
  entry: DeepTourEntry | undefined;
  files: PullFile[];
  headSha?: string;
  prInfo: { title: string; url: string };
  aiName: string;
  /** (Re)run layers: the ids given, or every layer still missing a tour —
   * `force` redoes the ones already toured too. */
  onRun: (only?: string[], opts?: { force?: boolean }) => void;
  /** Abandon the fan-out and fall back to a single whole-PR call. */
  onSinglePass: () => void;
  /** Throw the tour away and go back to the start (undoable). */
  onStartOver: () => void;
  onAddComment: (c: DraftComment) => void;
  onPostComment?: (c: { path: string; line: number; body: string }) => Promise<void>;
  onOpenFile: (path: string, line?: number) => void;
  onScrolledChange?: (scrolled: boolean) => void;
  onAskAi?: () => void;
}) {
  const gen = useDeepTourGen((s) => s.byPr[prKey]);
  const dismissStep = useDeepTour((s) => s.dismiss);
  const restoreDismissed = useDeepTour((s) => s.restoreDismissed);
  const markSeenStep = useDeepTour((s) => s.markSeen);
  const setLastActive = useDeepTour((s) => s.setLastActive);
  const clearFocus = useDeepTour((s) => s.clearFocus);
  const toggleLayerCollapsed = useDeepTour((s) => s.toggleLayerCollapsed);
  const setLayersCollapsed = useDeepTour((s) => s.setLayersCollapsed);

  const running = gen?.running ?? [];
  const queued = gen?.queued ?? [];
  const busy = useMemo(
    () => new Set([...running, ...queued.map((j) => j.layerId)]),
    [running, queued],
  );
  const failedIds = useMemo(
    () =>
      Object.entries(gen?.errors ?? {})
        .filter(([, v]) => !!v)
        .map(([id]) => id),
    [gen?.errors],
  );

  // Keyed on the partition + the landed batches, NOT on `entry`. The store
  // replaces the entry object every time the reviewer moves the cursor (see
  // `TouredLayers`), and merging on that re-derived the whole tour — and every
  // step object in it — on each click. These two fields change only when a
  // layer actually lands, which is the only time the merge can differ.
  const layerPlan = entry?.plan;
  const byLayer = entry?.byLayer;
  const tourHead = entry?.headSha;
  const synthesis = entry?.synthesis;
  const toured = useMemo(
    () =>
      layerPlan && byLayer ? { plan: layerPlan, byLayer, headSha: tourHead, synthesis } : null,
    [layerPlan, byLayer, tourHead, synthesis],
  );
  const plan = useMemo(() => (toured ? mergeDeepTour(toured, files) : null), [toured, files]);
  const info: DeepTourProgress = useMemo(
    () => deepTourProgress(toured ?? undefined, files, busy),
    [toured, files, busy],
  );

  // Every layer in: write the whole-PR summary from their results. Also covers
  // tours that finished before the synthesis existed, or while the app was
  // closed. `maybeSynthesize` sends at most one call per head and batch set.
  useEffect(() => {
    if (busy.size === 0 && info.missing.length === 0 && info.done.length > 0) {
      maybeSynthesize(prKey);
    }
  }, [busy, info, prKey]);

  // Index ↔ stable id, rebuilt whenever the merged plan changes (see
  // `idKeyedProgress`).
  const ids = useMemo(() => (plan ? plan.steps.map(stepId) : []), [plan]);
  const dismissedIds = entry?.dismissed;
  const seenIds = entry?.seen;
  const lastActiveId = entry?.lastActiveId;
  const collapsedLayerIds = entry?.collapsedLayers;
  const progress = useMemo<TourProgress>(
    () =>
      idKeyedProgress(
        ids,
        {
          dismissed: dismissedIds,
          seen: seenIds,
          lastActiveId,
          collapsedLayers: collapsedLayerIds,
        },
        {
          markSeen: (id) => markSeenStep(prKey, id),
          setLastActive: (id) => setLastActive(prKey, id),
          dismiss: (id) => dismissStep(prKey, id),
          restoreDismissed: () => restoreDismissed(prKey),
          toggleLayerCollapsed: (id) => toggleLayerCollapsed(prKey, id),
          setLayersCollapsed: (ids, c) => setLayersCollapsed(prKey, ids, c),
        },
      ),
    [
      ids,
      dismissedIds,
      seenIds,
      lastActiveId,
      collapsedLayerIds,
      prKey,
      markSeenStep,
      setLastActive,
      dismissStep,
      restoreDismissed,
      toggleLayerCollapsed,
      setLayersCollapsed,
    ],
  );

  // A layer the reviewer explicitly opened from the layered view: jump to its
  // first stop once the batch is in. Only that intent moves the cursor — a
  // layer arriving from "Continue" must not yank the reviewer out of the stop
  // they're reading.
  const focusLayerId = entry?.focusLayerId;
  const focusIndex = useMemo(() => {
    if (!focusLayerId || !plan) return null;
    const i = plan.steps.findIndex((s) => s.layerId === focusLayerId);
    return i >= 0 ? i : null;
  }, [focusLayerId, plan]);
  // The layer landed but produced no stops (or its files left the PR): there is
  // nothing to jump to, so drop the request instead of leaving it pending.
  useEffect(() => {
    if (focusLayerId && focusIndex === null && entry?.byLayer[focusLayerId]) clearFocus(prKey);
  }, [focusLayerId, focusIndex, entry, prKey, clearFocus]);

  const layerTitle = (id: string): string =>
    entry?.plan.layers.find((l) => l.id === id)?.title ?? id;

  // Files belonging to layers that haven't been toured yet. Reconciled against
  // the PR's current files for the same reason `mergeDeepTour` is: the
  // partition was snapshotted when the tour began and the PR has kept moving.
  // Without this the coverage strip would report 8 queued layers as a blind
  // spot and read as an accusation instead of a progress report.
  const pendingPaths = useMemo(() => {
    const out = new Set<string>();
    if (!toured) return out;
    for (const layer of reconcileLayers(toured.plan, files).layers) {
      if (toured.byLayer[layer.id]) continue;
      for (const p of layer.files) out.add(p);
    }
    return out;
  }, [toured, files]);

  // The partition as the report shows it, with which layers have landed.
  const deepLayers = useMemo(
    () =>
      toured
        ? {
            plan: reconcileLayers(toured.plan, files),
            toured: new Set(Object.keys(toured.byLayer)),
          }
        : null,
    [toured, files],
  );

  const strip = (
    <DeepTourStrip
      done={info.done.length}
      total={info.total || entry?.plan.layers.length || 0}
      // The merged list, not the sum of the batches: the merge drops duplicate
      // stops, so the batch sum can read a stop or two high.
      steps={plan?.steps.length ?? info.steps}
      running={running.map(layerTitle)}
      queued={queued.length}
      failed={failedIds.map((id) => ({ id, title: layerTitle(id) }))}
      missing={info.missing}
      onCancel={() => useDeepTourGen.getState().cancelAll(prKey)}
      onRetry={(id) => onRun([id])}
      onContinue={() => onRun(info.missing)}
      onSinglePass={onSinglePass}
      onStartOver={onStartOver}
    />
  );

  // Nothing has landed yet: show the progress on its own rather than an empty
  // tour shell.
  if (!plan || plan.steps.length === 0) {
    return (
      <div className="flex h-full flex-col">
        {strip}
        <div className="flex flex-1 items-center justify-center px-6">
          <p className="max-w-sm text-center text-sm text-muted-foreground">
            {busy.size > 0
              ? `${aiName} is touring each layer in turn. Stops appear here as each one lands.`
              : "No stops yet."}
          </p>
        </div>
      </div>
    );
  }

  const oldest = Object.values(entry?.byLayer ?? {}).sort(
    (a, b) => a.generatedAt - b.generatedAt,
  )[0];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {strip}
      <div className="min-h-0 flex-1">
        <Tour
          prKey={prKey}
          plan={plan}
          provider={oldest?.provider ?? ""}
          generatedAt={oldest?.generatedAt ?? Date.now()}
          progress={progress}
          coverage={{ done: info.done.length, total: info.total }}
          pendingPaths={pendingPaths}
          focusIndex={focusIndex}
          onFocusConsumed={() => clearFocus(prKey)}
          stale={!!headSha && !!entry?.headSha && entry.headSha !== headSha}
          files={files}
          headSha={headSha}
          report={{
            pr: prInfo,
            type: "deep",
            tourHeadSha: entry?.headSha ?? "",
            summarySource: toured && synthesisFresh(toured) ? "deep-synthesis" : "layer-planner",
            layers: deepLayers ?? undefined,
          }}
          regenerating={busy.size > 0}
          onRegenerate={() => onRun(undefined, { force: true })}
          onAddComment={onAddComment}
          onPostComment={onPostComment}
          onOpenFile={onOpenFile}
          onScrolledChange={onScrolledChange}
          onAskAi={onAskAi}
        />
      </div>
    </div>
  );
}

/** The layer-by-layer progress bar above a deep tour. */
function DeepTourStrip({
  done,
  total,
  steps,
  running,
  queued,
  failed,
  missing,
  onCancel,
  onRetry,
  onContinue,
  onSinglePass,
  onStartOver,
}: {
  done: number;
  total: number;
  steps: number;
  running: string[];
  queued: number;
  failed: { id: string; title: string }[];
  missing: string[];
  onCancel: () => void;
  onRetry: (layerId: string) => void;
  onContinue: () => void;
  onSinglePass: () => void;
  onStartOver: () => void;
}) {
  const busy = running.length > 0 || queued > 0;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-hairline px-3 py-1.5 text-xs">
      <span className="inline-flex items-center gap-1.5 font-medium text-foreground/80">
        <Layers className="size-3.5 text-primary" />
        Layer {Math.min(done + running.length, total)} of {total}
      </span>
      <span className="text-muted-foreground">
        {steps} stop{steps === 1 ? "" : "s"} so far
      </span>
      {busy && (
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <Spinner className="size-3" />
          {running.length > 0 ? running.join(", ") : "queued"}
          {queued > 0 && ` · ${queued} waiting`}
        </span>
      )}
      {failed.map((f) => (
        <button
          key={f.id}
          type="button"
          onClick={() => onRetry(f.id)}
          className="inline-flex items-center gap-1 rounded bg-destructive/12 px-1.5 py-0.5 text-destructive hover:bg-destructive/20"
        >
          <AlertTriangle className="size-3" />
          {f.title} failed · Retry
        </button>
      ))}
      <div className="ml-auto flex items-center gap-1">
        {busy ? (
          <Button size="xs" variant="ghost" onClick={onCancel}>
            <X className="size-3" />
            Stop all
          </Button>
        ) : (
          <>
            {missing.length > 0 && (
              <Button size="xs" variant="ghost" onClick={onContinue}>
                <RefreshCw className="size-3" />
                Continue · {missing.length} left
              </Button>
            )}
            <Button size="xs" variant="ghost" onClick={onSinglePass}>
              Single pass instead
            </Button>
            <Button
              size="xs"
              variant="ghost"
              className="text-muted-foreground hover:text-destructive"
              onClick={onStartOver}
            >
              Start over
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/** Staged status copy so the wait reads as deliberate work, not a dead spinner. */
function tourPhase(elapsed: number): string {
  if (elapsed < 8) return "Reading the whole diff…";
  if (elapsed < 20) return "Mapping how the changes connect…";
  if (elapsed < 40) return "Finding what's worth a comment…";
  return "Ordering your tour…";
}

function Intro({
  aiName,
  available,
  pending,
  error,
  onStart,
  onCancel,
  deep,
}: {
  aiName: string;
  available: boolean | undefined;
  pending: boolean;
  error: string | null;
  onStart: () => void;
  onCancel?: () => void;
  /** The unbounded, layer-by-layer alternative. `nudge` is set when this PR is
   * big enough that a single pass will hit its step ceiling. */
  deep?: { layers: number; nudge: boolean; onStart: () => void };
}) {
  const elapsed = useElapsed(pending);
  const unavailable = available === false;
  const hasInstructions = useReviewPrefs((s) => s.aiInstructions.trim().length > 0);

  // The kite is alive by *physics*, not a canned path: a spring tugs it by its
  // line toward the cursor (lag + overshoot = the feel of being pulled), and
  // when the mouse is idle it drifts gently on its own. Each frame we also draw
  // the slack flying line from the kite's (now-moved) bridle to the cursor.
  // Refs (not state) so none of this re-renders React.
  const panelRef = useRef<HTMLDivElement>(null);
  const homeRef = useRef<HTMLDivElement>(null);
  const kiteRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<SVGCircleElement>(null);
  const stringRef = useRef<SVGPathElement>(null);
  const cursorRef = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const pos = { x: 0, y: 0 };
    const vel = { x: 0, y: 0 };
    // Organic idle wander: ease toward a fresh random point every ~2–4s, so the
    // kite drifts like a light breeze instead of tracing a repeating sine.
    const wander = { fromX: 0, fromY: 0, toX: 0, toY: 0, start: 0, dur: 0, next: 0 };
    const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const kite = kiteRef.current;
      const home = homeRef.current;
      const panel = panelRef.current;
      if (!kite || !home || !panel) return;
      const pr = panel.getBoundingClientRect();
      const hr = home.getBoundingClientRect();
      const hx = hr.left + hr.width / 2 - pr.left;
      const hy = hr.top + hr.height / 2 - pr.top;
      const cur = cursorRef.current;
      const t = performance.now() / 1000;

      // Target offset from home: pulled toward the cursor on a leash (≤72px),
      // or a gentle idle wander when there's no cursor.
      let tx: number;
      let ty: number;
      if (cur) {
        const rx = cur.x - hx;
        const ry = cur.y - hy;
        const d = Math.hypot(rx, ry) || 1;
        const reach = Math.min(d, 72);
        tx = (rx / d) * reach + Math.sin(t * 1.4) * 2.5;
        ty = (ry / d) * reach + Math.cos(t * 1.8) * 2.5;
      } else {
        if (t >= wander.next) {
          wander.fromX = wander.toX;
          wander.fromY = wander.toY;
          wander.toX = (Math.random() * 2 - 1) * 13;
          wander.toY = (Math.random() * 2 - 1) * 10;
          wander.start = t;
          wander.dur = 1.6 + Math.random() * 2.2;
          wander.next = t + wander.dur;
        }
        const k = clamp((t - wander.start) / (wander.dur || 1), 0, 1);
        const e = k * k * (3 - 2 * k); // smoothstep between drift points
        tx = wander.fromX + (wander.toX - wander.fromX) * e + Math.sin(t * 3.1) * 1.2;
        ty = wander.fromY + (wander.toY - wander.fromY) * e + Math.cos(t * 2.7) * 1;
        // The occasional gust — a small kick the spring soaks up as a sway.
        if (Math.random() < 0.006) {
          vel.x += (Math.random() * 2 - 1) * 1.7;
          vel.y += (Math.random() * 2 - 1) * 1.3;
        }
      }

      // Spring toward the target with damping → lag and a little overshoot.
      vel.x = (vel.x + (tx - pos.x) * 0.045) * 0.87;
      vel.y = (vel.y + (ty - pos.y) * 0.045) * 0.87;
      pos.x += vel.x;
      pos.y += vel.y;
      // Face the pull: tilt toward the side the line is tugging it (kite→cursor
      // horizontal), plus a little of its own velocity for life.
      const aim = cur ? clamp((cur.x - (hx + pos.x)) / 50, -1, 1) * 28 : 0;
      const bank = clamp(aim + vel.x * 0.8, -34, 34);
      kite.style.transform = `translate(${pos.x.toFixed(2)}px, ${pos.y.toFixed(2)}px) rotate(${bank.toFixed(2)}deg)`;

      // Flying line: slack curve from the moved bridle to the cursor.
      const path = stringRef.current;
      const anchor = anchorRef.current;
      if (!path) return;
      if (!cur || !anchor) {
        path.setAttribute("opacity", "0");
        return;
      }
      const a = anchor.getBoundingClientRect();
      const ax = a.left + a.width / 2 - pr.left;
      const ay = a.top + a.height / 2 - pr.top;
      const sag = Math.min(44, Math.max(6, Math.hypot(cur.x - ax, cur.y - ay) * 0.16));
      path.setAttribute(
        "d",
        `M${ax} ${ay} Q${(ax + cur.x) / 2} ${(ay + cur.y) / 2 + sag} ${cur.x} ${cur.y}`,
      );
      path.setAttribute("opacity", "0.55");
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      ref={panelRef}
      onMouseMove={(e) => {
        const r = panelRef.current?.getBoundingClientRect();
        if (r) cursorRef.current = { x: e.clientX - r.left, y: e.clientY - r.top };
      }}
      onMouseLeave={() => {
        cursorRef.current = null;
      }}
      className="relative flex h-full flex-col items-center justify-center gap-4 p-8 text-center"
    >
      {/* Blueprint dot-grid for a restrained "labs" feel. */}
      <div aria-hidden className="lab-grid pointer-events-none absolute inset-0 opacity-60" />

      {/* Flying line: a slack string from the kite's bridle to the cursor. Sits
          below the z-10 content, so it emerges from behind the kite. */}
      <svg aria-hidden className="pointer-events-none absolute inset-0 size-full overflow-visible">
        <path
          ref={stringRef}
          fill="none"
          stroke="#7a5a3a"
          strokeWidth={1.5}
          strokeLinecap="round"
          opacity={0}
        />
      </svg>

      {/* Emblem: the brand kite, flown by physics. homeRef is its fixed rest
          slot (never transformed — the spring measures from here); kiteRef is
          the moved kite. It wanders gently on its own and is tugged by its line
          toward the cursor. */}
      <div ref={homeRef} className="relative z-10 flex h-36 w-24 items-center justify-center">
        <div ref={kiteRef} className="will-change-transform">
          <KiteLoader anchorRef={anchorRef} className="h-36 w-24" />
        </div>
      </div>

      <div className="z-10 flex flex-col items-center gap-2.5">
        <h2 className="font-display text-lg text-foreground">Guided tour</h2>
        {!pending && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Compass className="size-3.5 text-primary" />
              Reads the PR
            </span>
            <ChevronRight className="size-3 text-muted-foreground/40" />
            <span className="inline-flex items-center gap-1.5">
              <ListOrdered className="size-3.5 text-primary" />
              Orders it
            </span>
            <ChevronRight className="size-3 text-muted-foreground/40" />
            <span className="inline-flex items-center gap-1.5">
              <MessageSquare className="size-3.5 text-primary" />
              Flags what matters
            </span>
          </div>
        )}
      </div>

      <div className="z-10 flex min-h-[3rem] flex-col items-center justify-center gap-1">
        {pending ? (
          <>
            <p className="text-sm font-medium text-foreground/80">{tourPhase(elapsed)}</p>
            <p className="font-mono text-xs text-muted-foreground/70">
              reading locally · {elapsed}s{elapsed >= 60 ? " · almost there" : ""}
            </p>
            {onCancel && (
              <Button size="xs" variant="ghost" onClick={onCancel} className="mt-1.5">
                <X className="size-3" />
                Stop
              </Button>
            )}
          </>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={onStart} disabled={unavailable}>
                <Sparkles className="size-3.5" />
                Start guided tour
              </Button>
              {deep && (
                <Button
                  size="sm"
                  variant={deep.nudge ? "default" : "outline"}
                  onClick={deep.onStart}
                  disabled={unavailable}
                >
                  <Layers className="size-3.5" />
                  Deep tour · {deep.layers} layers
                </Button>
              )}
            </div>
            {deep?.nudge && (
              <p className="max-w-sm text-center text-2xs text-muted-foreground">
                This PR is large enough that a single pass will cap out — a deep tour covers it
                layer by layer, with no limit on stops.
              </p>
            )}
          </div>
        )}
      </div>

      {unavailable && !pending && (
        <p className="z-10 max-w-sm text-xs text-warning">
          The <span className="font-medium">{aiName.toLowerCase()}</span> CLI wasn't found on your
          PATH. Install it, or switch the provider in Settings.
        </p>
      )}
      {error && !pending && <p className="z-10 max-w-sm text-xs text-destructive">{error}</p>}
      {hasInstructions && (
        <p className="z-10 inline-flex items-center gap-1 text-2xs text-muted-foreground/60">
          <Sparkles className="size-3" />
          Using your custom review instructions
        </p>
      )}
    </div>
  );
}

/**
 * What the tour did not look at.
 *
 * The tour's own counters ("28 stops", "Layer 2 of 10") describe the work that
 * was done, and a reviewer reads them as if they described the PR. They don't:
 * the per-layer step budget means a large PR cannot get a stop on every file,
 * so a confident, well-anchored tour can still leave real code unexamined. That
 * gap is invisible — which makes it the one failure mode a reviewer cannot
 * catch by reading more carefully.
 *
 * So the headline here is coverage of CHANGED LINES, not a count of stops, and
 * queued layers are reported separately from genuine gaps: an in-flight deep
 * tour is incomplete, not negligent.
 */
function CoverageStrip({
  cov,
  onOpenFile,
}: {
  cov: CoverageReport;
  onOpenFile: (path: string, line?: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const gaps = useMemo(() => blindSpots(cov), [cov]);
  const totalChurn = Object.values(cov.churn).reduce((a, b) => a + b, 0);
  if (totalChurn === 0) return null;

  // Queued layers are not yet a verdict on anything, so they are excluded from
  // the denominator's claim rather than counted as read or as missed.
  const analyzed = cov.churn.toured;
  const pct = Math.round((analyzed / totalChurn) * 100);
  const risky = cov.atRisk.length;

  return (
    <div className="px-5 pt-2.5">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-2xs text-muted-foreground">
        <span className="text-muted-foreground/60">Coverage</span>
        <span className="font-medium tabular-nums text-foreground/80">
          {analyzed.toLocaleString()} of {totalChurn.toLocaleString()} changed lines ({pct}%)
        </span>
        {cov.counts.pending > 0 && (
          <span className="tabular-nums">· {cov.counts.pending} files queued</span>
        )}
        {cov.counts.skippable + cov.counts.tests > 0 && (
          <span className="tabular-nums">
            · {cov.counts.skippable + cov.counts.tests} skippable
          </span>
        )}
        {gaps.length > 0 ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium transition-colors",
              risky > 0
                ? "bg-warning/12 text-warning hover:bg-warning/20"
                : "bg-foreground/5 text-foreground/70 hover:bg-foreground/10",
            )}
          >
            {risky > 0 && <AlertTriangle className="size-3" />}
            {gaps.length} file{gaps.length === 1 ? "" : "s"} with no stop
            {risky > 0 && ` · ${risky} sensitive`}
            <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
          </button>
        ) : (
          cov.counts.pending === 0 && (
            <span className="inline-flex items-center gap-1 text-success">
              <Check className="size-3" />
              every changed file has a stop
            </span>
          )
        )}
      </div>

      {open && gaps.length > 0 && (
        <ul className="mt-1.5 space-y-px rounded-lg bg-foreground/[0.03] p-1.5">
          {gaps.map((g) => (
            <li key={g.file.filename}>
              <button
                type="button"
                onClick={() => onOpenFile(g.file.filename)}
                className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-2xs transition-colors hover:bg-foreground/5"
              >
                <FileCode className="size-3 shrink-0 text-muted-foreground/60" />
                <span className="min-w-0 flex-1 truncate font-mono text-foreground/80">
                  {g.file.filename}
                </span>
                {g.risks.map((r) => (
                  <span
                    key={r}
                    className="shrink-0 rounded-full bg-warning/12 px-1.5 py-px font-medium text-warning"
                  >
                    {RISK_LABEL[r]}
                  </span>
                ))}
                <span className="shrink-0 tabular-nums text-muted-foreground/60">
                  {g.file.changes.toLocaleString()}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Tour({
  prKey,
  plan,
  provider,
  generatedAt,
  progress,
  coverage,
  pendingPaths,
  focusIndex,
  onFocusConsumed,
  stale,
  files,
  headSha,
  report,
  regenerating,
  onRegenerate,
  onAddComment,
  onPostComment,
  onOpenFile,
  onScrolledChange,
  onAskAi,
}: {
  prKey: string;
  plan: GuidedPlan;
  /** Which AI produced the tour (an `AiProvider` id). */
  provider: string;
  /** Epoch ms the tour was generated. */
  generatedAt: number;
  progress: TourProgress;
  /**
   * How much of the PR the plan actually covers, for a tour assembled layer by
   * layer. Omitted for a single-pass tour, which always saw the whole PR (up to
   * the diff budget) in one call.
   */
  coverage?: { done: number; total: number };
  /** Files belonging to layers that haven't been toured yet, so the coverage
   * strip reports a queued layer as queued rather than as a gap. */
  pendingPaths?: ReadonlySet<string>;
  /** A stop to jump to once, on the reviewer's explicit request (opening one
   * layer of a deep tour). Null on every other render. */
  focusIndex?: number | null;
  /** The jump has been made — the caller should drop the request. */
  onFocusConsumed?: () => void;
  stale: boolean;
  files: PullFile[];
  /** The PR's head right now — what checks are keyed to. */
  headSha?: string;
  /** What the report export needs beyond what the tour pane already holds. */
  report: {
    pr: { title: string; url: string };
    type: "classic" | "deep";
    /** Head the tour was generated on. */
    tourHeadSha: string;
    summarySource?: SummarySource;
    layers?: { plan: LayerPlan; toured: ReadonlySet<string> };
  };
  regenerating: boolean;
  onRegenerate: () => void;
  onAddComment: (c: DraftComment) => void;
  onPostComment?: (c: { path: string; line: number; body: string }) => Promise<void>;
  onOpenFile: (path: string, line?: number) => void;
  onScrolledChange?: (scrolled: boolean) => void;
  /** Opens the chat after a stop's text or code is attached to it. */
  onAskAi?: () => void;
}) {
  const total = plan.steps.length;
  // A "clean bill of health" tour: a summary + verdict but nothing to walk
  // through. The step nav / spine / counter all collapse to just the verdict.
  const noSteps = total === 0;
  // What the tour did NOT look at. Derived at read time from the PR's real
  // files, so it tracks the diff rather than a snapshot taken at generation.
  const cov = useMemo(
    () => tourCoverage(plan.steps, files, pendingPaths),
    [plan.steps, files, pendingPaths],
  );
  const preferPost = useReviewPrefs((s) => s.defaultSuggestionAction === "post");
  // `progress` is rebuilt every time read state changes — i.e. on every stop
  // the reviewer visits — so `dismiss` is taken through `useEvent`, which keeps
  // it usable as a prop on a memoized Step.
  const dismiss = useEvent(progress.dismiss);
  const { restoreDismissed } = progress;
  const localRepos = useLocalRepos((s) => s.repos);
  // The PR's local clone path — gives the per-step AI check real code to read
  // against (the "Check with AI" button only appears when this exists).
  const cwd = useMemo(() => {
    const [owner, repo] = prKey.split("#")[0].split("/");
    return localRepos.find((r) => r.owner === owner && r.repo === repo)?.path ?? null;
  }, [prKey, localRepos]);
  // Checks on single stops, persisted per PR head. A concern check needs the
  // clone; a claim check (orient / praise) holds the stop against its patch and
  // works without one.
  const runner = useStepCheckRunner({ subject: prKey, headSha, files, cwd });
  const checksKey = runner.key;
  const checks = useStepChecks((s) => s.byKey[checksKey]);
  const checkStep = useEvent(async (step: GuidedStep): Promise<void> => {
    try {
      await runner.check(step);
    } catch (e) {
      toast.error(`AI check failed — ${String(e)}`);
    }
  });
  const clearCheck = useEvent((step: GuidedStep) =>
    useStepChecks.getState().clear(checksKey, stepId(step)),
  );
  const batch = useStepCheckRuns((s) => s.batch[checksKey]);
  // What the confirm dialog would send; `layer` when it came from a layer
  // heading rather than the toolbar's whole-tour "Check all".
  const [confirmCheckAll, setConfirmCheckAll] = useState<{
    steps: GuidedStep[];
    layer?: TourLayer;
  } | null>(null);
  // Explain ONE stop's symbol as behavior (before / after / what changed).
  // Unlike the concern check this does NOT require a clone: the file's own
  // patch carries both sides of the change. Shared with the diff viewer's hunk
  // and selection entry points so all three ask the same question.
  const { explain } = useBehavior(cwd);
  // `explain` changes identity whenever a request starts or finishes (it closes
  // over the hook's `pending` guard), so it goes through `useEvent` too — the
  // guard still reads the newest value, it just stops churning Step's props.
  const explainBehavior = useEvent(
    (step: GuidedStep): Promise<BehaviorDiff | null> =>
      explain(
        {
          path: step.path,
          line: step.line,
          endLine: step.endLine,
          subject: step.title,
          patch: files.find((f) => f.filename === step.path)?.patch,
        },
        `${step.path}:${step.line}`,
      ),
  );
  // Open a step's file — but only if it's actually part of this PR. A tour can
  // occasionally name a path that isn't in the diff (a stale or mistaken
  // reference); opening that would land on nothing, so warn instead.
  const openStep = useEvent((path: string, line?: number) => {
    if (!files.some((f) => f.filename === path)) {
      toast.warning(`${path} isn't a file in this PR — it may be a stale or mistaken reference.`);
      return;
    }
    onOpenFile(path, line);
  });
  // Page-level inline arrow, so it goes through `useEvent` like the rest.
  const askAi = useEvent(() => onAskAi?.());
  const [posted, setPosted] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState<StepKind | null>(null);
  // Narrow the tour to the stops that need something, from the header counts.
  // Holds the set taken when the filter was turned on, so a stop checked under
  // it stays in view (showing its new chip) instead of vanishing mid-read.
  const [stopFilter, setStopFilter] = useState<{
    kind: StopFilterKind;
    ids: Set<number>;
  } | null>(null);
  const [tourScrolled, setTourScrolled] = useState(false);
  // 82: lets the reviewer keep a stale tour — acknowledges staleness and hides
  // the banner without discarding the (still useful) walkthrough.
  const [staleAck, setStaleAck] = useState(false);
  const scrolledRef = useRef(false);

  // Every changed line in the PR, joined once for the whole tour. Each stop's
  // grounding check needs this window, and `verifyClaim` builds it itself when
  // it isn't given one — which on a 200-stop tour meant concatenating the
  // entire diff (megabytes) once per stop, per render. Hoisting it is what the
  // function's `corpus` parameter is for.
  const corpus = useMemo(() => prCorpus(files), [files]);

  // Posting one stop's comment straight to GitHub. Split in two so it can be
  // both stable and absent: Step keys the whole post-vs-add affordance off
  // whether this prop is undefined, while the handler itself must not change
  // identity — the page passes an inline arrow, and any render of it would
  // otherwise re-render every mounted stop.
  const postComment = useEvent((step: GuidedStep, body: string) =>
    onPostComment ? onPostComment({ path: step.path, line: step.line, body }) : Promise.resolve(),
  );
  const postStep = onPostComment ? postComment : undefined;

  // Stops the reviewer dismissed (handled questions / concerns) are hidden.
  const dismissedSet = progress.dismissed;

  // Per-kind counts (of the *remaining* stops) → which "focus" chips to show.
  const counts = useMemo(() => {
    const c: Record<StepKind, number> = { orient: 0, concern: 0, question: 0, praise: 0 };
    plan.steps.forEach((s, i) => {
      if (!dismissedSet.has(i)) c[s.kind]++;
    });
    return c;
  }, [plan.steps, dismissedSet]);
  const kindsPresent = useMemo(
    () => (["orient", "concern", "question", "praise"] as StepKind[]).filter((k) => counts[k] > 0),
    [counts],
  );
  // Every stop's grade against the diff, once per tour. A stop that failed
  // only because it names something outside the diff gets a second chance
  // against the local clone: with a clone the tour reads files the PR doesn't
  // touch, and those names are real (see `groundInClone`).
  const baseEvidence = useMemo(
    () => verifySteps(plan.steps, files, corpus).map((v) => v.evidence),
    [plan.steps, files, corpus],
  );
  const lookupNames = useMemo(() => namesToLookUp(baseEvidence), [baseEvidence]);
  const cloneNames = useNamesInClone(cwd, headSha ?? "", lookupNames);
  const evidenceAt = useMemo(
    () => baseEvidence.map((e) => groundInClone(e, cloneNames)),
    [baseEvidence, cloneNames],
  );

  // Not dismissed, and of the focused kind — what the header counts describe.
  // The stop filter is applied after, so its own counts don't collapse to the
  // one set that's selected.
  const inKind = useMemo(
    () =>
      plan.steps
        .map((_, i) => i)
        .filter((i) => !dismissedSet.has(i) && (!filter || plan.steps[i].kind === filter)),
    [plan.steps, filter, dismissedSet],
  );
  // The stops that still need the reviewer, by trust: a check disputed them,
  // their anchor didn't hold up, or they are unchecked (never checked, or
  // the check came back partial).
  const needs = useMemo(() => {
    const out: Record<StopFilterKind, number[]> = { disputed: [], unverified: [], unchecked: [] };
    for (const i of inKind) {
      const e = evidenceAt[i];
      if (!e) continue;
      const trust = stepTrust(e.grade, checks?.[stepId(plan.steps[i])]);
      if (trust === "contradicted") out.disputed.push(i);
      else if (trust === "unanchored") out.unverified.push(i);
      else if (trust === "unchecked") out.unchecked.push(i);
    }
    return out;
  }, [inKind, evidenceAt, plan.steps, checks]);
  const needCounts = useMemo(
    () => ({
      disputed: needs.disputed.length,
      unverified: needs.unverified.length,
      unchecked: needs.unchecked.length,
    }),
    [needs],
  );

  // Original-index list of the steps currently in view.
  const visible = useMemo(
    () => (stopFilter ? inKind.filter((i) => stopFilter.ids.has(i)) : inKind),
    [inKind, stopFilter],
  );

  const { active, pos, atFirst, atLast, move, jumpTo, scrollRef, setStepRef } = useTourNavigation({
    visible,
    initial: Math.max(0, Math.min(progress.lastActive, total - 1)),
    // Persist resume position + mark the visited step as seen.
    onActive: (i) => {
      progress.markSeen(i);
      progress.setLastActive(i);
    },
    onOpen: (i) => {
      const step = plan.steps[i];
      if (step) openStep(step.path, step.line);
    },
    onDismiss: dismiss,
  });

  // What "Check all" would send right now: visible orient / praise stops with
  // no check yet. Concerns are left to their own, clone-backed button.
  const inFlight = useStepCheckRuns((s) => s.inFlight);
  const uncheckedClaims = useMemo(
    () =>
      pendingClaimChecks(
        visible.map((i) => plan.steps[i]),
        checks,
        (id) => !!inFlight[runKey(checksKey, id)],
      ),
    [visible, plan.steps, checks, inFlight, checksKey],
  );
  // The same set split by layer, for the per-layer "Check layer" actions. The
  // toolbar scrolls away; a reviewer deep in layer 5 checks from where they are.
  const uncheckedByLayer = useMemo(() => {
    const by = new Map<string, GuidedStep[]>();
    for (const s of uncheckedClaims) {
      if (!s.layerId) continue;
      const list = by.get(s.layerId);
      if (list) list.push(s);
      else by.set(s.layerId, [s]);
    }
    return by;
  }, [uncheckedClaims]);
  // Layers with a check running on any of their stops — a heading shows a
  // spinner in place of its check action.
  const checkingLayers = useMemo(() => {
    const ids = new Set<string>();
    for (const i of visible) {
      const s = plan.steps[i];
      if (s.layerId && inFlight[runKey(checksKey, stepId(s))]) ids.add(s.layerId);
    }
    return ids;
  }, [visible, plan.steps, inFlight, checksKey]);
  // Export the tour as a self-contained HTML review report. Works on a
  // partial deep tour; the report says it is partial.
  const [exporting, setExporting] = useState(false);

  async function exportReport() {
    if (exporting) return;
    setExporting(true);
    try {
      // Layer links for the report and its diagram, read the same way the
      // layered view reads them. The SVG is rendered here, in the app, so the
      // exported page itself stays script-free.
      let edges: ReturnType<typeof layerEdges> | undefined;
      let diagramSvg: string | undefined;
      if (report.layers) {
        const src = await loadEdgeTexts(files, cwd);
        edges = layerEdges(report.layers.plan, src.texts, src.aliases);
        if (edges.length > 0) {
          diagramSvg = await renderMermaidSvg(layerMermaid(report.layers.plan, edges)).catch(
            () => undefined,
          );
        }
      }
      const r = buildReviewReport({
        pr: { key: prKey, title: report.pr.title, url: report.pr.url, headSha: headSha ?? "" },
        plan,
        tour: {
          type: report.type,
          headSha: report.tourHeadSha,
          summarySource: report.summarySource,
          provider,
          generatedAt,
          ...(coverage ? { layersToured: coverage } : {}),
        },
        layers: report.layers,
        edges,
        files,
        checks,
        cloneNames,
        dismissedIds: new Set([...progress.dismissed].map((i) => stepId(plan.steps[i]))),
        pendingPaths,
        exportedAt: Date.now(),
        app: await getVersion().catch(() => "unknown"),
      });
      const path = await save({
        title: "Export review report",
        defaultPath: reportFilename(r),
        filters: [{ name: "HTML page", extensions: ["html"] }],
      });
      if (!path) return;
      await invoke("write_bundle", { path, contents: renderReportHtml(r, { diagramSvg }) });
      toast.success(`Report exported to ${path.split(/[\\/]/).pop()}`);
    } catch (e) {
      toast.error(`Export failed — ${String(e)}`);
    } finally {
      setExporting(false);
    }
  }

  const checkAllCount = confirmCheckAll?.steps.length ?? 0;
  async function runCheckAll(steps: GuidedStep[]) {
    const r = await runner.checkAll(steps);
    if (r.failed > 0) toast.error(`${r.failed} of ${r.done} checks failed`);
    else if (r.cancelled) toast(`Stopped after ${r.done} check${r.done === 1 ? "" : "s"}`);
  }

  // Layer headings, counts and the rail's per-layer runs for a merged deep tour.
  const layerIndex = useMemo(
    () => tourLayerIndex(visible, plan.steps, plan.layers),
    [visible, plan.steps, plan.layers],
  );
  const { layerHeads, layerCounts } = layerIndex;
  // Read stops per layer — what a folded heading reports in place of its rows.
  const layerDone = useMemo(
    () => layerReadCounts(visible, plan.steps, progress.seen),
    [visible, plan.steps, progress.seen],
  );
  const { activeLayer, layerPos } = activeLayerPos(
    layerIndex.layerById,
    visible,
    plan.steps,
    active,
  );

  // The tour controller folds away once the reader scrolls into the stops.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `scrollRef` is the navigation hook's stable ref
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;

    function syncScrolled() {
      if (!root) return;
      const next = root.scrollTop > 12;
      if (next === scrolledRef.current) return;
      scrolledRef.current = next;
      setTourScrolled(next);
      onScrolledChange?.(next);
    }

    syncScrolled();
    root.addEventListener("scroll", syncScrolled, { passive: true });
    return () => {
      root.removeEventListener("scroll", syncScrolled);
      scrolledRef.current = false;
      setTourScrolled(false);
      onScrolledChange?.(false);
    };
  }, [onScrolledChange]);

  const addComment = useEvent((step: GuidedStep, idx: number, body: string) => {
    if (!body.trim()) return;
    onAddComment({ path: step.path, line: step.line, body: body.trim(), side: "RIGHT" });
    setPosted((s) => new Set(s).add(idx));
  });

  const setLastVerdict = useReviewVerdict((s) => s.setLast);
  const verdict = plan.verdict ? VERDICT_META[plan.verdict] : null;

  // A deep tour's verdict is folded from the layers that have LANDED, so an
  // early "Suggests approve" can speak for a fraction of the PR. `verdictDisplay`
  // owns that decision — see its comment for why approve is treated unlike the
  // other two.
  const display = verdictDisplay(plan.verdict, coverage);
  const partial = display.partial;
  const verdictLabel = verdict
    ? partial
      ? `${verdict.label} · ${partial.done} of ${partial.total} layers`
      : verdict.label
    : "";
  const verdictTitle = partial
    ? `Folded from the ${partial.done} layer${partial.done === 1 ? "" : "s"} toured so far. ${
        partial.total - partial.done
      } still untoured — this is not a verdict on the whole PR.`
    : undefined;

  const withheldApprove = display.kind === "withheld";
  const suggestionIdxs = useMemo(
    () => visible.filter((i) => !!plan.steps[i].suggestion),
    [visible, plan.steps],
  );

  // An explicitly requested stop (the reviewer opened one layer of a deep tour).
  // `active` is seeded once from the resume point, so a later request has to
  // move it here. The ref makes the jump idempotent: `onFocusConsumed` is an
  // inline callback, so without it a parent re-render before the request
  // clears would drag the cursor back off whatever the reviewer moved to.
  const consumedFocus = useRef<number | null>(null);
  useEffect(() => {
    if (focusIndex == null || focusIndex >= plan.steps.length) {
      if (focusIndex == null) consumedFocus.current = null;
      return;
    }
    if (consumedFocus.current === focusIndex) return;
    consumedFocus.current = focusIndex;
    // A kind filter would hide the stop we were asked to open (and the
    // snap-to-visible effect would immediately pull the cursor elsewhere).
    setFilter(null);
    setStopFilter(null);
    jumpTo(focusIndex);
    onFocusConsumed?.();
  }, [focusIndex, plan.steps.length, jumpTo, onFocusConsumed]);

  // Promote every (undismissed) suggested comment into the pending review at
  // once, and seed the suggested verdict so the submit popover opens on it.
  function draftAsReview() {
    const fresh = suggestionIdxs.filter((i) => !posted.has(i));
    for (const i of fresh) {
      const s = plan.steps[i];
      if (s.suggestion) addComment(s, i, s.suggestion);
    }
    // Seeding APPROVE from a partial tour is the actual hazard the withheld
    // chip exists to avoid — a label that says one thing while the Submit
    // dialog is pre-set to another would be worse than saying nothing.
    if (plan.verdict && display.seed) setLastVerdict(VERDICT_META[plan.verdict].event);
    toast.success(
      fresh.length > 0
        ? `${fresh.length} comment${fresh.length === 1 ? "" : "s"} added to your review`
        : "All suggestions are already in your review",
      {
        description: withheldApprove
          ? `${partial?.done} of ${partial?.total} layers read clean — tour the rest before approving`
          : verdict
            ? `${verdictLabel.replace("Suggests", "Suggested verdict:")} — open Submit to finish`
            : "Open Submit to finish",
      },
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* tour controller */}
      <div
        className={cn(
          "overflow-hidden border-b border-hairline transition-[max-height,opacity,transform,padding] duration-300 ease-out motion-reduce:transition-none",
          tourScrolled
            ? "pointer-events-none max-h-0 -translate-y-1 px-5 py-0 opacity-0"
            : "max-h-28 translate-y-0 px-5 py-2.5 opacity-100",
        )}
        aria-hidden={tourScrolled}
      >
        <div
          className={cn(
            "transition-opacity duration-200 ease-out motion-reduce:transition-none",
            tourScrolled ? "opacity-0" : "opacity-100",
          )}
        >
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Sparkles className="size-3.5 shrink-0 text-muted-foreground" />
              <span>Guided tour</span>
            </div>
            {!noSteps && (
              <StopFilters
                counts={needCounts}
                active={stopFilter?.kind ?? null}
                onChange={(kind) =>
                  setStopFilter(kind ? { kind, ids: new Set(needs[kind]) } : null)
                }
              />
            )}
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {!noSteps && (
                <TourStepper
                  activeLayer={activeLayer}
                  layerPos={layerPos}
                  layerCount={activeLayer ? (layerCounts.get(activeLayer.id) ?? 0) : 0}
                  pos={pos}
                  total={visible.length}
                  atFirst={atFirst}
                  atLast={atLast}
                  onMove={move}
                />
              )}
              {batch ? (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={runner.cancelAll}
                  disabled={batch.cancelled}
                  title="Stop after the checks already running"
                >
                  <Spinner className="size-3" />
                  {batch.done} / {batch.total} checked
                  <X className="size-3" />
                </Button>
              ) : (
                uncheckedClaims.length > 0 && (
                  <TooltipFor label="Check every unchecked orientation and praise stop with AI, claim by claim">
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => setConfirmCheckAll({ steps: uncheckedClaims })}
                    >
                      <ShieldCheck className="size-3" />
                      Check all
                    </Button>
                  </TooltipFor>
                )
              )}
              <IconButton
                label="Export report"
                icon={FileDown}
                loading={exporting}
                onClick={() => void exportReport()}
              />
              <IconButton
                label="Regenerate tour"
                icon={RefreshCw}
                loading={regenerating}
                onClick={onRegenerate}
              />
            </div>
          </div>
          {plan.summary && (
            <p className="mt-1.5 text-xs leading-relaxed text-foreground/80 line-clamp-2">
              <CodeSpans text={plan.summary} />
            </p>
          )}
        </div>
      </div>

      {/* staleness / provenance banner */}
      {stale && !staleAck ? (
        // 82: offer Keep / Regenerate rather than forcing a regenerate (which
        // would discard the current walkthrough on a single click).
        <div className="flex items-center gap-2 bg-warning/10 px-5 py-1.5 text-xs text-warning">
          <RefreshCw className="size-3 shrink-0" />
          <span className="min-w-0 flex-1">The diff changed since this tour was generated.</span>
          <Button
            size="xs"
            variant="ghost"
            className="shrink-0 text-warning hover:text-warning"
            onClick={() => setStaleAck(true)}
          >
            Keep
          </Button>
          <Button size="xs" variant="ghost" className="shrink-0" onClick={onRegenerate}>
            Regenerate
          </Button>
        </div>
      ) : (
        <div className="px-5 pt-2">
          <div className="flex items-center gap-2">
            <p className="min-w-0 truncate text-xs text-muted-foreground/70">
              Toured by {PROVIDER_LABEL[provider as AiProvider] ?? provider} ·{" "}
              {relativeTime(new Date(generatedAt).toISOString())}
            </p>
            {(verdict || suggestionIdxs.length > 0) && (
              <div className="ml-auto flex shrink-0 items-center gap-2">
                {withheldApprove && partial ? (
                  <span
                    className="inline-flex items-center gap-1.5 rounded-full bg-foreground/[0.06] px-2.5 py-1 text-2xs font-medium text-muted-foreground"
                    title={`Every layer toured so far reads clean, but ${
                      partial.total - partial.done
                    } of ${partial.total} are still untoured. Reviewly won't suggest approving a PR it hasn't finished reading.`}
                  >
                    <Layers className="size-3" />
                    {partial.done} of {partial.total} layers read clean
                  </span>
                ) : verdict ? (
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-2xs font-medium",
                      verdict.chip,
                    )}
                    title={verdictTitle}
                  >
                    <verdict.icon className="size-3" />
                    {verdictLabel}
                  </span>
                ) : null}
                {suggestionIdxs.length > 0 && (
                  <Button size="xs" onClick={draftAsReview}>
                    <Sparkles className="size-3" />
                    Draft as review
                  </Button>
                )}
              </div>
            )}
          </div>
          {/* The verdict's one-line rationale — always shown when present, so the
              reviewer sees WHY it's approve / request-changes, not just the chip. */}
          {verdict && plan.verdictReason && (
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              <CodeSpans text={plan.verdictReason} />
            </p>
          )}
        </div>
      )}

      {/* focus chips — narrow the tour to one kind for a fast risk pass */}
      {kindsPresent.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5 px-5 pt-2.5">
          <span className="text-2xs text-muted-foreground/60">Focus</span>
          {kindsPresent.map((k) => {
            const K = KIND[k] ?? KIND.orient;
            const on = filter === k;
            return (
              <button
                key={k}
                type="button"
                onClick={() => setFilter(on ? null : k)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium transition-colors",
                  on
                    ? cn(K.dot, "text-background")
                    : cn("bg-foreground/5 hover:bg-foreground/10", K.text),
                )}
              >
                <K.icon className="size-3" />
                {K.label}
                <span className="tabular-nums opacity-70">{counts[k]}</span>
              </button>
            );
          })}
          {filter && (
            <button
              type="button"
              onClick={() => setFilter(null)}
              className="text-2xs text-muted-foreground transition-colors hover:text-foreground"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {/* What the tour didn't reach — sits with the focus chips because it
          answers the same question they do: where should I look next? */}
      <CoverageStrip cov={cov} onOpenFile={onOpenFile} />

      {/* Timeline spine (the journey at a glance) + the reading pane (the
          focused stop). The spine carries progress on its own — nodes fill in
          the accent up to the active one, which glows — so there's no separate
          progress bar. */}
      <div className="mt-2 flex min-h-0 flex-1">
        {!noSteps && (
          <TourRail
            steps={plan.steps}
            index={layerIndex}
            layerDone={layerDone}
            pos={pos}
            active={active}
            seen={progress.seen}
            activeLayer={activeLayer}
            layerPos={layerPos}
            collapse={progress.collapse}
            onJump={jumpTo}
            layerAction={(layer, hasCursor) => (
              <LayerCheckAction
                layer={layer}
                pending={batch ? undefined : uncheckedByLayer.get(layer.id)}
                checking={checkingLayers.has(layer.id)}
                onCheck={setConfirmCheckAll}
                // Always shown on the layer being read; on hover elsewhere,
                // so six layers don't stack six shields down the rail.
                quiet={!hasCursor}
              />
            )}
          />
        )}

        {/* No top padding here: container padding insets the sticky-stop, leaving
            a gap above the pinned header. The spacer below scrolls away cleanly. */}
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
          <div aria-hidden className="h-4" />
          {plan.tour && (
            <div className="mb-5 rounded-lg bg-card/40 px-3.5 py-3">
              <p className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
                <Compass className="size-4 text-muted-foreground" />
                How to read this PR
              </p>
              <MarkdownBody>{plan.tour}</MarkdownBody>
            </div>
          )}

          {plan.steps.map((step, i) => {
            if (!visible.includes(i)) return null;
            const stop = (
              <Step
                key={i}
                setRef={setStepRef}
                step={step}
                index={i}
                files={files}
                corpus={corpus}
                cloneNames={cloneNames}
                preferPost={preferPost}
                posted={posted.has(i)}
                onAdd={addComment}
                onPost={postStep}
                checksKey={checksKey}
                check={checks?.[stepId(step)]}
                onCheck={checkStep}
                canConcernCheck={!!cwd}
                onClearCheck={clearCheck}
                onExplainBehavior={explainBehavior}
                onDismiss={dismiss}
                onOpenFile={openStep}
                prKey={prKey}
                onAskAi={askAi}
              />
            );
            // A merged deep tour is one list of stops drawn from many layers.
            // Without a boundary the strata the planner chose are invisible and
            // the reviewer just sees the list get longer.
            const head = layerHeads.get(i);
            if (!head) return stop;
            return (
              <Fragment key={`g${i}`}>
                <LayerDivider
                  layer={head}
                  count={layerCounts.get(head.id) ?? 0}
                  action={
                    <LayerCheckAction
                      layer={head}
                      pending={batch ? undefined : uncheckedByLayer.get(head.id)}
                      checking={checkingLayers.has(head.id)}
                      onCheck={setConfirmCheckAll}
                      labelled
                    />
                  }
                />
                {stop}
              </Fragment>
            );
          })}

          <TourEnd
            atLast={atLast}
            endMessage={
              noSteps
                ? "No stops to walk through — nothing needed a closer look. The recommendation is above."
                : stopFilter
                  ? `That's every ${stopFilter.kind} stop.`
                  : filter
                    ? `That's every ${KIND[filter].label.toLowerCase()} stop.`
                    : "That's the whole tour — happy reviewing."
            }
            onNext={() => move(1)}
            dismissedCount={dismissedSet.size}
            onRestore={restoreDismissed}
          />
        </div>
      </div>

      <AlertDialog
        open={confirmCheckAll != null}
        onOpenChange={(o) => {
          if (!o) setConfirmCheckAll(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmCheckAll?.layer
                ? `Check layer ${confirmCheckAll.layer.index} with AI?`
                : "Check the tour with AI?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              This makes {checkAllCount} AI call{checkAllCount === 1 ? "" : "s"},{" "}
              {CHECK_CONCURRENCY} at a time — one per unchecked orientation or praise stop
              {confirmCheckAll?.layer ? ` in “${confirmCheckAll.layer.title}”` : ""}. Each checks
              its stop claim by claim against the code, without seeing the rest of the tour.
              Worth-a-comment and question stops are checked one at a time from the stop itself. You
              can stop the run at any time and keep what has landed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              Cancel
            </AlertDialogClose>
            <Button
              size="sm"
              onClick={() => {
                const steps = confirmCheckAll?.steps;
                setConfirmCheckAll(null);
                if (steps) void runCheckAll(steps);
              }}
            >
              <ShieldCheck className="size-3.5" />
              {confirmCheckAll?.layer ? "Check layer" : "Check all"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

/**
 * "Check layer" on a layer heading: the toolbar's "Check all" scoped to one
 * layer, reachable from wherever the reviewer has scrolled to. Shows a spinner
 * while any of the layer's stops is being checked, and nothing once every
 * orientation / praise stop in it has a check.
 */
function LayerCheckAction({
  layer,
  pending,
  checking,
  onCheck,
  labelled = false,
  quiet = false,
}: {
  layer: TourLayer;
  /** The layer's unchecked claim stops; undefined while a batch runs. */
  pending: GuidedStep[] | undefined;
  checking: boolean;
  onCheck: (req: { steps: GuidedStep[]; layer: TourLayer }) => void;
  /** Text button (reading pane) rather than an icon (rail). */
  labelled?: boolean;
  /** Hidden until the heading is hovered or the button focused. */
  quiet?: boolean;
}) {
  if (checking) {
    return (
      <span
        title={`Checking layer ${layer.index}…`}
        className={cn(
          "flex shrink-0 items-center gap-1 text-2xs text-muted-foreground",
          !labelled && "size-6 justify-center",
        )}
      >
        <Spinner className="size-3" />
        {labelled && "Checking…"}
      </span>
    );
  }
  if (!pending?.length) return null;
  const label = `Check layer ${layer.index} with AI`;
  if (labelled) {
    return (
      <TooltipFor label={label}>
        <Button size="xs" variant="ghost" onClick={() => onCheck({ steps: pending, layer })}>
          <ShieldCheck className="size-3" />
          Check layer
        </Button>
      </TooltipFor>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onCheck({ steps: pending, layer })}
      aria-label={label}
      title={label}
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-[opacity,color,background-color] hover:bg-foreground/[0.05] hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100",
        quiet && "opacity-0",
      )}
    >
      <ShieldCheck className="size-3.5" strokeWidth={2} />
    </button>
  );
}

/**
 * One stop in the reading pane.
 *
 * Memoized, and every handler it takes is index- or step-parameterised rather
 * than pre-bound, so the tour can hand all of its stops the same prop
 * identities. Without both halves, moving the cursor re-rendered every mounted
 * stop — on a deep tour that is 200+ markdown bodies, syntax-highlighted
 * snippets and comment composers rebuilt to change which one is highlighted.
 */
const Step = memo(function Step({
  setRef,
  step,
  index,
  files,
  corpus,
  cloneNames,
  preferPost,
  posted,
  onAdd,
  onPost,
  checksKey,
  check,
  onCheck,
  canConcernCheck,
  onClearCheck,
  onExplainBehavior,
  onDismiss,
  onOpenFile,
  prKey,
  onAskAi,
}: {
  setRef: (index: number, el: HTMLElement | null) => void;
  step: GuidedStep;
  index: number;
  files: PullFile[];
  /** The whole PR's diff text, joined once by the tour — see `verifyClaim`. */
  corpus: string;
  /** Names found in the local clone — see `groundInClone`. */
  cloneNames: ReadonlySet<string>;
  /** When posting straight to GitHub is available, make it the primary action. */
  preferPost: boolean;
  posted: boolean;
  onAdd: (step: GuidedStep, index: number, body: string) => void;
  onPost?: (step: GuidedStep, body: string) => Promise<void>;
  /** Where this tour's checks are stored — `checksKey(prKey, headSha)`. */
  checksKey: string;
  /** The stored check on this stop, if any. */
  check?: CheckRecord;
  /** Run this stop's check (concern check or claim check, by kind). */
  onCheck: (step: GuidedStep) => Promise<void>;
  /** A clone exists, so concerns and questions can be checked too. */
  canConcernCheck: boolean;
  /** Forget this stop's check. */
  onClearCheck: (step: GuidedStep) => void;
  /** Explain this stop's symbol as behavior (before / after / what changed). */
  onExplainBehavior?: (step: GuidedStep) => Promise<BehaviorDiff | null>;
  onDismiss?: (index: number) => void;
  onOpenFile: (path: string, line?: number) => void;
  /** Conversation key, `owner/repo#number` — where highlights are attached. */
  prKey: string;
  onAskAi: () => void;
}) {
  const sectionRef = useCallback((el: HTMLElement | null) => setRef(index, el), [setRef, index]);
  const dismiss = useMemo(
    () => (onDismiss ? () => onDismiss(index) : undefined),
    [onDismiss, index],
  );
  const [posting, setPosting] = useState(false);
  const [postedGh, setPostedGh] = useState(false);
  const id = useMemo(() => stepId(step), [step]);
  const checking = useStepCheckRuns((s) => !!s.inFlight[runKey(checksKey, id)]);
  // The AI's verdict + finding from "Check with AI", kept (and persisted) so
  // the reasoning is always shown — a cleared concern is never dismissed as a
  // black box. On "valid" the finding is a sharper comment that replaces the
  // suggestion.
  const result = check?.type === "concern" ? check : null;
  const claims = check?.type === "claims" ? check : null;
  const refined = result?.verdict === "valid" ? result.finding : null;
  const checkType = checkTypeFor(step.kind);
  const checkable = checkType === "claims" || canConcernCheck;

  // Deterministic grounding check, at read time against the PR's real files —
  // same reasoning as `mergeDeepTour`: the PR keeps moving, so a grade computed
  // when the tour was generated could outlive the diff it describes. Only a
  // downgrade is surfaced; annotating every well-anchored stop would be noise.
  const evidence = useMemo(
    () => groundInClone(verifyStep(step, files, corpus), cloneNames),
    [step, files, corpus, cloneNames],
  );
  const trust = stepTrust(evidence.grade, check);

  // Highlight → "Ask AI", as in the diff: code in the snippet pins its lines;
  // text in the commentary pins the passage as a claim about the stop's anchor.
  const codeRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLDivElement>(null);
  const patch = useMemo(
    () => files.find((f) => f.filename === step.path)?.patch ?? null,
    [files, step.path],
  );
  const resolveNote = useCallback(
    (root: HTMLElement, sel: Selection) => refFromStopNote(root, step, sel),
    [step],
  );

  function runCheck() {
    if (!checking) void onCheck(step);
  }

  // Behavior summary for this stop's symbol, fetched on demand. Ephemeral for
  // the same reason `result` is: it describes the diff as it stands right now.
  const [behavior, setBehavior] = useState<BehaviorDiff | null>(null);
  const [explaining, setExplaining] = useState(false);

  async function runExplain() {
    if (!onExplainBehavior || explaining) return;
    setExplaining(true);
    try {
      const b = await onExplainBehavior(step);
      if (b) setBehavior(b);
    } finally {
      setExplaining(false);
    }
  }
  // Posting to GitHub is only an option when onPost is wired; the setting only
  // chooses which of the two is the primary (vs secondary) button.
  const canPost = !!onPost;
  const primaryPost = canPost && preferPost;

  async function post(b: string) {
    if (!onPost || !b.trim() || posting) return;
    setPosting(true);
    try {
      await onPost(step, b.trim());
      setPostedGh(true);
    } catch (e) {
      toast.error(`Couldn't post — ${String(e)}`);
    } finally {
      setPosting(false);
    }
  }

  return (
    <section ref={sectionRef} className="animate-tour-fade-in">
      {/* sticky header — the current stop stays pinned while you read it.
          Opaque so the diff scrolls cleanly *under* it (no bleed-through). The
          pinning itself marks "where you are", so the row stays neutral. */}
      <StepHeader
        index={index}
        step={step}
        trust={trust}
        // Only a check's outcome. An unverified stop already says so in its
        // grade label and its warning; a third "unverified" adds nothing.
        showTrust={trust === "verified" || trust === "contradicted"}
        grade={
          <GradeLabel
            grade={evidence.grade}
            help={PR_GRADE_HELP}
            // The heuristic reason is spelled out in the warning box below.
            reason={evidence.grade === "heuristic" ? undefined : evidence.reason}
          />
        }
        openLabel={`Open ${step.path} in the diff`}
        onOpenFile={onOpenFile}
        onDismiss={dismiss}
      />

      {/* content */}
      <div className="min-w-0 pt-3 pb-8">
        {/* Grounding caveat, BEFORE the snippet — a reviewer should know the
            anchor is shaky while reading it, not after. The stop itself is
            never hidden: an unverifiable concern is a reason to read the code,
            not a reason to keep it from the reviewer. */}
        {evidence.grade === "heuristic" && (
          <div className="mb-2 flex items-start gap-2 rounded-lg bg-warning/10 px-2.5 py-2 text-xs text-warning">
            <AlertTriangle className="mt-px size-3 shrink-0" />
            <span className="min-w-0 flex-1">
              Couldn't verify this against the diff — <CodeSpans text={evidence.reason ?? ""} />{" "}
              Read the source before acting on it.
            </span>
          </div>
        )}
        <div ref={codeRef}>
          <InlineDiff files={files} path={step.path} line={step.line} endLine={step.endLine} />
        </div>
        <DiffSelectionToolbar
          rootRef={codeRef}
          path={step.path}
          patch={patch}
          view="unified"
          prKey={prKey}
          onAskAi={onAskAi}
        />

        {step.detail && (
          <div ref={noteRef} className="mt-3">
            <MarkdownBody className="text-foreground/90">{step.detail}</MarkdownBody>
            <DiffSelectionToolbar
              rootRef={noteRef}
              path={step.path}
              patch={patch}
              view="prose"
              resolve={resolveNote}
              prKey={prKey}
              onAskAi={onAskAi}
            />
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {checkable && !check && (
            <Button size="xs" variant="secondary" loading={checking} onClick={runCheck}>
              <Sparkles className="size-3 text-info" />
              Check with AI
            </Button>
          )}
          {/* Available on every stop, clone or not — the file's own patch
              carries both sides of the change. */}
          {onExplainBehavior && !behavior && (
            <Button size="xs" variant="secondary" loading={explaining} onClick={runExplain}>
              <GitCompare className="size-3 text-info" />
              Explain behavior
            </Button>
          )}
        </div>

        {behavior && (
          <BehaviorPanel
            diff={behavior}
            path={step.path}
            files={files}
            onGoToLine={(line) => onOpenFile(step.path, line)}
            onClose={() => setBehavior(null)}
          />
        )}

        {claims && (
          <ClaimRows
            record={claims}
            checking={checking}
            onRecheck={runCheck}
            onOpenFile={onOpenFile}
          />
        )}

        {/* Cleared: show the AI's reasoning and let the reviewer close it (or
            keep it if they disagree) — never a silent black-box dismiss. */}
        {result?.verdict === "resolved" && (
          <div className="mt-3 rounded-lg border border-success/25 bg-success/[0.06] p-3">
            <p className="flex items-center gap-1.5 text-xs font-medium text-success">
              <Check className="size-3.5" />
              AI looked into this — not worth raising
            </p>
            <p className="mt-1.5 text-xs leading-relaxed text-foreground/80">{result.finding}</p>
            <div className="mt-2.5 flex items-center justify-end gap-1.5">
              <Button size="xs" variant="ghost" onClick={() => onClearCheck(step)}>
                Keep it
              </Button>
              {dismiss && (
                <Button size="xs" variant="secondary" onClick={dismiss}>
                  Dismiss stop
                  <X className="size-3" />
                </Button>
              )}
            </div>
          </div>
        )}

        {result?.verdict === "valid" && (
          <p className="mt-3 flex items-center gap-1.5 text-xs text-info">
            <Sparkles className="size-3" />
            AI verified it — refined the comment below.
          </p>
        )}

        {result?.verdict !== "resolved" && (step.suggestion != null || refined != null) && (
          <Composer
            className="mt-3"
            initialValue={refined ?? step.suggestion ?? ""}
            rows={3}
            header={
              <span className="inline-flex items-center gap-1.5 font-medium text-muted-foreground">
                <Sparkles className="size-3 text-info" />
                Suggested comment
              </span>
            }
            submitLabel={
              primaryPost
                ? postedGh
                  ? "Post again"
                  : "Post to GitHub"
                : posted
                  ? "Add again"
                  : "Add to review"
            }
            submitIcon={primaryPost ? <Send className="size-3" /> : undefined}
            submitting={posting}
            onSubmit={primaryPost ? (b) => post(b) : (b) => onAdd(step, index, b)}
            secondaryLabel={
              canPost
                ? primaryPost
                  ? posted
                    ? "Add again"
                    : "Add to review"
                  : postedGh
                    ? "Post again"
                    : "Post to GitHub"
                : undefined
            }
            onSecondary={
              canPost ? (primaryPost ? (b) => onAdd(step, index, b) : (b) => post(b)) : undefined
            }
            footerStatus={
              postedGh ? (
                <span className="inline-flex items-center gap-1 pl-0.5 text-2xs text-success">
                  <Check className="size-3" /> Posted to GitHub
                </span>
              ) : posted ? (
                <span className="inline-flex items-center gap-1 pl-0.5 text-2xs text-success">
                  <Check className="size-3" /> Added to review
                </span>
              ) : undefined
            }
          />
        )}
      </div>
    </section>
  );
});

function InlineDiff({
  files,
  path,
  line,
  endLine,
}: {
  files: PullFile[];
  path: string;
  line: number;
  endLine?: number;
}) {
  const file = files.find((f) => f.filename === path);
  const lang = detectLanguage(path);
  const lo = line;
  const hi = endLine && endLine >= line ? endLine : line;

  // Rows, already syntax-highlighted. The highlighting belongs INSIDE the memo:
  // Prism is the expensive part of drawing a snippet, and running it in the
  // render body meant re-tokenising every visible line of every mounted stop
  // each time the tour re-rendered.
  const window = useMemo(
    () =>
      anchorWindow(file?.patch, lo, hi)?.map((l) => ({
        line: l,
        html: highlightLine(l.text, lang) || "&nbsp;",
      })) ?? null,
    [file?.patch, lo, hi, lang],
  );

  if (!window) {
    return (
      <p className="rounded-lg bg-foreground/[0.03] p-2.5 text-xs text-muted-foreground">
        {file
          ? `Line ${line} isn't in this file's diff — open the file for the full context.`
          : "This path isn't part of the PR's diff (the AI may have referenced code outside it)."}
      </p>
    );
  }

  const inRange = (nl: number | null | undefined) => nl != null && nl >= lo && nl <= hi;
  return (
    <div
      data-selectable
      className="overflow-x-auto rounded-lg border border-border/40 bg-card/60 py-1 font-mono text-xs leading-[1.5]"
    >
      {window.map(({ line: l, html }, i) => {
        const num = l.newLine ?? l.oldLine;
        const hit = inRange(l.newLine);
        return (
          <div
            key={i}
            // Selection → "Ask AI" reads the line range off these, as in the
            // diff viewer (see lib/ai/attach).
            data-diff-row=""
            data-side={l.newLine != null ? "RIGHT" : "LEFT"}
            data-new-line={l.newLine ?? undefined}
            data-old-line={l.oldLine ?? undefined}
            // One continuous neutral bar marks the focused range — no per-line box.
            className={cn(
              "flex border-l-2 border-transparent",
              !hit && l.kind === "add" && "bg-success/[0.07]",
              !hit && l.kind === "del" && "bg-destructive/[0.07]",
              hit && "border-foreground/50 bg-foreground/[0.08]",
            )}
          >
            <span className="w-10 shrink-0 select-none px-2 text-right text-muted-foreground/40 tabular-nums">
              {num ?? ""}
            </span>
            <span
              className={cn(
                "w-3 shrink-0 select-none text-center",
                l.kind === "add" && "text-success/80",
                l.kind === "del" && "text-destructive/80",
              )}
            >
              {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
            </span>
            <pre
              className="min-w-0 flex-1 whitespace-pre-wrap break-words pr-3 text-foreground/90"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: Prism-highlighted
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </div>
        );
      })}
    </div>
  );
}
