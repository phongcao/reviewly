import { MarkdownBody } from "@/components/markdown-body";
import { TooltipFor } from "@/components/tooltip-for";
import { ClaimRows } from "@/components/tour/claim-rows";
import { CodeSpans } from "@/components/tour/code-spans";
import { GradeLabel, REPO_GRADE_HELP } from "@/components/tour/grade";
import type { KindLabels } from "@/components/tour/kinds";
import { type TourProgress, idKeyedProgress } from "@/components/tour/progress";
import { StepHeader } from "@/components/tour/step-header";
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
import { useRepoEvidence } from "@/lib/ai/use-repo-evidence";
import {
  CHECK_CONCURRENCY,
  pendingClaimChecks,
  useStepCheckRunner,
} from "@/lib/ai/use-step-checks";
import type { StepEvidence } from "@/lib/ai/verify";
import { REPO_WINDOW } from "@/lib/ai/verify-repo";
import { type CheckRecord, stepTrust } from "@/lib/claim-check";
import { RISK_LABEL } from "@/lib/coverage";
import { stepId } from "@/lib/deep-tour";
import {
  type GuidedPlan,
  type GuidedStep,
  activeLayerPos,
  layerReadCounts,
  tourLayerIndex,
} from "@/lib/guided";
import { detectLanguage, highlightLine } from "@/lib/lang";
import { repoCoverage } from "@/lib/repo-coverage";
import { HEAD_LINES } from "@/lib/repo-structure";
import { buildRepoTourJobs, mergeRepoTour, parseRepoTourKey, pendingLayers } from "@/lib/repo-tour";
import { type FileHead, type RepoInfo, invoke } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useRepoExplain } from "@/stores/repo-explain";
import type { RepoMapEntry } from "@/stores/repo-map";
import { type RepoTourEntry, useRepoTour, useRepoTourGen } from "@/stores/repo-tour";
import { runKey, useStepCheckRuns, useStepChecks } from "@/stores/step-checks";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronRight,
  Code2,
  Compass,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { Fragment, type ReactNode, memo, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

/** In a codebase tour a `concern` is a trap for a newcomer, not a review comment. */
const KIND_LABELS: KindLabels = { concern: "Pitfall" };

/**
 * Start touring layers: the given ids, or every layer with no batch yet.
 * `force` redoes the toured ones too. Always built on the map as it is now.
 */
export function startRepoTour(
  { owner, repo, root, entry }: { owner: string; repo: string; root: string; entry: RepoMapEntry },
  only?: string[],
  force = false,
): void {
  const repoKey = `${owner}/${repo}`;
  const subject = `repo:${repoKey}`;
  const snap = { map: entry.map, modules: entry.modules, edges: entry.edges };
  useRepoTour.getState().begin(subject, snap, entry.headSha);
  const cur = useRepoTour.getState().byRepo[subject];
  const targets = only ?? (force || !cur ? undefined : pendingLayers(cur));
  if (targets && targets.length === 0) return;
  if (force && !only)
    for (const l of entry.map.layers) useRepoTour.getState().dropLayer(subject, l.id);
  const jobs = buildRepoTourJobs(snap, targets).map((j) => ({
    ...j,
    headSha: entry.headSha,
    cwd: root,
  }));
  useRepoTourGen.getState().enqueue(repoKey, jobs);
}

/**
 * The codebase tour: one AI call per map layer, run in the clone, merged in map
 * order. Graded against the file at `HEAD`, checkable claim by claim, with a
 * coverage strip of what it has not explored. Read like the PR guided tour —
 * a rail of stops by layer, a reading pane, and a stepper — in a full-height
 * view of its own.
 */
export function CodebaseTour({
  owner,
  repo,
  root,
  entry,
  nav,
  onOpenFile,
}: {
  owner: string;
  repo: string;
  root: string;
  entry: RepoMapEntry;
  /** The Explain sub-view switch, drawn first in the header row. */
  nav?: ReactNode;
  onOpenFile: (path: string, line?: number) => void;
}) {
  const repoKey = `${owner}/${repo}`;
  const subject = `repo:${repoKey}`;
  const tour = useRepoTour((s) => s.byRepo[subject]);
  const gen = useRepoTourGen((s) => s.byRepo[repoKey]);
  const info = useQuery({
    queryKey: ["git-repo-info", root],
    queryFn: () => invoke<RepoInfo>("git_repo_info", { path: root }),
    staleTime: 10_000,
    retry: false,
  });
  const running = gen?.running ?? [];
  const queued = gen?.queued ?? [];
  const busy = running.length + queued.length > 0;

  // Re-attach to layers the backend is still running after a remount.
  useEffect(() => {
    invoke<string[]>("ai_inflight")
      .then((keys) => {
        const mine = keys
          .map(parseRepoTourKey)
          .filter((k): k is { layerId: string; repo: string } => k?.repo === repoKey)
          .map((k) => k.layerId);
        useRepoTourGen.getState().adopt(repoKey, mine);
      })
      .catch(() => {});
  }, [repoKey]);

  const run = (only?: string[], force = false) =>
    startRepoTour({ owner, repo, root, entry }, only, force);

  const snapshot = tour?.mapSnapshot;
  const byLayer = tour?.byLayer;
  const plan = useMemo(
    () => (snapshot && byLayer ? mergeRepoTour({ mapSnapshot: snapshot, byLayer }) : null),
    [snapshot, byLayer],
  );
  const dismissed = useMemo(() => new Set(tour?.dismissed ?? []), [tour?.dismissed]);
  const steps = useMemo(
    () => (plan ? plan.steps.filter((s) => !dismissed.has(stepId(s))) : []),
    [plan, dismissed],
  );
  const headSha = tour?.headSha ?? entry.headSha;
  const runner = useStepCheckRunner({ subject, headSha, files: NO_FILES, cwd: root, repo: true });
  const checks = useStepChecks((s) => s.byKey[runner.key]);
  const inFlight = useStepCheckRuns((s) => s.inFlight);
  const batch = useStepCheckRuns((s) => s.batch[runner.key]);
  const [confirmAll, setConfirmAll] = useState<GuidedStep[] | null>(null);
  const unchecked = useMemo(
    () => pendingClaimChecks(steps, checks, (id) => !!inFlight[runKey(runner.key, id)], true),
    [steps, checks, inFlight, runner.key],
  );
  const check = useEvent((step: GuidedStep) => {
    runner.check(step).catch((e) => toast.error(`AI check failed — ${String(e)}`));
  });

  // File heads for the risk scan — one IPC call, cached per commit.
  const heads = useQuery({
    queryKey: ["repo-heads", root, headSha],
    queryFn: () =>
      invoke<FileHead[]>("read_file_heads", {
        path: root,
        files: entry.modules.flatMap((m) => m.files),
        maxLines: HEAD_LINES,
      }),
    enabled: !!tour,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const coverage = useMemo(() => {
    if (!tour) return null;
    const pending = new Set(
      tour.mapSnapshot.map.layers.filter((l) => !tour.byLayer[l.id]).flatMap((l) => l.modules),
    );
    const text = new Map((heads.data ?? []).map((h) => [h.path, h.text]));
    return repoCoverage(plan?.steps ?? [], tour.mapSnapshot.modules, text, pending);
  }, [tour, plan, heads.data]);

  const stale = !!tour && !!info.data?.head && info.data.head !== tour.headSha;
  const layers = tour?.mapSnapshot.map.layers ?? entry.map.layers;
  const done = tour ? layers.filter((l) => tour.byLayer[l.id]).length : 0;
  const failed = Object.entries(gen?.errors ?? {}).filter(([, e]) => !!e);

  // A layer asked for from the Layers view: once its stops are in, the reader
  // jumps to the first one. A layer that came back with nothing to show (or
  // all dismissed) drops the request rather than holding it forever.
  const focusLayer = useRepoExplain((s) => s.focusLayer[subject]);
  const focusIndex = useMemo(() => {
    if (!focusLayer || !plan) return null;
    const i = plan.steps.findIndex((s) => s.layerId === focusLayer && !dismissed.has(stepId(s)));
    return i >= 0 ? i : null;
  }, [focusLayer, plan, dismissed]);
  const focusLanded = !!focusLayer && !!tour?.byLayer[focusLayer];
  useEffect(() => {
    if (focusLanded && focusIndex == null) {
      useRepoExplain.getState().setFocusLayer(subject, undefined);
    }
  }, [focusLanded, focusIndex, subject]);
  const runningTitles =
    running.map((id) => layers.find((l) => l.id === id)?.title ?? id).join(", ") || "queued";

  /** One header row: the view switch, progress, then the stepper (once there
   * are stops to step through) and the tour's actions. */
  const header = (stepper?: ReactNode) => (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-hairline px-5 py-2">
      {nav}
      <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Compass className="size-3.5 shrink-0" />
        <span>Codebase tour</span>
      </div>
      {tour && (
        <span className="text-xs tabular-nums text-muted-foreground/70">
          {done} of {layers.length} layers · {steps.length} stops
        </span>
      )}
      {busy && (
        <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Spinner className="size-3 shrink-0" />
          <span className="truncate">
            {runningTitles}
            {queued.length > 0 && ` · ${queued.length} waiting`}
          </span>
        </span>
      )}
      {failed.map(([id]) => (
        <button
          key={id}
          type="button"
          onClick={() => run([id])}
          className="inline-flex items-center gap-1 rounded bg-destructive/12 px-1.5 py-0.5 text-xs text-destructive hover:bg-destructive/20"
        >
          <AlertTriangle className="size-3" />
          {layers.find((l) => l.id === id)?.title ?? id} failed · Retry
        </button>
      ))}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {stepper}
        {batch ? (
          <Button size="xs" variant="ghost" onClick={runner.cancelAll} disabled={batch.cancelled}>
            <Spinner className="size-3" />
            {batch.done} / {batch.total} checked
            <X className="size-3" />
          </Button>
        ) : (
          unchecked.length > 0 && (
            <TooltipFor label="Check every unchecked stop with AI, claim by claim">
              <Button size="xs" variant="ghost" onClick={() => setConfirmAll(unchecked)}>
                <ShieldCheck className="size-3" />
                Check all · {unchecked.length}
              </Button>
            </TooltipFor>
          )
        )}
        {busy ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => useRepoTourGen.getState().cancelAll(repoKey)}
          >
            <X className="size-3" />
            Stop
          </Button>
        ) : !tour ? null : done < layers.length ? (
          <Button size="xs" variant="outline" onClick={() => run()}>
            <RefreshCw className="size-3" />
            Continue · {layers.length - done} left
          </Button>
        ) : (
          <Button size="xs" variant="ghost" onClick={() => run(undefined, true)}>
            <RefreshCw className="size-3" />
            Regenerate
          </Button>
        )}
      </div>
    </div>
  );

  const banners = (
    <>
      {stale && (
        <div className="flex items-center gap-2 bg-warning/10 px-5 py-1.5 text-xs text-warning">
          <AlertTriangle className="size-3 shrink-0" />
          <span className="min-w-0 flex-1">
            This tour was made on <code>{tour?.headSha.slice(0, 7)}</code>; <code>HEAD</code> is now{" "}
            <code>{info.data?.head.slice(0, 7)}</code>. Anchors may have moved.
          </span>
          <Button
            size="xs"
            variant="ghost"
            className="shrink-0"
            onClick={() => run(undefined, true)}
          >
            Regenerate
          </Button>
        </div>
      )}
      {coverage && (
        <div className="px-5 pt-2">
          <ExploredStrip coverage={coverage} />
        </div>
      )}
    </>
  );

  const dialog = (
    <AlertDialog open={confirmAll != null} onOpenChange={(o) => !o && setConfirmAll(null)}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Check {confirmAll?.length ?? 0} stops with AI?</AlertDialogTitle>
          <AlertDialogDescription>
            This makes {confirmAll?.length ?? 0} AI calls, {CHECK_CONCURRENCY} at a time. Each one
            checks a stop claim by claim against the file at <code>HEAD</code>, without seeing the
            rest of the tour. You can stop the run and keep what has landed.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" size="sm" />}>
            Cancel
          </AlertDialogClose>
          <Button
            size="sm"
            onClick={() => {
              const all = confirmAll;
              setConfirmAll(null);
              if (all) {
                void runner.checkAll(all).then((r) => {
                  if (r.failed > 0) toast.error(`${r.failed} of ${r.done} checks failed`);
                });
              }
            }}
          >
            <ShieldCheck className="size-3.5" />
            Check all
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );

  if (tour && plan && steps.length > 0) {
    return (
      <>
        <RepoTourReader
          key={subject}
          subject={subject}
          root={root}
          headSha={headSha}
          plan={plan}
          tour={tour}
          checks={checks}
          checkKey={runner.key}
          focusIndex={focusIndex}
          onFocusConsumed={() => useRepoExplain.getState().setFocusLayer(subject, undefined)}
          inFlight={inFlight}
          onCheck={check}
          onOpenFile={onOpenFile}
          header={header}
          banners={banners}
        />
        {dialog}
      </>
    );
  }

  // Nothing to read yet: say why, and offer the one action that helps.
  const allDismissed = !!plan && plan.steps.length > 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header()}
      {banners}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        {busy ? (
          <>
            <Spinner className="size-5 text-muted-foreground" />
            <p className="max-w-md text-xs text-muted-foreground">
              Touring {runningTitles}… Stops appear here layer by layer; you can start reading as
              soon as the first one lands.
            </p>
          </>
        ) : allDismissed ? (
          <>
            <p className="text-sm font-medium text-foreground">
              All {plan.steps.length} stops dismissed
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => useRepoTour.getState().restoreDismissed(subject)}
            >
              <RotateCcw className="size-3.5" />
              Restore them
            </Button>
          </>
        ) : tour ? (
          <>
            <p className="text-sm font-medium text-foreground">No stops yet</p>
            <p className="max-w-md text-xs text-muted-foreground">
              {done < layers.length
                ? `${layers.length - done} of ${layers.length} layers haven't been toured.`
                : "The toured layers came back without stops."}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => run(undefined, done >= layers.length)}
            >
              <RefreshCw className="size-3.5" />
              {done < layers.length ? "Continue" : "Regenerate"}
            </Button>
          </>
        ) : (
          <>
            <Compass className="size-8 text-muted-foreground/60" strokeWidth={1.5} />
            <div>
              <p className="text-sm font-medium text-foreground">Tour this codebase</p>
              <p className="mt-1 max-w-md text-xs text-muted-foreground">
                One AI call per layer, run inside your clone. Each stop is anchored to a line at{" "}
                <code>HEAD</code>, graded, and can be checked claim by claim.
              </p>
            </div>
            <Button size="sm" onClick={() => run()}>
              <Sparkles className="size-3.5" />
              Tour all {layers.length} layers
            </Button>
          </>
        )}
      </div>
      {dialog}
    </div>
  );
}

