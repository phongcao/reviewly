import { RepoStop } from "@/components/codebase-tour";
import { CodeSpans } from "@/components/tour/code-spans";
import { TourEnd, TourStepper } from "@/components/tour/tour-chrome";
import { useEvent } from "@/components/tour/use-event";
import { useTourNavigation } from "@/components/tour/use-tour-navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { buildQuestionTourSystem } from "@/lib/ai/prompts";
import { useAiAvailable } from "@/lib/ai/use-ai-available";
import { useRepoEvidence } from "@/lib/ai/use-repo-evidence";
import { useStepCheckRunner } from "@/lib/ai/use-step-checks";
import { stepId } from "@/lib/deep-tour";
import { relativeTime } from "@/lib/format";
import type { GuidedStep } from "@/lib/guided";
import { parseQuestionKey, questionKey } from "@/lib/question-tour";
import { type RepoInfo, invoke } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { aiInvokeArgs } from "@/stores/ai";
import { type QuestionTour, useQuestionTours } from "@/stores/question-tours";
import { useRepoExplain } from "@/stores/repo-explain";
import type { RepoMapEntry } from "@/stores/repo-map";
import { runKey, useStepCheckRuns, useStepChecks } from "@/stores/step-checks";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, MessageCircleQuestion, RotateCcw, SearchX, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

const NO_FILES: never[] = [];

/** Starting points for an empty Ask view. Generic on purpose: they read well
 * against almost any codebase, and the answer says when one doesn't apply. */
const EXAMPLES = [
  "Where does a request enter, and what handles it?",
  "How is configuration loaded?",
  "What happens when an error is thrown?",
];

/**
 * "Ask how something works": a short tour that traces the answer through the
 * code, with the same stops, grades, and claim checks as the codebase tour.
 * Often more useful to a newcomer than a full tour. Laid out like the tour:
 * the questions down the rail, the open answer in the reading pane.
 */
