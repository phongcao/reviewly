import type { RepoMapBuilder } from "@/components/codebase-map";
import { FileTree } from "@/components/file-tree";
import { orderHint } from "@/components/layered-review";
import { MermaidDiagram } from "@/components/mermaid-diagram";
import { RepoCodeView } from "@/components/repo-code-view";
import { TooltipFor } from "@/components/tooltip-for";
import { CodeSpans } from "@/components/tour/code-spans";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Spinner } from "@/components/ui/spinner";
import { useAiAvailable } from "@/lib/ai/use-ai-available";
import { relativeTime } from "@/lib/format";
import { layerMermaid, orderViolations } from "@/lib/layer-edges";
import { RISK_CHIP, RISK_DOT, RISK_LABEL } from "@/lib/layers";
import { isMarkdownPath } from "@/lib/markdown";
import type { RepoLayer } from "@/lib/repo-map";
import { repoEdgePlan, repoLayerEdges } from "@/lib/repo-map";
import type { PullFile } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { type AiProvider, PROVIDER_LABEL } from "@/stores/ai";
import { useRepoExplain } from "@/stores/repo-explain";
import type { RepoMapEntry } from "@/stores/repo-map";
import { useRepoTour, useRepoTourGen } from "@/stores/repo-tour";
import { useReviewPrefs } from "@/stores/review-prefs";
import { useUi } from "@/stores/ui";
import { useViewedFiles } from "@/stores/viewed-files";
import {
  AlertTriangle,
  BookOpenText,
  Check,
  ChevronDown,
  ChevronUp,
  Code2,
  Compass,
  FileCode,
  Info,
  Layers,
  Network,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

/** A repository file in the shape the review file tree reads. `mode="source"`
 * ignores everything but the path. */
const asTreeFile = (path: string): PullFile => ({
  sha: null,
  filename: path,
  status: "modified",
  additions: 0,
  deletions: 0,
  changes: 0,
  patch: null,
  previous_filename: null,
});

/**
 * The Explain tab's Layers view — the repository counterpart of a PR's layered
 * review. A stepper across the map's layers, a briefing for the one being
 * read, and below it only that layer's files beside the file itself, so a
 * newcomer reads the codebase a few coherent modules at a time and in the
 * order the map suggests. Files are marked read as in a PR, per commit.
 */
export function RepoLayers({
  owner,
  repo,
  builder,
  entry,
  root,
  nav,
  onOpenFile,
  onTourLayer,
}: {
  owner: string;
  repo: string;
  builder: RepoMapBuilder;
  entry: RepoMapEntry;
  /** Absolute path of the local clone. */
  root: string;
  /** The Explain sub-view switch, drawn first in the header row. */
  nav: ReactNode;
  /** Open a repository-relative path in the Code tab. */
  onOpenFile: (path: string, line?: number) => void;
  /** Tour one layer: run it if needed, then show its first stop. */
  onTourLayer: (layerId: string) => void;
}) {
  const { subject, info, build, cancel, building, planning, planError, canUseAi, aiName } = builder;
  const { map, modules } = entry;
  const { available } = useAiAvailable();

  const byId = useMemo(() => new Map(modules.map((m) => [m.id, m])), [modules]);
  // Each layer's files in the map's own order: module by module, as planned.
  const layerFiles = useMemo(
    () => map.layers.map((l) => l.modules.flatMap((id) => byId.get(id)?.files ?? [])),
    [map.layers, byId],
  );
  const plan = useMemo(() => repoEdgePlan(map, modules), [map, modules]);
  const edges = useMemo(() => repoLayerEdges(map, entry.edges), [map, entry.edges]);
  const violations = useMemo(() => orderViolations(plan, edges), [plan, edges]);

  // Read progress, per commit — a new head is a different codebase to read.
  const viewedKey = `${subject}@${entry.headSha}`;
  const viewed = useViewedFiles((s) => s.viewed[viewedKey]);
  const setViewed = useViewedFiles((s) => s.setViewed);
  const stats = useMemo(
    () =>
      layerFiles.map((fs) => {
        const read = fs.filter((p) => viewed?.[p]).length;
        return { files: fs.length, read, done: fs.length > 0 && read === fs.length };
      }),
    [layerFiles, viewed],
  );
  const remaining = stats.filter((s) => !s.done).length;

  // The layer and file being read, remembered across the tab unmounting.
  const storedLayer = useRepoExplain((s) => s.layer[subject]);
  const storedFile = useRepoExplain((s) => s.file[subject]);
  const index = Math.max(
    0,
    map.layers.findIndex((l) => l.id === storedLayer),
  );
  const active: RepoLayer | undefined = map.layers[index];
  const files = layerFiles[index] ?? [];
  const current = storedFile && files.includes(storedFile) ? storedFile : (files[0] ?? null);
  const [focus, setFocus] = useState<{ line: number | null; nonce: number }>({
    line: null,
    nonce: 0,
  });
  const treeFiles = useMemo(() => files.map(asTreeFile), [files]);

  const selectFile = useCallback(
    (path: string, line?: number) => {
      useRepoExplain.getState().setFile(subject, path);
      setFocus((f) => ({ line: line ?? null, nonce: f.nonce + 1 }));
    },
    [subject],
  );

  /** Move to a layer and open the first file in it not yet read. */
  const enterLayer = useCallback(
    (i: number) => {
      const layer = map.layers[i];
      if (!layer) return;
      useRepoExplain.getState().setLayer(subject, layer.id);
      const fresh = useViewedFiles.getState().viewed[viewedKey];
      const fs = layerFiles[i] ?? [];
      const next = fs.find((p) => !fresh?.[p]) ?? fs[0];
      if (next) selectFile(next);
    },
    [map.layers, layerFiles, subject, viewedKey, selectFile],
  );

  /** Mark the layer's files read, then move to the next layer with unread files. */
  const completeLayer = useCallback(() => {
    if (!active) return;
    for (const p of files) setViewed(viewedKey, p, true);
    const fresh = useViewedFiles.getState().viewed[viewedKey];
    for (let step = 1; step <= map.layers.length; step++) {
      const i = (index + step) % map.layers.length;
      if ((layerFiles[i] ?? []).some((p) => !fresh?.[p])) {
        enterLayer(i);
        toast.success(`${active.title} read`, { description: `Next: ${map.layers[i].title}` });
        return;
      }
    }
    toast.success("Every layer read");
  }, [active, files, setViewed, viewedKey, map.layers, index, layerFiles, enterLayer]);

  /** A path from the briefing or the entry points: open it in its layer here,
   * or in the Code tab when no layer holds it. */
  const openPath = useCallback(
    (path: string, line?: number) => {
      const i = layerFiles.findIndex((fs) => fs.includes(path));
      if (i < 0) {
        onOpenFile(path, line);
        return;
      }
      useRepoExplain.getState().setLayer(subject, map.layers[i].id);
      selectFile(path, line);
    },
    [layerFiles, map.layers, subject, selectFile, onOpenFile],
  );

  // `[` / `]` move through the layer's files, `n` marks the open one read and
  // moves to the next unread one, `z` folds the briefing — the PR layered
  // review's loop. Ignored while typing.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "z") {
        e.preventDefault();
        useUi.getState().toggleCompactChrome();
        return;
      }
      if (e.key === "m") {
        // Rendered Markdown / source. Only meaningful on a Markdown file, so the
        // key stays free everywhere else.
        if (!isMarkdownPath(current)) return;
        e.preventDefault();
        const prefs = useReviewPrefs.getState();
        prefs.setMarkdownPreview(!prefs.markdownPreview);
        return;
      }
      if (files.length === 0) return;
      const idx = current ? files.indexOf(current) : 0;
      if (e.key === "]") {
        e.preventDefault();
        selectFile(files[(idx + 1) % files.length]);
      } else if (e.key === "[") {
        e.preventDefault();
        selectFile(files[(idx - 1 + files.length) % files.length]);
      } else if (e.key === "n") {
        e.preventDefault();
        if (current) setViewed(viewedKey, current, true);
        const fresh = useViewedFiles.getState().viewed[viewedKey];
        const next = files.find((p, i) => i > idx && !fresh?.[p]) ?? files.find((p) => !fresh?.[p]);
        if (next) selectFile(next);
        else completeLayer();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [files, current, selectFile, setViewed, viewedKey, completeLayer]);

  // Panels under the stepper. "About" starts open until something has been
  // read: it is the "what is this repository" a first visit needs.
  const [aboutOpen, setAboutOpen] = useState(
    () => !Object.keys(useViewedFiles.getState().viewed[viewedKey] ?? {}).length,
  );
  const [mapOpen, setMapOpen] = useState(false);
  const compactPref = useUi((s) => s.compactChrome);
  const toggleCompact = useUi((s) => s.toggleCompactChrome);
  // Scrolling into a file folds the header — the briefing to one line, the
  // panels away — so the file gets the screen. Back at the top it unfolds.
  // Two thresholds, so the fold (which grows the pane) can't flap at the edge.
  const [scrolled, setScrolled] = useState(false);
  const filePane = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const pane = filePane.current;
    if (!pane) return;
    // Scroll doesn't bubble, but a capture listener on an ancestor still sees
    // the viewer's own scroll container, whatever it is.
    function onScroll(e: Event) {
      const el = e.target as HTMLElement;
      // Only the vertical scroller counts: a wide code block or table scrolling
      // sideways must not unfold the header.
      if (!el || el.scrollHeight <= el.clientHeight) return;
      const top = el.scrollTop;
      setScrolled((was) => (was ? top > 4 : top > 48));
    }
    pane.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => pane.removeEventListener("scroll", onScroll, { capture: true });
  }, []);
  // A new file opens at its top.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset per file only
  useEffect(() => setScrolled(false), [current]);
  const compact = compactPref || scrolled;
  const markdownPreview = useReviewPrefs((s) => s.markdownPreview);
  const isMd = isMarkdownPath(current);

  // Whether the active layer has a tour (or one on the way), for its button.
  const repoKey = subject.slice("repo:".length);
  const toured = useRepoTour((s) => (active ? !!s.byRepo[subject]?.byLayer[active.id] : false));
  const touring = useRepoTourGen((s) => {
    const g = s.byRepo[repoKey];
    return (
      !!active &&
      !!g &&
      (g.running.includes(active.id) || g.queued.some((j) => j.layerId === active.id))
    );
  });

  const stale = !!info.data?.head && info.data.head !== entry.headSha;
  const byline =
    entry.provider === "heuristic"
      ? "Computed map, no AI"
      : `Planned by ${PROVIDER_LABEL[entry.provider as AiProvider] ?? entry.provider}`;
  const bylineFull = `${byline} · ${relativeTime(new Date(entry.generatedAt).toISOString())} · at ${entry.headSha.slice(0, 7)} · ${entry.skipped.files} generated or binary file${entry.skipped.files === 1 ? "" : "s"} left out · links come from the top of each file`;

  const activeStats = stats[index];
  const lines = active ? active.modules.reduce((n, id) => n + (byId.get(id)?.lines ?? 0), 0) : 0;
  const late = active
    ? violations
        .filter((e) => e.to === active.id)
        .map((e) => map.layers.findIndex((l) => l.id === e.from) + 1)
        .filter((n) => n > 0)
        .sort((a, b) => a - b)
    : [];
  const violated = new Set(violations.map((e) => e.to));

  const tourButton = (size: "xs" | "sm") =>
    active &&
    (toured || touring || available === true) && (
      <Button size={size} variant="outline" onClick={() => onTourLayer(active.id)}>
        {touring ? <Spinner className="size-3.5" /> : <Compass className="size-3.5" />}
        {toured ? "Read tour" : touring ? "Touring…" : "Tour this layer"}
      </Button>
    );
  const completeButton = (size: "xs" | "sm") =>
    activeStats && (
      <Button
        size={size}
        variant={activeStats.done ? "outline" : "default"}
        onClick={completeLayer}
      >
        {activeStats.done ? "Next layer" : "Mark layer read"}
      </Button>
    );
  const briefingToggle = (
    <TooltipFor label={compact ? "Expand header" : "Compact header"} shortcut="z">
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={compact ? "Expand layer briefing" : "Collapse layer briefing"}
        aria-expanded={!compact}
        // While folded by scrolling, this unfolds without changing the setting.
        onClick={() => (scrolled ? setScrolled(false) : toggleCompact())}
      >
        {compact ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
      </Button>
    </TooltipFor>
  );
  const layerChip = active && activeStats && (
    <>
      <h3 className="max-w-[18rem] truncate text-xs font-medium text-foreground">
        <CodeSpans text={active.title} />
      </h3>
      <span
        className={cn("shrink-0 rounded px-1.5 py-px text-3xs font-medium", RISK_CHIP[active.risk])}
      >
        {RISK_LABEL[active.risk]}
      </span>
      <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
        {activeStats.files} file{activeStats.files === 1 ? "" : "s"} · {lines.toLocaleString()}{" "}
        lines
      </span>
    </>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-hairline px-5 py-2">
        {/* Stepper — the repository at a glance, and the way between layers. */}
        <div className="flex items-center gap-3">
          {nav}
          <TooltipFor label={`Layer ${index + 1} of ${map.layers.length}`}>
            <span className="flex shrink-0 cursor-default items-center gap-1.5 text-xs text-muted-foreground">
              <Layers className="size-3.5" />
              <span className="tabular-nums">
                {index + 1}/{map.layers.length}
                {remaining === 0 ? " · all read" : ` · ${remaining} left`}
              </span>
            </span>
          </TooltipFor>
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto py-0.5">
            {map.layers.map((layer, i) => {
              const s = stats[i];
              const isActive = i === index;
              return (
                <button
                  key={layer.id}
                  type="button"
                  onClick={() => enterLayer(i)}
                  aria-current={isActive ? "step" : undefined}
                  title={`${layer.title} · ${RISK_LABEL[layer.risk]} · ${s.read}/${s.files} read`}
                  className={cn(
                    "flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-xs transition-colors",
                    isActive
                      ? "bg-foreground/[0.08] text-foreground"
                      : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded-full text-3xs tabular-nums",
                      s.done
                        ? "bg-success/15 text-success"
                        : isActive
                          ? "bg-primary text-primary-foreground"
                          : "bg-foreground/[0.08] text-muted-foreground",
                    )}
                  >
                    {s.done ? <Check className="size-2.5" /> : i + 1}
                  </span>
                  <span className="max-w-[11rem] truncate">{layer.title}</span>
                  {violated.has(layer.id) && (
                    <AlertTriangle
                      className="size-3 shrink-0 text-warning"
                      aria-label="Imports from a later layer"
                    />
                  )}
                  {RISK_DOT[layer.risk] && (
                    <span
                      className={cn("size-1.5 shrink-0 rounded-full", RISK_DOT[layer.risk])}
                      aria-hidden
                    />
                  )}
                  <span className="shrink-0 tabular-nums text-muted-foreground/70">
                    {s.read}/{s.files}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <TooltipFor label={bylineFull}>
              <span className="max-w-40 shrink-0 cursor-default truncate text-2xs text-muted-foreground/70">
                {byline}
              </span>
            </TooltipFor>
            <TooltipFor label={aboutOpen ? "Hide what this is" : "What this is"}>
              <Button
                size="icon-xs"
                variant={aboutOpen ? "secondary" : "ghost"}
                aria-label="What this is"
                aria-expanded={aboutOpen}
                onClick={() => setAboutOpen((o) => !o)}
              >
                <Info className="size-3.5" />
              </Button>
            </TooltipFor>
            <TooltipFor label={mapOpen ? "Hide dependency map" : "Dependency map"}>
              <Button
                size="icon-xs"
                variant={mapOpen ? "secondary" : "ghost"}
                aria-label="Dependency map"
                aria-expanded={mapOpen}
                onClick={() => setMapOpen((o) => !o)}
              >
                <Network className="size-3.5" />
              </Button>
            </TooltipFor>
            {planning ? (
              <TooltipFor label={`${aiName} is naming the layers — stop`}>
                <Button size="xs" variant="ghost" onClick={cancel}>
                  <Spinner className="size-3" />
                  <X className="size-3" />
                </Button>
              </TooltipFor>
            ) : (
              <>
                <TooltipFor label="Recompute the structure from the clone">
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Recompute"
                    loading={building}
                    onClick={() => build(false)}
                  >
                    <RefreshCw className="size-3.5" />
                  </Button>
                </TooltipFor>
                {canUseAi && (
                  <Button size="xs" variant="ghost" loading={building} onClick={() => build(true)}>
                    <Sparkles className="size-3" />
                    {entry.provider === "heuristic" ? `Plan with ${aiName}` : "Re-plan"}
                  </Button>
                )}
              </>
            )}
          </div>
        </div>

        {planError && !planning && <p className="mt-2 text-xs text-destructive">{planError}</p>}
        {stale && (
          <div className="mt-2 flex items-center gap-2 rounded-md bg-warning/10 px-2 py-1.5 text-xs text-warning">
            <AlertTriangle className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">
              <code>HEAD</code> moved since this map was made (
              <code>{entry.headSha.slice(0, 7)}</code> → <code>{info.data?.head.slice(0, 7)}</code>
              ).
            </span>
            <button
              type="button"
              onClick={() => build(entry.provider !== "heuristic")}
              className="shrink-0 underline underline-offset-2 hover:no-underline"
            >
              Regenerate
            </button>
          </div>
        )}
        {info.data?.dirty && (
          <div className="mt-2 flex items-center gap-2 rounded-md bg-foreground/[0.04] px-2 py-1.5 text-xs text-muted-foreground">
            <AlertTriangle className="size-3.5 shrink-0" />
            Your clone has uncommitted changes. Files show your working copy.
          </div>
        )}

        {aboutOpen && !scrolled && (
          <div className="mt-2 rounded-md border border-hairline bg-foreground/[0.02] p-2.5">
            <p className="text-sm leading-6 text-foreground/85">
              {map.summary ? (
                <CodeSpans text={map.summary} />
              ) : (
                <span className="text-muted-foreground">
                  No summary yet — a computed map names nothing. Plan it with AI to name the layers.
                </span>
              )}
            </p>
            {map.strategy && (
              <p className="mt-1 text-xs text-muted-foreground">
                <CodeSpans text={map.strategy} />
              </p>
            )}
            {map.entryPoints.length > 0 && (
              <div className="mt-2">
                <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground/60">
                  Where execution starts
                </p>
                <ul className="mt-1 space-y-0.5">
                  {map.entryPoints.map((e) => (
                    <li key={e.path} className="flex items-start gap-2 text-xs">
                      <button
                        type="button"
                        onClick={() => openPath(e.path)}
                        className="inline-flex shrink-0 items-center gap-1 font-mono text-foreground/85 hover:text-foreground hover:underline"
                      >
                        <FileCode className="size-3.5 text-muted-foreground" />
                        {e.path}
                      </button>
                      <span className="text-muted-foreground">
                        <CodeSpans text={e.why} />
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {mapOpen && !scrolled && (
          <div className="mt-2 rounded-md border border-hairline bg-foreground/[0.02] p-2.5">
            {edges.length === 0 ? (
              <p className="text-xs text-muted-foreground">No import links found between layers.</p>
            ) : (
              // The bar doesn't scroll — cap the map so a tall graph scrolls in
              // place instead of pushing the files away.
              <MermaidDiagram
                className="max-h-[45vh] overflow-y-auto"
                code={layerMermaid(plan, edges)}
              />
            )}
          </div>
        )}

        {/* Briefing for the layer in front of the reader — one line when compact. */}
        {active &&
          (!compact ? (
            <div className="mt-2 flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">{layerChip}</div>
                {active.intent && (
                  <p className="mt-1 line-clamp-2 text-sm leading-6 text-muted-foreground">
                    <CodeSpans text={active.intent} />
                  </p>
                )}
                {late.length > 0 && (
                  <p className="mt-1 flex items-center gap-1.5 text-xs text-warning">
                    <AlertTriangle className="size-3 shrink-0" />
                    {orderHint(late)}
                  </p>
                )}
                {active.focus.length > 0 && (
                  <ul className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                    {active.focus.map((f) => (
                      <li
                        key={f}
                        className="flex items-center gap-1.5 text-xs leading-5 text-muted-foreground"
                      >
                        <span className="size-1 shrink-0 rounded-full bg-muted-foreground/50" />
                        <CodeSpans text={f} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {tourButton("sm")}
                {completeButton("sm")}
                {briefingToggle}
              </div>
            </div>
          ) : (
            <div className="mt-1.5 flex items-center gap-2">
              {layerChip}
              <span
                className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                title={active.intent || undefined}
              >
                <CodeSpans text={active.intent} />
              </span>
              <div className="flex shrink-0 items-center gap-1.5">
                {tourButton("xs")}
                {completeButton("xs")}
                {briefingToggle}
              </div>
            </div>
          ))}
      </div>

      <ResizablePanelGroup
        direction="horizontal"
        className="min-h-0 flex-1"
        autoSaveId="repo-layer-panes"
      >
        <ResizablePanel id="tree" order={1} defaultSize={24} minSize={15}>
          <FileTree
            files={treeFiles}
            active={current}
            onSelect={(p) => selectFile(p)}
            loading={false}
            viewedKey={viewedKey}
            mode="source"
          />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="file" order={2} minSize={30}>
          <div ref={filePane} className="flex h-full flex-col">
            {current && (
              <div className="flex items-center gap-2 border-b border-hairline px-4 py-1.5">
                <FileCode className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/85">
                  {current}
                </span>
                {isMd && (
                  <TooltipFor
                    label={
                      markdownPreview
                        ? "Showing rendered Markdown — switch to the source (m)"
                        : "Render this Markdown file as a document (m)"
                    }
                  >
                    <Button
                      size="xs"
                      variant={markdownPreview ? "secondary" : "ghost"}
                      aria-pressed={markdownPreview}
                      onClick={() => useReviewPrefs.getState().setMarkdownPreview(!markdownPreview)}
                    >
                      <BookOpenText className="size-3" />
                      Preview
                    </Button>
                  </TooltipFor>
                )}
                <Button
                  size="xs"
                  variant={viewed?.[current] ? "secondary" : "ghost"}
                  aria-pressed={!!viewed?.[current]}
                  onClick={() => setViewed(viewedKey, current, !viewed?.[current])}
                >
                  <Check className="size-3" />
                  {viewed?.[current] ? "Read" : "Mark read"}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => onOpenFile(current, focus.line ?? undefined)}
                >
                  <Code2 className="size-3" />
                  Open in Code
                </Button>
              </div>
            )}
            <div className="min-h-0 flex-1">
              <RepoCodeView
                root={root}
                path={current ? `${root}/${current}` : null}
                line={focus.line}
                lineNonce={focus.nonce}
                preview={
                  markdownPreview && current
                    ? { owner, repo, sha: info.data?.head ?? entry.headSha, path: current }
                    : null
                }
              />
            </div>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
