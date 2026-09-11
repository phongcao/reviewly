import { BehaviorPanel } from "@/components/behavior-panel";
import { Composer } from "@/components/composer";
import { IconButton } from "@/components/icon-button";
import { KiteLoader } from "@/components/kite-loader";
import { MarkdownBody } from "@/components/markdown-body";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { STEP_CAP_SINGLE, shouldFanOut, stepBudget } from "@/lib/ai/budget";
import type { ContextOptions, ReviewContext } from "@/lib/ai/context";
import { CLONE_ABSENT_CLAUSE, buildGuidedSystem } from "@/lib/ai/prompts";
import { useAiAvailable } from "@/lib/ai/use-ai-available";
import { useBehavior } from "@/lib/ai/use-behavior";
import { useDeepTourRunner } from "@/lib/ai/use-deep-tour";
import { verifyStep } from "@/lib/ai/verify";
import type { BehaviorDiff } from "@/lib/behavior";
import { type CoverageReport, RISK_LABEL, blindSpots, tourCoverage } from "@/lib/coverage";
import { type DeepTourProgress, deepTourProgress, mergeDeepTour, stepId } from "@/lib/deep-tour";
import { parsePatch } from "@/lib/diff";
import { relativeTime } from "@/lib/format";
import {
  type GuidedPlan,
  type GuidedStep,
  type GuidedVerdict,
  type StepKind,
  type TourLayer,
  groupTourStops,
  parseTourKey,
  verdictDisplay,
} from "@/lib/guided";
import { detectLanguage, highlightLine } from "@/lib/lang";
import { heuristicLayers, reconcileLayers } from "@/lib/layers";
import type { DraftComment, PullFile } from "@/lib/tauri";
import { invoke } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { PROVIDER_LABEL, aiInvokeArgs, useAiProvider } from "@/stores/ai";
import { type DeepTourEntry, useDeepTour } from "@/stores/deep-tour";
import { useDeepTourGen } from "@/stores/deep-tour-gen";
import { useGuided } from "@/stores/guided";
import { useGuidedGen } from "@/stores/guided-gen";
import { useLayers } from "@/stores/layers";
import { useLocalRepos } from "@/stores/local-repos";
import { useReviewPrefs } from "@/stores/review-prefs";
import { type ReviewEvent, useReviewVerdict } from "@/stores/review-verdict";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Compass,
  FileCode,
  GitCompare,
  HelpCircle,
  Layers,
  ListOrdered,
  MessageSquare,
  RefreshCw,
  RotateCcw,
  Send,
  Sparkles,
  ThumbsUp,
  X,
} from "lucide-react";
import {
  type ComponentType,
  Fragment,
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
  /** Add a suggested comment to the pending review. */
  onAddComment: (c: DraftComment) => void;
  /** Post a suggested comment straight to GitHub as an inline review comment. */
  onPostComment?: (c: { path: string; line: number; body: string }) => Promise<void>;
  /** Open a file in the diff (when the reader wants the full context). */
  onOpenFile: (path: string, line?: number) => void;
  /** Report whether the guided reading pane has scrolled past its intro. */
  onScrolledChange?: (scrolled: boolean) => void;
}

const KIND: Record<
  StepKind,
  {
    icon: ComponentType<{ className?: string }>;
    text: string;
    /** Progress-rail / focus-chip fill for this kind. */
    dot: string;
    label: string;
  }
