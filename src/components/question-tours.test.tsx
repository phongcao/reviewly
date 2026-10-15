import { QuestionAnswerView } from "@/components/question-tours";
import type { QuestionTour } from "@/stores/question-tours";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

const q = (o: Partial<QuestionTour>): QuestionTour => ({
  id: "q1",
  question: "How does billing work?",
  status: "done",
  answer: "Searched for `invoice` and `charge` in `src/`. Nothing conclusive.",
  steps: [],
  headSha: "h1",
  askedAt: 1,
  ...o,
});

const render = (tour: QuestionTour, stale = false) =>
  renderToStaticMarkup(
    <QuestionAnswerView
      q={tour}
      subject="repo:a/b"
      root="/tmp/repo"
      stale={stale}
      onAgain={() => {}}
      onRemove={() => {}}
      onOpenFile={() => {}}
    />,
  );

describe("QuestionAnswerView", () => {
  it("renders an answer with no steps as 'No conclusive answer', with what was searched", () => {
    const html = render(q({}));
    expect(html).toContain("No conclusive answer");
    expect(html).toContain("Nothing conclusive.");
  });

  it("marks a stale answer", () => {
    expect(render(q({}), true)).toContain("has moved since");
  });

  it("shows progress while pending and the error when failed", () => {
    expect(render(q({ status: "pending" }))).toContain("Tracing the answer");
    expect(render(q({ status: "failed", error: "Interrupted. Ask again." }))).toContain(
      "Interrupted",
    );
  });
});
