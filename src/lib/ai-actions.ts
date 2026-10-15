/** Actions the AI can propose; the app executes them on user confirmation.
 * An `inline_comment` is added to the pending review, not posted directly. */
export type AiAction =
  | { type: "comment"; body: string }
  | { type: "review"; event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; body: string }
  | { type: "inline_comment"; path: string; line: number; body: string; side: "LEFT" | "RIGHT" }
  | { type: "label"; add: string[]; remove: string[] };

export interface ParsedMessage {
  /** Markdown prose with the action blocks stripped out. */
  text: string;
  actions: AiAction[];
}

// Older replies: <action>{json}</action> — robust even when the JSON body contains
// markdown code fences (``` won't terminate the block, unlike a fenced block).
const TAG_RE = /<action>\s*([\s\S]*?)<\/action>/g;
// A fenced code block: its language and body. Fences open and close at the
// start of a line, so ``` inside a JSON string can't start one; an unclosed
// fence runs to the end. Only a ```action block is read for an action — a
// ```json block is how the model quotes JSON from the PR, and quoted JSON is
// not a proposal.
const FENCE_RE = /^[ \t]*```[ \t]*([\w-]*)[^\n]*\n([\s\S]*?)(?:^[ \t]*```[ \t]*$|(?![\s\S]))/gm;
// Current protocol (and the fallback for a malformed wrapper): a bare JSON
// object in the prose. Only an object that starts with a "type" key counts,
// and only on a line of its own (as CHAT_SYSTEM asks), so JSON quoted
// mid-sentence, in a blockquote or in `inline code` stays prose.
const BARE_START_RE = /\{\s*"type"\s*:/g;
const LINE_BEFORE_RE = /^[ \t]*(?:<action>[ \t]*)?$/;
const LINE_AFTER_RE = /^[ \t]*(?:<\/(?:action|invoke)>)?(?=[ \t]*(?:\n|$))/;

/** End index (exclusive) of the JSON object opening at `start`, honoring
 * strings and escapes; -1 when it never closes. */
function objectEnd(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

/** Pull bare (untagged, unfenced) action objects out of `text`. */
function stripBare(text: string, actions: AiAction[]): string {
  let out = "";
  let from = 0;
  for (const m of text.matchAll(BARE_START_RE)) {
    if (m.index < from) continue; // inside an object already taken
    const end = objectEnd(text, m.index);
    if (end < 0) break;
    const lineStart = text.lastIndexOf("\n", m.index - 1) + 1;
    if (!LINE_BEFORE_RE.test(text.slice(lineStart, m.index))) continue;
    // Also drops a wrapper the model half-wrote around it: an unclosed
    // <action>, or one it closed with its tool-call tag (`</invoke>`) by mistake.
    const after = LINE_AFTER_RE.exec(text.slice(end));
    if (!after) continue;
    const action = tryAction(text.slice(m.index, end));
    if (!action) continue;
    actions.push(action);
    out += text.slice(from, m.index).replace(/<action>[ \t]*$/, "");
    from = end + after[0].length;
  }
  return out + text.slice(from);
}

function tryAction(s: string): AiAction | null {
  try {
    return normalize(JSON.parse(s.trim()));
  } catch {
    return null;
  }
}

/** Pull actions out of prose (text outside code fences): tags, then bare objects. */
function stripProse(prose: string, actions: AiAction[]): string {
  const text = prose.replace(TAG_RE, (_match, inner: string) => {
    const action = tryAction(inner);
    if (action) actions.push(action);
    return ""; // strip the tag block whether or not it parsed
  });
  return stripBare(text, actions);
}

/** Pull AI action blocks out of an assistant message, leaving prose behind.
 * Nothing inside a code fence counts except a ```action block. */
export function parseActions(content: string): ParsedMessage {
  const actions: AiAction[] = [];
  let text = "";
  let from = 0;
  for (const m of content.matchAll(FENCE_RE)) {
    text += stripProse(content.slice(from, m.index), actions);
    const action = m[1] === "action" ? tryAction(m[2]) : null;
    if (action) actions.push(action);
    else text += m[0];
    from = m.index + m[0].length;
  }
  text += stripProse(content.slice(from), actions);
  return { text: text.trim(), actions };
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function normalize(o: unknown): AiAction | null {
  if (typeof o !== "object" || o === null) return null;
  const r = o as Record<string, unknown>;
  switch (r.type) {
    case "comment":
      return typeof r.body === "string" ? { type: "comment", body: r.body } : null;
    case "review":
      if (r.event === "APPROVE" || r.event === "REQUEST_CHANGES" || r.event === "COMMENT") {
        return { type: "review", event: r.event, body: typeof r.body === "string" ? r.body : "" };
      }
      return null;
    case "inline_comment":
      if (typeof r.path === "string" && typeof r.line === "number" && typeof r.body === "string") {
        return {
          type: "inline_comment",
          path: r.path,
          line: r.line,
          body: r.body,
          side: r.side === "LEFT" ? "LEFT" : "RIGHT",
        };
      }
      return null;
    case "label":
      return { type: "label", add: strings(r.add), remove: strings(r.remove) };
    default:
      return null;
  }
}

export function actionTitle(a: AiAction): string {
  switch (a.type) {
    case "comment":
      return "Post comment";
    case "review":
      return a.event === "APPROVE"
        ? "Approve pull request"
        : a.event === "REQUEST_CHANGES"
          ? "Request changes"
          : "Submit review comment";
    case "inline_comment":
      return `Pending comment on ${a.path}:${a.line}`;
    case "label": {
      const parts: string[] = [];
      if (a.add.length) parts.push(`+${a.add.join(", ")}`);
      if (a.remove.length) parts.push(`−${a.remove.join(", ")}`);
      return `Update labels ${parts.join("  ")}`;
    }
  }
}