> = {
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

/** Stable empty set, so a tour with no collapse support doesn't hand the rail a
 * fresh `Set` identity on every render. */
const NO_COLLAPSE: ReadonlySet<string> = new Set();

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

/**
 * How the tour reads and writes the reviewer's progress.
 *
 * `Tour` is used by two surfaces whose progress is keyed differently: the
 * classic whole-PR tour stores `seen` / `dismissed` as indices into a single
 * fixed `steps` array, while a fanned-out deep tour grows its step list as
 * layers land and so must key progress by a stable per-step id. Rather than
 * duplicate the tour UI, `Tour` takes plain step indices and lets the caller
 * decide what they mean.
 */
export interface TourProgress {
  /** Indices of stops the reviewer dismissed (hidden from the tour). */
  dismissed: Set<number>;
  /** Indices of stops the reviewer has already read. The rail marks these done
   * rather than inferring it from position: in a deep tour the list grows, and
   * a stop that lands ahead of the cursor has not been read just because it now
   * sits behind it. */
  seen: Set<number>;
  /** Index to resume on. */
  lastActive: number;
  markSeen: (index: number) => void;
  setLastActive: (index: number) => void;
  dismiss: (index: number) => void;
  restoreDismissed: () => void;
  /** Which layers are folded away in the tour rail. Rail-only view state, but
   * persisted per PR alongside the rest of the reviewer's tour state — shrinking
   * the rail should survive navigating away. Absent on the classic whole-PR
   * tour, which has no layers to fold: its absence is what hides the controls. */
  collapse?: {
    collapsed: Set<string>;
    toggle: (layerId: string) => void;
    /** Bulk set, for collapse-all / expand-all. */
    setAll: (layerIds: string[], collapsed: boolean) => void;
  };
}

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
  onAddComment,
  onPostComment,
  onOpenFile,
  onScrolledChange,
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
    const layers = Object.keys(snapshot.byLayer).length;
    toast(`Tour discarded — ${layers} layer${layers === 1 ? "" : "s"}`, {
      action: {
        label: "Undo",
        onClick: () => useDeepTour.getState().restore(prKey, snapshot),
      },
    });
  }, [prKey]);

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
      regenerating={pending}
      onRegenerate={() => {
        resetPlan(prKey);
        startSingle();
      }}
      onAddComment={onAddComment}
      onPostComment={onPostComment}
      onOpenFile={onOpenFile}
      onScrolledChange={onScrolledChange}
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
  aiName,
  onRun,
  onSinglePass,
  onStartOver,
  onAddComment,
  onPostComment,
  onOpenFile,
  onScrolledChange,
}: {
  prKey: string;
  entry: DeepTourEntry | undefined;
  files: PullFile[];
  headSha?: string;
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

  const plan = useMemo(() => (entry ? mergeDeepTour(entry, files) : null), [entry, files]);
  const info: DeepTourProgress = useMemo(
    () => deepTourProgress(entry, files, busy),
    [entry, files, busy],
  );

  // Index ↔ stable id, rebuilt whenever the merged plan changes. This is the
  // whole point of id-keyed progress: after a new layer lands, index 4 may be a
  // different stop, but the id the reviewer dismissed still resolves correctly.
  const ids = useMemo(() => (plan ? plan.steps.map(stepId) : []), [plan]);
  const dismissedIds = entry?.dismissed;
  const seenIds = entry?.seen;
  const lastActiveId = entry?.lastActiveId;
  const collapsedLayerIds = entry?.collapsedLayers;
  const progress = useMemo<TourProgress>(() => {
    const hidden = new Set(dismissedIds ?? []);
    const read = new Set(seenIds ?? []);
    const dismissed = new Set<number>();
    const seen = new Set<number>();
    ids.forEach((id, i) => {
      if (hidden.has(id)) dismissed.add(i);
      if (read.has(id)) seen.add(i);
    });
    const resume = lastActiveId ? ids.indexOf(lastActiveId) : -1;
    return {
      dismissed,
      // Read state is per stop, by stable id — the whole point of id-keyed
      // progress. Stops that land later read as new, however far up the merged
      // list their layer inserts them.
      seen,
      lastActive: resume >= 0 ? resume : 0,
      markSeen: (i) => {
        const id = ids[i];
        if (id) markSeenStep(prKey, id);
      },
      setLastActive: (i) => {
        const id = ids[i];
        if (id) setLastActive(prKey, id);
      },
      dismiss: (i) => {
        const id = ids[i];
        if (id) dismissStep(prKey, id);
      },
      restoreDismissed: () => restoreDismissed(prKey),
      collapse: {
        collapsed: new Set(collapsedLayerIds ?? []),
        toggle: (id) => toggleLayerCollapsed(prKey, id),
        setAll: (ids, c) => setLayersCollapsed(prKey, ids, c),
      },
    };
  }, [
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
  ]);

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
    if (!entry) return out;
    for (const layer of reconcileLayers(entry.plan, files).layers) {
      if (entry.byLayer[layer.id]) continue;
      for (const p of layer.files) out.add(p);
    }
    return out;
  }, [entry, files]);

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
          regenerating={busy.size > 0}
          onRegenerate={() => onRun(undefined, { force: true })}
          onAddComment={onAddComment}
          onPostComment={onPostComment}
          onOpenFile={onOpenFile}
          onScrolledChange={onScrolledChange}
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
  regenerating,
  onRegenerate,
  onAddComment,
  onPostComment,
  onOpenFile,
  onScrolledChange,
}: {
  prKey: string;
  plan: GuidedPlan;
  /** Which AI produced the tour ("claude" | "codex"). */
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
  regenerating: boolean;
  onRegenerate: () => void;
  onAddComment: (c: DraftComment) => void;
  onPostComment?: (c: { path: string; line: number; body: string }) => Promise<void>;
  onOpenFile: (path: string, line?: number) => void;
  onScrolledChange?: (scrolled: boolean) => void;
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
  const { markSeen, setLastActive, dismiss, restoreDismissed } = progress;
  const localRepos = useLocalRepos((s) => s.repos);
  // The PR's local clone path — gives the per-step AI check real code to read
  // against (the "Check with AI" button only appears when this exists).
  const cwd = useMemo(() => {
    const [owner, repo] = prKey.split("#")[0].split("/");
    return localRepos.find((r) => r.owner === owner && r.repo === repo)?.path ?? null;
  }, [prKey, localRepos]);
  // Verify one concern against the clone; the Step auto-dismisses (resolved) or
  // refines the comment (valid) from the result.
  const checkWithAI = useCallback(
    async (step: GuidedStep): Promise<CheckResult | null> => {
      try {
        const out = await invoke<string>("ai_review", {
          ...aiInvokeArgs(),
          cwd,
          prompt: checkPrompt(step),
        });
        return parseCheckResult(out);
      } catch (e) {
        toast.error(`AI check failed — ${String(e)}`);
        return null;
      }
    },
    [cwd],
  );
  // Explain ONE stop's symbol as behavior (before / after / what changed).
  // Unlike the concern check this does NOT require a clone: the file's own
  // patch carries both sides of the change. Shared with the diff viewer's hunk
  // and selection entry points so all three ask the same question.
  const { explain } = useBehavior(cwd);
  const explainBehavior = useCallback(
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
    [explain, files],
  );
  // Open a step's file — but only if it's actually part of this PR. A tour can
  // occasionally name a path that isn't in the diff (a stale or mistaken
  // reference); opening that would land on nothing, so warn instead.
  const openStep = useCallback(
    (path: string, line?: number) => {
      if (!files.some((f) => f.filename === path)) {
        toast.warning(`${path} isn't a file in this PR — it may be a stale or mistaken reference.`);
        return;
      }
      onOpenFile(path, line);
    },
    [files, onOpenFile],
  );
  const [active, setActive] = useState(() => Math.max(0, Math.min(progress.lastActive, total - 1)));
  const [posted, setPosted] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState<StepKind | null>(null);
  const [tourScrolled, setTourScrolled] = useState(false);
  // 82: lets the reviewer keep a stale tour — acknowledges staleness and hides
  // the banner without discarding the (still useful) walkthrough.
  const [staleAck, setStaleAck] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stepRefs = useRef<(HTMLElement | null)[]>([]);
  const scrolledRef = useRef(false);

  // While a programmatic jump (click a node / next / prev) is smooth-scrolling,
  // hold the chosen stop active until the scroll actually arrives — otherwise
  // the scroll listener reads the mid-animation position and briefly flashes
  // each stop it passes over (the "blink to the previous one").
  const jumpTargetRef = useRef<number | null>(null);
  const jumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const beginJump = useCallback((target: number) => {
    jumpTargetRef.current = target;
    if (jumpTimer.current) clearTimeout(jumpTimer.current);
    // Safety release: the scroll may never reach the very top (e.g. the last
    // stops), so don't hold the highlight hostage forever.
    jumpTimer.current = setTimeout(() => {
      jumpTargetRef.current = null;
    }, 1000);
  }, []);
  useEffect(
    () => () => {
      if (jumpTimer.current) clearTimeout(jumpTimer.current);
    },
    [],
  );

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
  // Original-index list of the steps currently in view (not dismissed; all or one kind).
  const visible = useMemo(
    () =>
      plan.steps
        .map((_, i) => i)
        .filter((i) => !dismissedSet.has(i) && (!filter || plan.steps[i].kind === filter)),
    [plan.steps, filter, dismissedSet],
  );

  // Layer headings for a merged deep tour. Keyed off the VISIBLE order, so a
  // kind filter that empties a layer drops its heading too, and a layer split
  // by the filter still heads each run it survives in.
  const layerById = useMemo(
    () => new Map((plan.layers ?? []).map((l) => [l.id, l])),
    [plan.layers],
  );
  const layerHeads = useMemo(() => {
    const heads = new Map<number, TourLayer>();
    if (!plan.layers?.length) return heads;
    let prev: string | undefined;
    for (const i of visible) {
      const id = plan.steps[i].layerId;
      const layer = id ? layerById.get(id) : undefined;
      if (layer && id !== prev) heads.set(i, layer);
      prev = id;
    }
    return heads;
  }, [visible, plan.steps, plan.layers, layerById]);
  // Stops per layer among the visible ones — the denominator of the
  // layer-relative counter, and the "N stops" on each heading.
  const layerCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const i of visible) {
      const id = plan.steps[i].layerId;
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [visible, plan.steps]);

  // The rail draws layer by layer so one layer's stops can fold away without
  // breaking the spine that runs through the others. The reading pane still
  // renders every visible stop — `layerHeads` above stays its heading source.
  const groups = useMemo(
    () => groupTourStops(visible, plan.steps, plan.layers),
    [visible, plan.steps, plan.layers],
  );
  // Read stops per layer — what a folded heading reports in place of its rows.
  const layerDone = useMemo(() => {
    const done = new Map<string, number>();
    for (const i of visible) {
      const id = plan.steps[i].layerId;
      if (id && progress.seen.has(i)) done.set(id, (done.get(id) ?? 0) + 1);
    }
    return done;
  }, [visible, plan.steps, progress.seen]);
  const collapse = progress.collapse;
  const collapsedIds = collapse?.collapsed ?? NO_COLLAPSE;
  // Only layers with stops ON SCREEN: collapse-all must not fold ids the rail
  // can't show, and a layer the kind filter emptied has nothing to fold.
  const collapsibleIds = useMemo(
    () => [...new Set(groups.map((g) => g.layer?.id).filter((id): id is string => !!id))],
    [groups],
  );

  // Move ±1 through the *visible* set (respects an active kind filter).
  const move = useCallback(
    (delta: number) => {
      setActive((a) => {
        const p = visible.indexOf(a);
        const curr = p < 0 ? 0 : p;
        const n = visible[Math.max(0, Math.min(visible.length - 1, curr + delta))] ?? a;
        beginJump(n);
        stepRefs.current[n]?.scrollIntoView({ behavior: "smooth", block: "start" });
        return n;
      });
    },
    [visible, beginJump],
  );

  // When the filter hides the active step, snap to the first visible one.
  useEffect(() => {
    if (visible.length > 0 && !visible.includes(active)) setActive(visible[0]);
  }, [visible, active]);

  const pos = visible.indexOf(active);
  const atFirst = pos <= 0;
  const atLast = pos >= visible.length - 1;

  // Where the cursor sits INSIDE its layer. The global "3 / 40" is the wrong
  // unit of progress once a tour is layered — the question a reviewer is
  // actually asking is whether they're through the layer in front of them.
  const activeLayer = layerById.get(plan.steps[active]?.layerId ?? "");
  const layerPos = activeLayer
    ? visible.filter((i) => i <= active && plan.steps[i].layerId === activeLayer.id).length
    : 0;

  // Persist resume position + mark the visited step as seen.
  useEffect(() => {
    markSeen(active);
    setLastActive(active);
  }, [active, markSeen, setLastActive]);

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

  // Keyboard nav: j/↓ next, k/↑ prev, o open file, x dismiss, Enter/d next
  // undismissed stop. Ignored while typing.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        move(1);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        move(-1);
      } else if (e.key === "o") {
        const step = plan.steps[active];
        if (step) openStep(step.path, step.line);
      } else if (e.key === "x") {
        // 81: dismiss the active stop; the effect on `visible` re-snaps to the
        // next remaining stop automatically.
        e.preventDefault();
        dismiss(active);
      } else if (e.key === "Enter" || e.key === "d") {
        // 81: advance to the next (undismissed) stop.
        e.preventDefault();
        move(1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, plan.steps, openStep, move, dismiss]);

  // The active (colored) step is exactly the one whose sticky header is pinned
  // at the top: the last visible section that has scrolled to/above the top
  // edge. This keeps the highlight in lock-step with the stuck header.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    function syncStuck() {
      if (!root) return;
      const top = root.getBoundingClientRect().top;
      let current = visible[0] ?? 0;
      for (const i of visible) {
        const el = stepRefs.current[i];
        if (!el) continue;
        // Small tolerance so a jumped-to stop (which lands ~flush at the top)
        // still registers as current — a tight `<= 1` would snap back to the
        // previous stop after a click/next jump.
        if (el.getBoundingClientRect().top - top <= 4) current = i;
        else break;
      }
      // A jump is animating: hold the chosen stop until the scroll reaches it,
      // so we don't flash each stop it passes over on the way.
      if (jumpTargetRef.current !== null) {
        if (current !== jumpTargetRef.current) return;
        jumpTargetRef.current = null;
      }
      setActive(current);
    }
    syncStuck();
    root.addEventListener("scroll", syncStuck, { passive: true });
    return () => root.removeEventListener("scroll", syncStuck);
  }, [visible]);

  function addComment(step: GuidedStep, idx: number, body: string) {
    if (!body.trim()) return;
    onAddComment({ path: step.path, line: step.line, body: body.trim(), side: "RIGHT" });
    setPosted((s) => new Set(s).add(idx));
  }

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

  const jumpTo = useCallback(
    (i: number) => {
      beginJump(i);
      stepRefs.current[i]?.scrollIntoView({ behavior: "smooth", block: "start" });
      setActive(i);
    },
    [beginJump],
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
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {!noSteps && (
                <>
                  {activeLayer ? (
                    <span className="mr-1 flex items-baseline gap-1.5 text-xs tabular-nums">
                      <span
                        className="font-medium text-foreground/75"
                        title={`${activeLayer.title} — layer ${activeLayer.index} of ${activeLayer.total}`}
                      >
                        L{activeLayer.index} · {Math.max(1, layerPos)} /{" "}
                        {layerCounts.get(activeLayer.id) ?? 0}
                      </span>
                      <span className="text-muted-foreground/50">
                        {Math.max(1, pos + 1)} / {visible.length}
                      </span>
                    </span>
                  ) : (
                    <span className="mr-1 text-xs tabular-nums text-muted-foreground">
                      {Math.max(1, pos + 1)} / {visible.length}
                    </span>
                  )}
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={atFirst}
                    onClick={() => move(-1)}
                  >
                    <ChevronLeft className="size-4" />
                  </Button>
                  <Button size="icon-sm" variant="ghost" disabled={atLast} onClick={() => move(1)}>
                    <ChevronRight className="size-4" />
                  </Button>
                </>
              )}
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
              {plan.summary}
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
              Toured by {provider === "codex" ? "Codex" : "Claude"} ·{" "}
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
              {plan.verdictReason}
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
          <aside className="hidden w-60 shrink-0 overflow-y-auto border-r border-hairline px-3 py-4 lg:block">
            <div className="mb-2 flex items-center gap-1 px-2">
              <p className="min-w-0 flex-1 text-3xs font-medium uppercase tracking-wide text-muted-foreground/50">
                The tour
              </p>
              {/* With a single layer the per-heading chevron is enough, and the
                  pair would just be noise. Two buttons rather than one toggle:
                  a toggle has to invent a meaning for "3 of 7 folded". */}
              {collapse && collapsibleIds.length > 1 && (
                <div className="-mr-1 flex shrink-0 items-center">
                  <button
                    type="button"
                    onClick={() => collapse.setAll(collapsibleIds, true)}
                    aria-label="Collapse all layers"
                    title="Collapse all"
                    className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
                  >
                    <ChevronsDownUp className="size-3.5" strokeWidth={2} />
                  </button>
                  <button
                    type="button"
                    onClick={() => collapse.setAll(collapsibleIds, false)}
                    aria-label="Expand all layers"
                    title="Expand all"
                    className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
                  >
                    <ChevronsUpDown className="size-3.5" strokeWidth={2} />
                  </button>
                </div>
              )}
            </div>
            <div className="flex flex-col">
              {groups.map((g, gi) => {
                const layer = g.layer;
                const folded = !!layer && !!collapse && collapsedIds.has(layer.id);
                // Only the run the cursor is actually in takes the accent, even
                // though the fold belongs to the layer as a whole.
                const hasCursor =
                  !!layer && layer.id === activeLayer?.id && g.items.includes(active);
                const n = layer ? (layerCounts.get(layer.id) ?? g.items.length) : g.items.length;
                const readN = layer ? (layerDone.get(layer.id) ?? 0) : 0;

                // Kept mounted (display:none) so `aria-controls` points at a
                // real node. Must be the `hidden` CLASS, not the attribute: the
                // author-level `display:flex` below would outrank the UA
                // sheet's `[hidden] { display: none }` and still render.
                const rows = (
                  <div
                    id={layer ? `tour-layer-${layer.id}` : undefined}
                    className={folded ? "hidden" : "flex flex-col"}
                  >
                    {g.items.map((i, q) => {
                      const p = g.start + q;
                      return (
                        <RailStop
                          key={i}
                          step={plan.steps[i]}
                          active={p === pos}
                          // Read state, not position: a layer that lands ahead
                          // of the cursor must not inherit the checkmarks of the
                          // stops it was inserted behind.
                          done={progress.seen.has(i) && p !== pos}
                          first={q === 0}
                          last={q === g.items.length - 1}
                          aboveFilled={p <= pos}
                          belowFilled={p < pos}
                          onClick={() => jumpTo(i)}
                        />
                      );
                    })}
                  </div>
                );

                if (!layer) return <Fragment key="ungrouped">{rows}</Fragment>;
                return (
                  <div key={`${layer.id}@${g.start}`} className={cn(gi > 0 && "mt-3")}>
                    <button
                      type="button"
                      onClick={() => collapse?.toggle(layer.id)}
                      disabled={!collapse}
                      aria-expanded={!folded}
                      aria-controls={`tour-layer-${layer.id}`}
                      title={`Layer ${layer.index} of ${layer.total} — ${layer.title} · ${readN} of ${n} read${
                        hasCursor ? ` · you're on stop ${Math.max(1, layerPos)}` : ""
                      }`}
                      className={cn(
                        "mb-1 flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors",
                        collapse && "hover:bg-foreground/[0.04]",
                        folded && hasCursor && "bg-foreground/[0.05]",
                      )}
                    >
                      {collapse && (
                        <ChevronRight
                          aria-hidden
                          strokeWidth={2}
                          className={cn(
                            "size-3 shrink-0 text-muted-foreground/50 transition-transform duration-200 motion-reduce:transition-none",
                            !folded && "rotate-90",
                          )}
                        />
                      )}
                      {/* Abbreviated because the chevron and the state chunk now
                          share this row — the full text is in the title. */}
                      <span className="shrink-0 text-3xs font-medium uppercase tracking-wide text-muted-foreground/50">
                        L{layer.index}/{layer.total}
                      </span>
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate text-2xs font-medium",
                          folded && hasCursor ? "text-foreground" : "text-foreground/70",
                        )}
                      >
                        {layer.title}
                      </span>
                      {/* A folded layer has to report itself — how much of it is
                          read, and whether the cursor is inside it, since the
                          active row it would show is hidden. Rendered in all
                          three states so the heading doesn't reflow on toggle. */}
                      <span
                        className={cn(
                          "flex shrink-0 items-center gap-1 text-2xs tabular-nums",
                          hasCursor ? "text-foreground/75" : "text-muted-foreground/50",
                        )}
                      >
                        {hasCursor ? (
                          <>
                            <span aria-hidden className="size-1.5 rounded-full bg-foreground/70" />
                            {Math.max(1, layerPos)}/{n}
                          </>
                        ) : readN >= n ? (
                          <Check className="size-3" strokeWidth={3} />
                        ) : (
                          `${readN}/${n}`
                        )}
                      </span>
                    </button>
                    {rows}
                  </div>
                );
              })}
            </div>
          </aside>
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
                setRef={(el) => {
                  stepRefs.current[i] = el;
                }}
                step={step}
                index={i}
                files={files}
                preferPost={preferPost}
                posted={posted.has(i)}
                onAdd={(body) => addComment(step, i, body)}
                onPost={
                  onPostComment
                    ? (body) => onPostComment({ path: step.path, line: step.line, body })
                    : undefined
                }
                onCheckAI={cwd ? checkWithAI : undefined}
                onExplainBehavior={explainBehavior}
                onDismiss={() => dismiss(i)}
                onOpenFile={openStep}
              />
            );
            // A merged deep tour is one list of stops drawn from many layers.
            // Without a boundary the strata the planner chose are invisible and
            // the reviewer just sees the list get longer.
            const head = layerHeads.get(i);
            if (!head) return stop;
            const n = layerCounts.get(head.id) ?? 0;
            return (
              <Fragment key={`g${i}`}>
                <div className="mb-3 mt-7 flex items-center gap-2.5">
                  <span className="shrink-0 rounded-full bg-foreground/[0.06] px-2 py-0.5 text-3xs font-medium uppercase tracking-wide text-muted-foreground">
                    Layer {head.index} of {head.total}
                  </span>
                  <span className="min-w-0 truncate text-xs font-medium text-foreground/80">
                    {head.title}
                  </span>
                  <span className="shrink-0 text-2xs tabular-nums text-muted-foreground/60">
                    {n} stop{n === 1 ? "" : "s"}
                  </span>
                  <span className="h-px min-w-4 flex-1 bg-hairline" />
                </div>
                {stop}
              </Fragment>
            );
          })}

          <div className="flex flex-col items-center gap-1.5 py-6">
            {atLast ? (
              <p className="text-center text-xs text-muted-foreground">
                {noSteps
                  ? "No stops to walk through — nothing needed a closer look. The recommendation is above."
                  : filter
                    ? `That's every ${KIND[filter].label.toLowerCase()} stop.`
                    : "That's the whole tour — happy reviewing."}
              </p>
            ) : (
              <Button size="xs" variant="ghost" onClick={() => move(1)}>
                Next stop
                <ArrowRight className="size-3" />
              </Button>
            )}
            {dismissedSet.size > 0 && (
              <Button size="xs" variant="ghost" onClick={() => restoreDismissed()}>
                <RotateCcw className="size-3" />
                Restore {dismissedSet.size} dismissed
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One stop on the tour rail.
 *
 * `first`/`last` are GROUP-local, so the spine breaks where a layer does — and
 * so folding a layer away leaves no dangling segment on its neighbours.
 * `aboveFilled`/`belowFilled` stay global: how far the reviewer has got is a
 * fact about the whole tour, not about one layer.
 */
function RailStop({
  step,
  active,
  done,
  first,
  last,
  aboveFilled,
  belowFilled,
  onClick,
}: {
  step: GuidedStep;
  active: boolean;
  done: boolean;
  first: boolean;
  last: boolean;
  aboveFilled: boolean;
  belowFilled: boolean;
  onClick: () => void;
}) {
  const K = KIND[step.kind] ?? KIND.orient;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group flex w-full gap-2.5 rounded-lg px-2 text-left transition-colors hover:bg-foreground/[0.04]",
        active && "bg-foreground/[0.05]",
      )}
    >
      <span className="relative flex w-4 shrink-0 flex-col items-center self-stretch">
        <span
          className={cn(
            "w-px flex-1",
            first ? "bg-transparent" : aboveFilled ? "bg-foreground/35" : "bg-foreground/12",
          )}
        />
        <span className="relative flex size-3.5 items-center justify-center">
          {active && (
            <span
              aria-hidden
              className="absolute inline-flex size-full rounded-full bg-foreground opacity-20 motion-safe:animate-ping"
            />
          )}
          {/* Fill encodes STATE (done/current = accent, ahead = hollow).
            The kind shows in the row heading, not on the node. */}
          <span
            className={cn(
              "relative flex size-3.5 items-center justify-center rounded-full",
              done && "bg-foreground/55 text-background",
              active && "bg-foreground/75 text-background ring-4 ring-foreground/10",
              !done && !active && "border-[1.5px] border-foreground/25 bg-background",
            )}
          >
            {done && <Check className="size-2.5" strokeWidth={3} />}
          </span>
        </span>
        <span
          className={cn(
            "w-px flex-1",
            last ? "bg-transparent" : belowFilled ? "bg-foreground/35" : "bg-foreground/12",
          )}
        />
      </span>
      <span className="min-w-0 flex-1 py-2.5">
        <span
          className={cn(
            "mb-1 block text-3xs font-medium uppercase leading-none tracking-wide",
            K.text,
            !active && "opacity-55",
          )}
        >
          {K.label}
        </span>
        <span
          className={cn(
            "block truncate text-xs leading-snug",
            active
              ? "font-medium text-foreground"
              : done
                ? "text-muted-foreground"
                : "text-muted-foreground/55",
          )}
        >
          {step.title}
        </span>
      </span>
    </button>
  );
}

/** Verdict the per-step "Check with AI" returns. */
type CheckResult = { verdict: "resolved" | "valid"; finding: string };

/** Ask the agent to verify ONE concern against the repo it runs in. */
function checkPrompt(step: GuidedStep): string {
  const loc = `${step.path}:${step.line}${step.endLine ? `-${step.endLine}` : ""}`;
  return [
    "You are verifying ONE code-review concern against the actual repository in this working directory. Read the relevant files to check it — don't guess.",
    "",
    `Concern (${step.kind}) at ${loc}`,
    `Title: ${step.title}`,
    step.detail ? `Details: ${step.detail}` : "",
    step.suggestion ? `Proposed review comment: ${step.suggestion}` : "",
    "",
    "Decide:",
    '- "resolved": NOT worth raising — false alarm, already handled, or not actually an issue.',
    '- "valid": a real concern worth a comment.',
    "",
    "Reply with ONLY a single-line JSON object — no prose, no code fences:",
    '{"verdict":"resolved"|"valid","finding":"<1-2 sentences; if valid, a sharp ready-to-post comment>"}',
  ]
    .filter(Boolean)
    .join("\n");
}

/** Pull the verdict JSON from the agent's (possibly chatty) reply. Unparseable
 *  output is treated as "valid" so we never auto-dismiss on ambiguity. */
function parseCheckResult(out: string): CheckResult {
  const m = out.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]) as { verdict?: unknown; finding?: unknown };
      return {
        verdict: o.verdict === "resolved" ? "resolved" : "valid",
        finding: typeof o.finding === "string" && o.finding.trim() ? o.finding.trim() : out.trim(),
      };
    } catch {
      /* fall through to raw-text fallback */
    }
  }
  return { verdict: "valid", finding: out.trim() };
}