export function QuestionTours({
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
  const list = useQuestionTours((s) => s.byRepo[subject]) ?? [];
  const { available } = useAiAvailable();
  const [text, setText] = useState("");
  // Remembered across the tab unmounting (every "Open in Code" does).
  const open = useRepoExplain((s) => s.openQuestion[subject]);
  const setOpen = (id: string) => useRepoExplain.getState().setOpenQuestion(subject, id);
  const info = useQuery({
    queryKey: ["git-repo-info", root],
    queryFn: () => invoke<RepoInfo>("git_repo_info", { path: root }),
    staleTime: 10_000,
    retry: false,
  });
  const head = info.data?.head ?? entry.headSha;

  // A question left "pending" by a run that no longer exists (the app
  // restarted mid-call) would spin forever. Settle it on mount.
  useEffect(() => {
    invoke<string[]>("ai_inflight")
      .then((keys) => {
        const live = new Set(
          keys
            .map(parseQuestionKey)
            .filter((k) => k?.repo === repoKey)
            .map((k) => k?.id),
        );
        for (const q of useQuestionTours.getState().byRepo[subject] ?? []) {
          if (q.status === "pending" && !live.has(q.id)) {
            useQuestionTours.getState().fail(subject, q.id, "Interrupted. Ask again.");
          }
        }
      })
      .catch(() => {});
  }, [repoKey, subject]);

  const ask = (question: string) => {
    const q = question.trim();
    if (!q) return;
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    useQuestionTours.getState().ask(subject, { id, question: q, headSha: head });
    setOpen(id);
    setText("");
    invoke("ai_review_bg", {
      key: questionKey(id, repoKey),
      ...aiInvokeArgs(),
      headSha: head,
      cwd: root,
      prompt: buildQuestionTourSystem({ question: q, map: { summary: entry.map.summary } }),
    }).catch((e) => useQuestionTours.getState().fail(subject, id, String(e)));
  };

  const current = list.find((q) => q.id === open) ?? list[0];
  const canAsk = available === true;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-hairline px-5 py-2">
        {nav}
        <form
          className="flex min-w-[16rem] flex-1 items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            ask(text);
          }}
        >
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="How does authentication work? What happens when a job fails?"
            className="h-7 text-sm"
          />
          <Button size="xs" type="submit" disabled={!text.trim() || !canAsk}>
            Ask
          </Button>
        </form>
      </div>

      {list.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <MessageCircleQuestion className="size-8 text-muted-foreground/60" strokeWidth={1.5} />
          <div>
            <p className="text-sm font-medium text-foreground">Ask how something works</p>
            <p className="mt-1 max-w-md text-xs text-muted-foreground">
              A short tour that traces the answer through the code, with the same graded stops as
              the codebase tour.
              {!canAsk && " Set up an AI provider to ask."}
            </p>
          </div>
          <div className="flex max-w-xl flex-wrap justify-center gap-1.5">
            {EXAMPLES.map((q) => (
              <Button key={q} size="xs" variant="outline" disabled={!canAsk} onClick={() => ask(q)}>
                {q}
              </Button>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className="hidden w-60 shrink-0 overflow-y-auto border-r border-hairline px-3 py-4 lg:block">
            <p className="mb-2 px-2 text-3xs font-medium uppercase tracking-wide text-muted-foreground/50">
              Questions
            </p>
            <div className="flex flex-col gap-0.5">
              {list.map((q) => (
                <QuestionRailRow
                  key={q.id}
                  q={q}
                  active={q.id === current?.id}
                  stale={q.headSha !== head}
                  onClick={() => setOpen(q.id)}
                />
              ))}
            </div>
          </aside>
          <div className="flex min-w-0 flex-1 flex-col">
            {/* No rail below `lg`: the questions become chips above the answer. */}
            <div className="flex flex-wrap gap-1.5 px-5 pt-2 lg:hidden">
              {list.map((q) => (
                <button
                  key={q.id}
                  type="button"
                  onClick={() => setOpen(q.id)}
                  title={`${q.question} · ${relativeTime(new Date(q.askedAt).toISOString())}`}
                  className={cn(
                    "inline-flex max-w-[22rem] items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors",
                    q.id === current?.id
                      ? "bg-foreground/[0.09] text-foreground"
                      : "bg-foreground/[0.04] text-muted-foreground hover:text-foreground",
                  )}
                >
                  {q.status === "pending" && <Spinner className="size-3" />}
                  {q.status === "failed" && <AlertTriangle className="size-3 text-destructive" />}
                  <span className="truncate">{q.question}</span>
                </button>
              ))}
            </div>
            {current && (
              <QuestionAnswerView
                key={current.id}
                q={current}
                subject={subject}
                root={root}
                stale={current.headSha !== head}
                onAgain={() => ask(current.question)}
                onRemove={() => useQuestionTours.getState().remove(subject, current.id)}
                onOpenFile={onOpenFile}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** One question in the rail: status, the question, and when it was asked. */
function QuestionRailRow({
  q,
  active,
  stale,
  onClick,
}: {
  q: QuestionTour;
  active: boolean;
  stale: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={q.question}
      className={cn(
        "flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-foreground/[0.04]",
        active && "bg-foreground/[0.05]",
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center pt-0.5">
        {q.status === "pending" ? (
          <Spinner className="size-3" />
        ) : q.status === "failed" ? (
          <AlertTriangle className="size-3 text-destructive" />
        ) : (
          <MessageCircleQuestion
            className={cn("size-3.5", active ? "text-foreground/75" : "text-muted-foreground/50")}
          />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "line-clamp-2 text-xs leading-snug",
            active ? "font-medium text-foreground" : "text-muted-foreground",
          )}
        >
          {q.question}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-3xs text-muted-foreground/60">
          {relativeTime(new Date(q.askedAt).toISOString())}
          {q.status === "done" && q.steps.length > 0 && (
            <span className="tabular-nums">
              · {q.steps.length} stop{q.steps.length === 1 ? "" : "s"}
            </span>
          )}
          {stale && (
            <span className="rounded bg-warning/12 px-1 font-medium text-warning">stale</span>
          )}
        </span>
      </span>
    </button>
  );
}

/** One question's answer, as a compact tour: the question and its actions on
 * top, the answer and its stops in a reading pane of their own. */
export function QuestionAnswerView({
  q,
  subject,
  root,
  stale,
  onAgain,
  onRemove,
  onOpenFile,
}: {
  q: QuestionTour;
  subject: string;
  root: string;
  stale: boolean;
  onAgain: () => void;
  onRemove: () => void;
  onOpenFile: (path: string, line?: number) => void;
}) {
  const header = (stepper?: ReactNode) => (
    <div className="border-b border-hairline px-5 py-2">
      <div className="flex items-center gap-2">
        <p
          className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
          title={q.question}
        >
          {q.question}
        </p>
        {stepper}
        <Button size="xs" variant="ghost" onClick={onAgain} disabled={q.status === "pending"}>
          <RotateCcw className="size-3" />
          Ask again
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="Remove this question" onClick={onRemove}>
          <Trash2 className="size-3" />
        </Button>
      </div>
      {stale && (
        <p className="mt-0.5 text-2xs text-warning">
          Asked at <code>{q.headSha.slice(0, 7)}</code>; <code>HEAD</code> has moved since.
        </p>
      )}
    </div>
  );

  if (q.status === "done" && q.steps.length > 0) {
    return (
      <AnswerTour q={q} subject={subject} root={root} header={header} onOpenFile={onOpenFile} />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header()}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {q.status === "pending" ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Spinner className="size-3" />
            Tracing the answer through the code…
          </p>
        ) : q.status === "failed" ? (
          <p className="text-xs text-destructive">{q.error}</p>
        ) : (
          <div className="rounded-md bg-foreground/[0.04] p-2.5 text-xs">
            <p className="flex items-center gap-1.5 font-medium text-foreground/85">
              <SearchX className="size-3.5" />
              No conclusive answer
            </p>
            {q.answer && (
              <p className="mt-1 leading-5 text-muted-foreground">
                <CodeSpans text={q.answer} />
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** An answer with stops: the answer as the intro, then the stops, with the
 * same cursor and keys as the codebase tour. Answers can't be dismissed. */
function AnswerTour({
  q,
  subject,
  root,
  header,
  onOpenFile,
}: {
  q: QuestionTour;
  subject: string;
  root: string;
  header: (stepper: ReactNode) => ReactNode;
  onOpenFile: (path: string, line?: number) => void;
}) {
  const evidence = useRepoEvidence(root, q.headSha, q.steps);
  const runner = useStepCheckRunner({
    subject,
    headSha: q.headSha,
    files: NO_FILES,
    cwd: root,
    repo: true,
  });
  const checks = useStepChecks((s) => s.byKey[runner.key]);
  const inFlight = useStepCheckRuns((s) => s.inFlight);
  const check = useEvent((step: GuidedStep) => {
    runner.check(step).catch((e) => toast.error(`AI check failed — ${String(e)}`));
  });
  const open = useEvent(onOpenFile);

  const visible = useMemo(() => q.steps.map((_, i) => i), [q.steps]);
  const { pos, atFirst, atLast, move, scrollRef, setStepRef } = useTourNavigation({
    visible,
    initial: 0,
    onOpen: (i) => {
      const step = q.steps[i];
      if (step) onOpenFile(step.path, step.line);
    },
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header(
        <TourStepper
          layerPos={0}
          layerCount={0}
          pos={pos}
          total={visible.length}
          atFirst={atFirst}
          atLast={atLast}
          onMove={move}
        />,
      )}
      {/* No top padding: it would inset the sticky stop header. */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
        <div aria-hidden className="h-4" />
        {q.answer && (
          <p className="mb-5 text-sm leading-6 text-foreground/85">
            <CodeSpans text={q.answer} />
          </p>
        )}
        {q.steps.map((s, i) => (
          <RepoStop
            key={stepId(s)}
            setRef={setStepRef}
            index={i}
            step={s}
            root={root}
            evidence={evidence[i] ?? null}
            check={checks?.[stepId(s)]}
            checking={!!inFlight[runKey(runner.key, stepId(s))]}
            onCheck={check}
            onOpenFile={open}
          />
        ))}
        <TourEnd atLast={atLast} endMessage="That's the whole answer." onNext={() => move(1)} />
      </div>
    </div>
  );
}