/**
 * The tour once it has stops: rail, reading pane, stepper. Mounted only then,
 * so the cursor is seeded from the resume point after the persisted tour has
 * loaded rather than before.
 */
function RepoTourReader({
  subject,
  root,
  headSha,
  plan,
  tour,
  checks,
  checkKey,
  inFlight,
  onCheck,
  onOpenFile,
  header,
  banners,
  focusIndex,
  onFocusConsumed,
}: {
  subject: string;
  root: string;
  headSha: string;
  plan: GuidedPlan;
  tour: RepoTourEntry;
  checks: Record<string, CheckRecord> | undefined;
  checkKey: string;
  inFlight: Record<string, unknown>;
  onCheck: (step: GuidedStep) => void;
  onOpenFile: (path: string, line?: number) => void;
  header: (stepper: ReactNode) => ReactNode;
  banners: ReactNode;
  /** A stop to jump to once (the first of a layer asked for from Layers). */
  focusIndex: number | null;
  onFocusConsumed: () => void;
}) {
  const ids = useMemo(() => plan.steps.map(stepId), [plan]);
  const { dismissed: dismissedIds, seen: seenIds, lastActiveId, collapsedLayers } = tour;
  const progress = useMemo<TourProgress>(() => {
    const s = useRepoTour.getState();
    return idKeyedProgress(
      ids,
      { dismissed: dismissedIds, seen: seenIds, lastActiveId, collapsedLayers },
      {
        markSeen: (id) => s.markSeen(subject, id),
        setLastActive: (id) => s.setLastActive(subject, id),
        dismiss: (id) => s.dismiss(subject, id),
        restoreDismissed: () => s.restoreDismissed(subject),
        toggleLayerCollapsed: (id) => s.toggleLayerCollapsed(subject, id),
        setLayersCollapsed: (layerIds, c) => s.setLayersCollapsed(subject, layerIds, c),
      },
    );
  }, [ids, dismissedIds, seenIds, lastActiveId, collapsedLayers, subject]);

  const visible = useMemo(
    () => plan.steps.map((_, i) => i).filter((i) => !progress.dismissed.has(i)),
    [plan.steps, progress.dismissed],
  );
  // Graded over every stop, not just the visible ones: indices then line up
  // with the plan, and a dismiss doesn't send every stop back to "checking".
  const evidence = useRepoEvidence(root, headSha, plan.steps);
  const dismiss = useEvent(progress.dismiss);
  const open = useEvent(onOpenFile);

  const nav = useTourNavigation({
    visible,
    initial: Math.max(0, Math.min(progress.lastActive, plan.steps.length - 1)),
    onActive: (i) => {
      progress.markSeen(i);
      progress.setLastActive(i);
    },
    onOpen: (i) => {
      const step = plan.steps[i];
      if (step) onOpenFile(step.path, step.line);
    },
    onDismiss: dismiss,
    preserveBy: ids,
  });
  const { active, pos, atFirst, atLast, move, jumpTo, scrollRef, setStepRef } = nav;

  const layerIndex = useMemo(
    () => tourLayerIndex(visible, plan.steps, plan.layers),
    [visible, plan.steps, plan.layers],
  );
  const layerDone = useMemo(
    () => layerReadCounts(visible, plan.steps, progress.seen),
    [visible, plan.steps, progress.seen],
  );
  // Declared after the navigation hook, so on mount it runs after the resume
  // jump and wins over it.
  const consumeFocus = useEvent(onFocusConsumed);
  useEffect(() => {
    if (focusIndex == null) return;
    jumpTo(focusIndex);
    consumeFocus();
  }, [focusIndex, jumpTo, consumeFocus]);

  const { activeLayer, layerPos } = activeLayerPos(
    layerIndex.layerById,
    visible,
    plan.steps,
    active,
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header(
        <TourStepper
          activeLayer={activeLayer}
          layerPos={layerPos}
          layerCount={activeLayer ? (layerIndex.layerCounts.get(activeLayer.id) ?? 0) : 0}
          pos={pos}
          total={visible.length}
          atFirst={atFirst}
          atLast={atLast}
          onMove={move}
        />,
      )}
      {banners}
      <div className="mt-2 flex min-h-0 flex-1">
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
          kindLabels={KIND_LABELS}
        />
        {/* No top padding here: container padding insets the sticky stop
            header, leaving a gap above it. The spacer scrolls away cleanly. */}
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
          <div aria-hidden className="h-4" />
          {plan.tour && (
            <div className="mb-5 rounded-lg bg-card/40 px-3.5 py-3">
              <p className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
                <Compass className="size-4 text-muted-foreground" />
                How to read this codebase
              </p>
              <MarkdownBody>{plan.tour}</MarkdownBody>
            </div>
          )}
          {visible.map((i) => {
            const step = plan.steps[i];
            const id = ids[i];
            const head = layerIndex.layerHeads.get(i);
            return (
              <Fragment key={id}>
                {head && (
                  <LayerDivider layer={head} count={layerIndex.layerCounts.get(head.id) ?? 0} />
                )}
                <RepoStop
                  setRef={setStepRef}
                  index={i}
                  step={step}
                  root={root}
                  evidence={evidence[i] ?? null}
                  check={checks?.[id]}
                  checking={!!inFlight[runKey(checkKey, id)]}
                  onCheck={onCheck}
                  onDismiss={dismiss}
                  onOpenFile={open}
                />
              </Fragment>
            );
          })}
          <TourEnd
            atLast={atLast}
            endMessage="That's the whole tour."
            onNext={() => move(1)}
            dismissedCount={progress.dismissed.size}
            onRestore={progress.restoreDismissed}
          />
        </div>
      </div>
    </div>
  );
}