const Step = ({
  setRef,
  step,
  index,
  files,
  preferPost,
  posted,
  onAdd,
  onPost,
  onCheckAI,
  onExplainBehavior,
  onDismiss,
  onOpenFile,
}: {
  setRef: (el: HTMLElement | null) => void;
  step: GuidedStep;
  index: number;
  files: PullFile[];
  /** When posting straight to GitHub is available, make it the primary action. */
  preferPost: boolean;
  posted: boolean;
  onAdd: (body: string) => void;
  onPost?: (body: string) => Promise<void>;
  /** Verify this concern against the local clone (concern/question kinds). */
  onCheckAI?: (step: GuidedStep) => Promise<CheckResult | null>;
  /** Explain this stop's symbol as behavior (before / after / what changed). */
  onExplainBehavior?: (step: GuidedStep) => Promise<BehaviorDiff | null>;
  onDismiss?: () => void;
  onOpenFile: (path: string, line?: number) => void;
}) => {
  const kind = KIND[step.kind] ?? KIND.orient;
  const Icon = kind.icon;
  const [posting, setPosting] = useState(false);
  const [postedGh, setPostedGh] = useState(false);
  const [checking, setChecking] = useState(false);
  // The AI's verdict + finding from "Check with AI", kept so the reasoning is
  // always shown — a cleared concern is never dismissed as a black box. On
  // "valid" the finding is a sharper comment that replaces the suggestion.
  const [result, setResult] = useState<CheckResult | null>(null);
  const refined = result?.verdict === "valid" ? result.finding : null;
  const checkable = !!onCheckAI && (step.kind === "concern" || step.kind === "question");

  // Deterministic grounding check, at read time against the PR's real files —
  // same reasoning as `mergeDeepTour`: the PR keeps moving, so a grade computed
  // when the tour was generated could outlive the diff it describes. Only a
  // downgrade is surfaced; annotating every well-anchored stop would be noise.
  const evidence = useMemo(() => verifyStep(step, files), [step, files]);

  async function runCheck() {
    if (!onCheckAI || checking) return;
    setChecking(true);
    try {
      const r = await onCheckAI(step);
      if (r) setResult(r);
    } finally {
      setChecking(false);
    }
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
      await onPost(b.trim());
      setPostedGh(true);
    } catch (e) {
      toast.error(`Couldn't post — ${String(e)}`);
    } finally {
      setPosting(false);
    }
  }

  return (
    <section ref={setRef} className="animate-tour-fade-in">
      {/* sticky header — the current stop stays pinned while you read it.
          Opaque so the diff scrolls cleanly *under* it (no bleed-through). The
          pinning itself marks "where you are", so the row stays neutral. */}
      <div className="sticky top-0 z-20 -mx-5 flex items-center gap-2 border-b border-b-hairline bg-background px-5 py-2 shadow-sm">
        <span aria-hidden className={cn("absolute inset-y-0 left-0 w-0.5", kind.dot)} />
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-2xs font-medium tabular-nums text-muted-foreground">
          {index + 1}
        </span>
        <span
          className={cn("inline-flex shrink-0 items-center gap-1 text-xs font-medium", kind.text)}
        >
          <Icon className="size-3.5" />
          {kind.label}
        </span>
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {step.title}
        </h3>
        <button
          type="button"
          onClick={() => onOpenFile(step.path, step.line)}
          aria-label={`Open ${step.path} in the diff`}
          className="inline-flex shrink-0 items-center gap-1.5 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <FileCode className="size-3.5" />
          {step.path.split("/").pop()}:{step.line}
          {step.endLine ? `-${step.endLine}` : ""}
        </button>
        {onDismiss && (
          <IconButton
            label="Dismiss this stop"
            icon={X}
            size="icon-xs"
            onClick={onDismiss}
            className="shrink-0 text-muted-foreground/60 hover:text-foreground"
          />
        )}
      </div>

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
              Couldn't verify this against the diff — {evidence.reason} Read the source before
              acting on it.
            </span>
          </div>
        )}
        <div>
          <InlineDiff files={files} path={step.path} line={step.line} endLine={step.endLine} />
        </div>

        {step.detail && (
          <MarkdownBody className="mt-3 text-foreground/90">{step.detail}</MarkdownBody>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {checkable && !result && (
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

        {behavior && <BehaviorPanel diff={behavior} onClose={() => setBehavior(null)} />}

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
              <Button size="xs" variant="ghost" onClick={() => setResult(null)}>
                Keep it
              </Button>
              {onDismiss && (
                <Button size="xs" variant="secondary" onClick={onDismiss}>
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
            onSubmit={primaryPost ? (b) => post(b) : (b) => onAdd(b)}
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
            onSecondary={canPost ? (primaryPost ? (b) => onAdd(b) : (b) => post(b)) : undefined}
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
};

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

  const window = useMemo(() => {
    const hunks = parsePatch(file?.patch ?? null);
    const inRange = (nl: number | null | undefined) => nl != null && nl >= lo && nl <= hi;
    // The hunk that actually contains the anchor line, else the first hunk that
    // reaches past it. NO blind `hunks[0]` fallback — for a hallucinated/out-of-
    // range line we'd rather show the honest "not in this diff" note than a
    // confidently-wrong slice of unrelated code.
    const hunk =
      hunks.find((h) => h.lines.some((l) => inRange(l.newLine))) ??
      hunks.find((h) => h.lines.some((l) => (l.newLine ?? 0) >= lo));
    if (!hunk) return null;
    const rows = hunk.lines.filter((l) => l.kind !== "hunk");
    let first = rows.findIndex((l) => inRange(l.newLine));
    let last = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (inRange(rows[i].newLine)) {
        last = i;
        break;
      }
    }
    if (first < 0) {
      // Range not present as added lines — center on the closest line.
      const c = rows.findIndex((l) => (l.newLine ?? 0) >= lo);
      first = last = c < 0 ? 0 : c;
    }
    const CTX = 4;
    const from = Math.max(0, first - CTX);
    const to = Math.min(rows.length, last + CTX + 1);
    return rows.slice(from, to);
  }, [file?.patch, lo, hi]);

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
    <div className="overflow-x-auto rounded-lg border border-border/40 bg-card/60 py-1 font-mono text-xs leading-[1.5]">
      {window.map((l, i) => {
        const num = l.newLine ?? l.oldLine;
        const hit = inRange(l.newLine);
        return (
          <div
            key={i}
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
                "w-3 shrink-0 text-center",
                l.kind === "add" && "text-success/80",
                l.kind === "del" && "text-destructive/80",
              )}
            >
              {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
            </span>
            <pre
              className="min-w-0 flex-1 whitespace-pre-wrap break-words pr-3 text-foreground/90"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: Prism-highlighted
              dangerouslySetInnerHTML={{ __html: highlightLine(l.text, lang) || "&nbsp;" }}
            />
          </div>
        );
      })}
    </div>
  );
}
