import { DETAIL_STYLE_CLAUSE, STE_STYLE_CLAUSE, buildQuestionTourSystem } from "@/lib/ai/prompts";
import {
  QUESTION_MAX_STEPS,
  isNotFound,
  parseQuestionKey,
  parseQuestionTour,
  questionKey,
} from "@/lib/question-tour";
import { useQuestionTours } from "@/stores/question-tours";
import { beforeEach, describe, expect, it } from "vitest";

describe("buildQuestionTourSystem", () => {
  const question = 'How does "Check all" decide which stops to send?';
  const p = buildQuestionTourSystem({ question, map: { summary: "A desktop PR review app." } });

  it("carries the question verbatim and the map summary", () => {
    expect(p).toContain(question);
    expect(p).toContain("A desktop PR review app.");
  });

  it("carries the no-answer rule", () => {
    expect(p).toContain('return an EMPTY "steps" array');
    expect(p).toContain("what you searched for");
    expect(p).toContain("Do not guess.");
  });

  it("asks for an execution path of 3 to 10 stops, in STE", () => {
    expect(p).toContain("EXECUTION PATH");
    expect(p).toContain("3 to 10 stops");
    expect(p).toContain(STE_STYLE_CLAUSE);
    expect(p).toContain(DETAIL_STYLE_CLAUSE);
  });
});

describe("parseQuestionTour", () => {
  const step = (i: number) => ({
    path: "src/a.ts",
    line: i + 1,
    kind: "orient",
    title: `Stop ${i}`,
    detail: "d",
  });

  it("accepts an answer with empty steps as a valid not-found result", () => {
    const r = parseQuestionTour(
      JSON.stringify({ answer: "Searched for `oauth` in `src/`; nothing conclusive.", steps: [] }),
    );
    expect(r).toEqual({ answer: "Searched for `oauth` in `src/`; nothing conclusive.", steps: [] });
    expect(r && isNotFound(r)).toBe(true);
  });

  it("parses an answer with steps, capped at 10, with PR-only fields dropped", () => {
    const steps = Array.from({ length: 14 }, (_, i) => ({ ...step(i), suggestion: "post me" }));
    const r = parseQuestionTour(
      `\`\`\`json\n${JSON.stringify({ answer: "It works so.", steps })}\n\`\`\``,
    );
    expect(r?.answer).toBe("It works so.");
    expect(r?.steps).toHaveLength(QUESTION_MAX_STEPS);
    expect(r?.steps[0].suggestion).toBeUndefined();
  });

  it("returns null when there is neither an answer nor a step", () => {
    expect(parseQuestionTour("Sorry, I can't.")).toBeNull();
    expect(parseQuestionTour('{"answer":"","steps":[]}')).toBeNull();
  });
});

describe("question keys and store", () => {
  beforeEach(() => useQuestionTours.setState({ byRepo: {} }));

  it("round-trips the key", () => {
    expect(parseQuestionKey(questionKey("abc", "acme/shop"))).toEqual({
      id: "abc",
      repo: "acme/shop",
    });
    expect(parseQuestionKey("repo-tour:l1@acme/shop")).toBeNull();
  });

  it("keeps the latest 20 questions, newest first, and lands answers by id", () => {
    const s = useQuestionTours.getState();
    for (let i = 0; i < 22; i++)
      s.ask("repo:a/b", { id: `q${i}`, question: `Q${i}`, headSha: "h" });
    const list = useQuestionTours.getState().byRepo["repo:a/b"];
    expect(list).toHaveLength(20);
    expect(list[0].id).toBe("q21");
    s.land("repo:a/b", "q21", { answer: "A.", steps: [], provider: "claude" });
    expect(useQuestionTours.getState().byRepo["repo:a/b"][0]).toMatchObject({
      status: "done",
      answer: "A.",
    });
  });
});
