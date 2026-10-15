import { MapIntro, useRepoMapBuilder } from "@/components/codebase-map";
import { CodebaseTour, startRepoTour } from "@/components/codebase-tour";
import { QuestionTours } from "@/components/question-tours";
import { RepoLayers } from "@/components/repo-layers";
import { Segmented } from "@/components/segmented";
import { stepId } from "@/lib/deep-tour";
import { mergeRepoTour } from "@/lib/repo-tour";
import { useQuestionTours } from "@/stores/question-tours";
import { type ExplainView, useRepoExplain } from "@/stores/repo-explain";
import { useRepoTour, useRepoTourGen } from "@/stores/repo-tour";
import { Compass, Layers, MessageCircleQuestion } from "lucide-react";
import { useMemo } from "react";

const VIEWS: readonly ExplainView[] = ["layers", "tour", "ask"];

/**
 * The repository Explain tab: the map read layer by layer (Layers), the
 * codebase tour (Tour), and questions (Ask), each a full-height view of its
 * own. Layers works like a PR's layered review, the tour and the answers like
 * its guided tour.
 */
export function RepoExplain({
  owner,
  repo,
  root,
  onOpenFile,
}: {
  owner: string;
  repo: string;
  /** Absolute path of the local clone. */
  root: string;
  /** Open a repository-relative path in the Code tab. */
  onOpenFile: (path: string, line?: number) => void;
}) {
  const builder = useRepoMapBuilder(owner, repo, root);
  const { subject, entry } = builder;
  const stored = useRepoExplain((s) => s.views[subject]);
  // Anything else (an older build's "overview") opens on Layers.
  const view: ExplainView = stored && VIEWS.includes(stored) ? stored : "layers";
  const setView = (v: ExplainView) => useRepoExplain.getState().setView(subject, v);

  // Counts on the switch: what's waiting in the other views.
  const snapshot = useRepoTour((s) => s.byRepo[subject]?.mapSnapshot);
  const byLayer = useRepoTour((s) => s.byRepo[subject]?.byLayer);
  const dismissed = useRepoTour((s) => s.byRepo[subject]?.dismissed);
  const stops = useMemo(() => {
    if (!snapshot || !byLayer) return undefined;
    const hidden = new Set(dismissed ?? []);
    const { steps } = mergeRepoTour({ mapSnapshot: snapshot, byLayer });
    return steps.filter((s) => !hidden.has(stepId(s))).length;
  }, [snapshot, byLayer, dismissed]);
  const questions = useQuestionTours((s) => s.byRepo[subject]?.length);

  // The layers, the tour and the questions are built on the map; without one
  // there is nothing to switch between.
  if (!entry) return <MapIntro builder={builder} />;

  /** "Tour this layer" from Layers: tour it unless it is toured or on its
   * way, then show its first stop. */
  const tourLayer = (layerId: string) => {
    const repoKey = `${owner}/${repo}`;
    const toured = !!useRepoTour.getState().byRepo[subject]?.byLayer[layerId];
    const gen = useRepoTourGen.getState().byRepo[repoKey];
    const busy =
      !!gen && (gen.running.includes(layerId) || gen.queued.some((j) => j.layerId === layerId));
    if (!toured && !busy) startRepoTour({ owner, repo, root, entry }, [layerId]);
    useRepoExplain.getState().setFocusLayer(subject, layerId);
    setView("tour");
  };

  const nav = (
    <Segmented
      className="shrink-0"
      options={[
        { value: "layers", label: "Layers", icon: Layers, count: entry.map.layers.length },
        { value: "tour", label: "Tour", icon: Compass, count: stops || undefined },
        { value: "ask", label: "Ask", icon: MessageCircleQuestion, count: questions || undefined },
      ]}
      value={view}
      onChange={setView}
    />
  );

  if (view === "tour") {
    return (
      <CodebaseTour
        owner={owner}
        repo={repo}
        root={root}
        entry={entry}
        nav={nav}
        onOpenFile={onOpenFile}
      />
    );
  }
  if (view === "ask") {
    return (
      <QuestionTours
        owner={owner}
        repo={repo}
        root={root}
        entry={entry}
        nav={nav}
        onOpenFile={onOpenFile}
      />
    );
  }
  return (
    <RepoLayers
      owner={owner}
      repo={repo}
      builder={builder}
      entry={entry}
      root={root}
      nav={nav}
      onOpenFile={onOpenFile}
      onTourLayer={tourLayer}
    />
  );
}