const NO_FILES: never[] = [];

/** "Explored", not "Reviewed": the share of source lines in modules the
 * tour has a stop in, and the unexplored modules that look sensitive. */
function ExploredStrip({ coverage }: { coverage: ReturnType<typeof repoCoverage> }) {
  const [open, setOpen] = useState(false);
  const total = Object.values(coverage.lines).reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const pct = Math.round((coverage.lines.toured / total) * 100);
  const gaps = coverage.modules.filter((m) => m.bucket === "unexplored");
  return (
    <div className="text-2xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className="text-muted-foreground/60">Explored</span>
        <span className="font-medium tabular-nums text-foreground/80">
          {coverage.lines.toured.toLocaleString()} of {total.toLocaleString()} lines ({pct}%)
        </span>
        {coverage.counts.pending > 0 && (
          <span className="tabular-nums">· {coverage.counts.pending} modules queued</span>
        )}
        {coverage.counts.tests + coverage.counts.skippable > 0 && (
          <span className="tabular-nums">
            · {coverage.counts.tests + coverage.counts.skippable} test or skippable
          </span>
        )}
        {gaps.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium",
              coverage.atRisk.length > 0
                ? "bg-warning/12 text-warning hover:bg-warning/20"
                : "bg-foreground/5 text-foreground/70 hover:bg-foreground/10",
            )}
          >
            {coverage.atRisk.length > 0 && <AlertTriangle className="size-3" />}
            {gaps.length} module{gaps.length === 1 ? "" : "s"} unexplored
            {coverage.atRisk.length > 0 && ` · ${coverage.atRisk.length} sensitive`}
            <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
          </button>
        )}
      </div>
      {open && (
        <ul className="mt-1.5 space-y-px rounded-lg bg-foreground/[0.03] p-1.5">
          {gaps
            .sort((a, b) => b.module.lines - a.module.lines)
            .map((g) => (
              <li key={g.module.id} className="flex items-center gap-2 px-1.5 py-1 font-mono">
                <span className="min-w-0 flex-1 truncate text-foreground/80">{g.module.id}</span>
                {g.risks.map((r) => (
                  <span key={r} className="rounded-full bg-warning/12 px-1.5 py-px text-warning">
                    {RISK_LABEL[r]}
                  </span>
                ))}
                <span className="tabular-nums">{g.module.lines.toLocaleString()}</span>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One stop: header, source excerpt at `HEAD`, grade, detail, and checks.
 *
 * Memoized, with index- or step-parameterised handlers, for the same reason as
 * the PR tour's stops: moving the cursor should re-render the stops whose look
 * changed, not every excerpt and markdown body in a hundred-stop tour.
 */
export const RepoStop = memo(function RepoStop({
  index,
  step,
  root,
  evidence,
  check,
  checking,
  onCheck,
  onDismiss,
  onOpenFile,
  setRef,
}: {
  index: number;
  step: GuidedStep;
  root: string;
  /** Null while the identifier lookups run. */
  evidence: StepEvidence | null;
  check?: CheckRecord;
  checking: boolean;
  onCheck: (step: GuidedStep) => void;
  /** Absent where a stop can't be hidden (a question tour's answer). */
  onDismiss?: (index: number) => void;
  onOpenFile: (path: string, line?: number) => void;
  /** Registers the section with the tour's cursor (`useTourNavigation`). */
  setRef?: (index: number, el: HTMLElement | null) => void;
}) {
  const trust = evidence ? stepTrust(evidence.grade, check) : "unchecked";
  const claims = check?.type === "claims" ? check : null;
  const sectionRef = useCallback((el: HTMLElement | null) => setRef?.(index, el), [setRef, index]);
  return (
    <section ref={sectionRef} className="pb-6">
      <StepHeader
        index={index}
        step={step}
        trust={trust}
        showTrust={trust === "verified" || trust === "contradicted"}
        grade={
          evidence && (
            <GradeLabel
              grade={evidence.grade}
              help={REPO_GRADE_HELP}
              reason={evidence.grade === "heuristic" ? undefined : evidence.reason}
            />
          )
        }
        openLabel={`Open ${step.path} in Code`}
        onOpenFile={onOpenFile}
        onDismiss={onDismiss ? () => onDismiss(index) : undefined}
        kindLabels={KIND_LABELS}
      />
      <div className="min-w-0 pt-3">
        {!evidence ? (
          <p className="mb-2 text-2xs text-muted-foreground">Checking the anchor…</p>
        ) : (
          evidence.grade === "heuristic" && (
            <div className="mb-2 flex items-start gap-2 rounded-lg bg-warning/10 px-2.5 py-2 text-xs text-warning">
              <AlertTriangle className="mt-px size-3 shrink-0" />
              <span>
                Couldn't verify this against the code — <CodeSpans text={evidence.reason ?? ""} />{" "}
                Read the source before relying on it.
              </span>
            </div>
          )
        )}
        <SourceExcerpt root={root} path={step.path} line={step.line} endLine={step.endLine} />
        {step.detail && (
          <MarkdownBody className="mt-3 text-foreground/90">{step.detail}</MarkdownBody>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {!check && (
            <Button size="xs" variant="secondary" loading={checking} onClick={() => onCheck(step)}>
              <Sparkles className="size-3 text-info" />
              Check with AI
            </Button>
          )}
          <Button size="xs" variant="ghost" onClick={() => onOpenFile(step.path, step.line)}>
            <Code2 className="size-3" />
            Open in Code
          </Button>
        </div>
        {claims && (
          <ClaimRows
            record={claims}
            checking={checking}
            onRecheck={() => onCheck(step)}
            onOpenFile={onOpenFile}
          />
        )}
      </div>
    </section>
  );
});

/** The anchored lines at `HEAD`, ±`REPO_WINDOW`, numbered. Not a diff. */
function SourceExcerpt({
  root,
  path,
  line,
  endLine,
}: {
  root: string;
  path: string;
  line: number;
  endLine?: number;
}) {
  // Same query key as the Code tab's viewer, so opening the file is instant.
  const abs = `${root}/${path}`;
  const file = useQuery({
    queryKey: ["file", abs],
    // The path came from the model: keep the read inside the clone.
    queryFn: () => invoke<string>("read_file", { path: abs, root }),
    retry: false,
    staleTime: 30_000,
  });
  const lang = detectLanguage(path);
  const hi = endLine && endLine >= line ? endLine : line;
  const rows = useMemo(() => {
    if (!file.data) return null;
    const lines = file.data.split("\n");
    const from = Math.max(1, line - REPO_WINDOW);
    const to = Math.min(lines.length, hi + REPO_WINDOW);
    const out: { n: number; html: string }[] = [];
    for (let n = from; n <= to; n++)
      out.push({ n, html: highlightLine(lines[n - 1] ?? "", lang) || "&nbsp;" });
    return out;
  }, [file.data, line, hi, lang]);

  if (file.isError || (rows && rows.length === 0)) {
    return (
      <p className="rounded-lg bg-foreground/[0.03] p-2.5 text-xs text-muted-foreground">
        {file.isError
          ? `Can't read ${path} — ${String(file.error)}`
          : `Line ${line} isn't in ${path}.`}
      </p>
    );
  }
  if (!rows) return <div className="h-16 animate-pulse rounded-lg bg-foreground/[0.03]" />;
  return (
    <div className="overflow-x-auto rounded-lg border border-border/40 bg-card/60 py-1 font-mono text-xs leading-[1.5]">
      {rows.map((r) => {
        const hit = r.n >= line && r.n <= hi;
        return (
          <div
            key={r.n}
            className={cn(
              "flex border-l-2 border-transparent",
              hit && "border-foreground/50 bg-foreground/[0.08]",
            )}
          >
            <span className="w-10 shrink-0 select-none px-2 text-right tabular-nums text-muted-foreground/40">
              {r.n}
            </span>
            <pre
              className="min-w-0 flex-1 whitespace-pre-wrap break-words pr-3 text-foreground/90"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: Prism-highlighted, escaped by highlightLine
              dangerouslySetInnerHTML={{ __html: r.html }}
            />
          </div>
        );
      })}
    </div>
  );
}
