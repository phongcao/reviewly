/**
 * Question tours — a short traced answer to "how does X work?".
 *
 * Parsed separately from `parseGuided` because the honest empty case differs:
 * a tour with no stops needs a verdict to be valid there, while here an
 * `answer` with no steps is exactly the "not found" result the prompt asks for.
 */
import { firstString, stripFence } from "@/lib/ai/json";
import { type GuidedStep, parseGuided } from "@/lib/guided";
import { repoTourPlan } from "@/lib/repo-tour";

/** Most stops a question tour keeps — the prompt asks for 3 to 10. */
export const QUESTION_MAX_STEPS = 10;

/** `question:<id>@owner/repo` — its own `ai:done` namespace. */
export const QUESTION_KEY_PREFIX = "question:";
export const questionKey = (id: string, repo: string): string =>
  `${QUESTION_KEY_PREFIX}${id}@${repo}`;
export function parseQuestionKey(key: string): { id: string; repo: string } | null {
  if (!key.startsWith(QUESTION_KEY_PREFIX)) return null;
  const rest = key.slice(QUESTION_KEY_PREFIX.length);
  const at = rest.indexOf("@");
  if (at <= 0 || at === rest.length - 1) return null;
  return { id: rest.slice(0, at), repo: rest.slice(at + 1) };
}

export interface QuestionAnswer {
  answer: string;
  steps: GuidedStep[];
}

/** Parse a reply. Null only when there is neither an answer nor a step. */
export function parseQuestionTour(out: string): QuestionAnswer | null {
  const s = stripFence(out);
  const answer = firstString(s, "answer").trim();
  const plan = parseGuided(s);
  const steps = plan ? repoTourPlan(plan).steps.slice(0, QUESTION_MAX_STEPS) : [];
  if (!answer && steps.length === 0) return null;
  return { answer, steps };
}

/** True for the "searched, found nothing conclusive" result. */
export const isNotFound = (a: QuestionAnswer): boolean => a.steps.length === 0;
