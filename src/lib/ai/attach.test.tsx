import { MarkdownBody } from "@/components/markdown-body";
import {
  buildFocusedContext,
  echoRefs,
  refForFile,
  refFromLines,
  refFromProse,
  refFromSelection,
  refLocation,
} from "@/lib/ai/attach";
import type { PullFile } from "@/lib/tauri";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * The diff → context-pane path: a reviewer selects lines in the rendered diff,
 * and that selection has to survive the trip to a `ReviewLocation` the pane can
 * open.
 *
 * These run against a real DOM because the mapping deliberately reads the
 * `data-diff-row` attributes rather than the selected text — so a test that
 * stubbed the DOM would be testing nothing. jsdom does no layout, but this path
 * never measures anything, only walks ranges and datasets.
 */

interface Row {
  side?: "LEFT" | "RIGHT";
  newLine?: number;
  oldLine?: number;
  text: string;
}

/** Build the markup `DiffViewer` emits for a list of rows. */
function renderDiff(rows: Row[]): HTMLElement {
  const root = document.createElement("div");
  for (const r of rows) {
    const row = document.createElement("div");
    row.setAttribute("data-diff-row", "");
    if (r.side) row.dataset.side = r.side;
    if (r.newLine != null) row.dataset.newLine = String(r.newLine);
    if (r.oldLine != null) row.dataset.oldLine = String(r.oldLine);
    const pre = document.createElement("pre");
    pre.textContent = r.text;
    row.appendChild(pre);
    root.appendChild(row);
  }
  document.body.appendChild(root);
  return root;
}

/** Select from the start of one row's code to an offset inside another's. */
function select(root: HTMLElement, fromRow: number, toRow: number, toOffset?: number): Selection {
  const pres = root.querySelectorAll("pre");
  const start = pres[fromRow].firstChild as Text;
  const end = pres[toRow].firstChild as Text;
  const range = document.createRange();
  range.setStart(start, 0);
  range.setEnd(end, toOffset ?? end.length);
  const sel = window.getSelection() as Selection;
  sel.removeAllRanges();
  sel.addRange(range);
  return sel;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("refLocation", () => {
  it("anchors a snippet on the first line of its range", () => {
    expect(refLocation(refFromLines("src/a.ts", "RIGHT", 12, 20))).toEqual({
      path: "src/a.ts",
      line: 12,
    });
  });

  it("gives a whole-file ref no line", () => {
    expect(refLocation(refForFile("src/a.ts"))).toEqual({ path: "src/a.ts" });
  });

  it("drops the line for a LEFT-side ref", () => {
    // The pane renders the file at the PR head. An old-file line number doesn't
    // address anything there, and scrolling to it would point at whatever code
    // happens to sit at that offset now — worse than not scrolling at all.
    expect(refLocation(refFromLines("src/a.ts", "LEFT", 12, 20))).toEqual({ path: "src/a.ts" });
  });
});

describe("refFromSelection → refLocation", () => {
  it("maps a unified selection to the first new-file line it covers", () => {
    const root = renderDiff([
      { newLine: 10, text: "const a = 1;" },
      { newLine: 11, text: "const b = 2;" },
      { newLine: 12, text: "const c = 3;" },
    ]);
    const ref = refFromSelection(root, "src/a.ts", "unified", select(root, 1, 2));
    expect(ref).not.toBeNull();
    expect(refLocation(ref as never)).toEqual({ path: "src/a.ts", line: 11 });
  });

  it("falls back to old-file numbering on a pure-deletion selection, and so yields no line", () => {
    const root = renderDiff([
      { oldLine: 40, text: "removed one" },
      { oldLine: 41, text: "removed two" },
    ]);
    const ref = refFromSelection(root, "src/a.ts", "unified", select(root, 0, 1));
    expect(ref?.side).toBe("LEFT");
    expect(ref?.from).toBe(40);
    // Still opens the file — just from the top, rather than at a line that
    // means something different at head.
    expect(refLocation(ref as never)).toEqual({ path: "src/a.ts" });
  });

  it("keeps a split-view drag on the column it was made in", () => {
    const root = renderDiff([
      { side: "LEFT", oldLine: 40, text: "old one" },
      { side: "RIGHT", newLine: 10, text: "new one" },
      { side: "LEFT", oldLine: 41, text: "old two" },
      { side: "RIGHT", newLine: 11, text: "new two" },
    ]);
    const ref = refFromSelection(root, "src/a.ts", "split", select(root, 1, 3));
    expect(ref?.side).toBe("RIGHT");
    expect(refLocation(ref as never)).toEqual({ path: "src/a.ts", line: 10 });
  });

  it("resolves a drag that crosses columns against the new file, not the old", () => {
    // The split grid interleaves the halves in DOM order, so a range spanning
    // both columns "contains" rows from each. The endpoints disagree here, so
    // the code picks RIGHT and discards the LEFT rows — without that, the first
    // contained row is a LEFT one and the whole range gets read as old-file
    // numbering, landing the pane on line 40 of a file where 40 means something
    // else entirely.
    const root = renderDiff([
      { side: "LEFT", oldLine: 40, text: "old one" },
      { side: "RIGHT", newLine: 10, text: "new one" },
      { side: "LEFT", oldLine: 41, text: "old two" },
      { side: "RIGHT", newLine: 11, text: "new two" },
    ]);
    const ref = refFromSelection(root, "src/a.ts", "split", select(root, 0, 3));
    expect(ref?.side).toBe("RIGHT");
    expect(ref?.from).toBe(10);
    expect(refLocation(ref as never)).toEqual({ path: "src/a.ts", line: 10 });
  });

  it("drops an endpoint row the selection only grazes", () => {
    const root = renderDiff([
      { newLine: 10, text: "const a = 1;" },
      { newLine: 11, text: "const b = 2;" },
    ]);
    // Ends at offset 0 of the second row — the drag stopped on the boundary and
    // covers none of its code, so line 11 must not be claimed.
    const ref = refFromSelection(root, "src/a.ts", "unified", select(root, 0, 1, 0));
    expect(ref?.from).toBe(10);
    expect(ref?.to).toBe(10);
  });

  it("returns null for a collapsed selection", () => {
    const root = renderDiff([{ newLine: 10, text: "const a = 1;" }]);
    const sel = window.getSelection() as Selection;
    sel.removeAllRanges();
    expect(refFromSelection(root, "src/a.ts", "unified", sel)).toBeNull();
  });
});

/**
 * The Markdown-preview path: there are no diff rows in rendered prose, so the
 * selection maps back through the source positions `MarkdownBody` stamps on
 * its elements. Rendered for real, so a change in how positions survive
 * rehype-raw / rehype-sanitize shows up here.
 */
function renderProse(md: string, sourceLines = true): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = renderToStaticMarkup(
    <MarkdownBody sourceLines={sourceLines}>{md}</MarkdownBody>,
  );
  document.body.appendChild(root);
  return root;
}

/** Select `text` (a substring of one text node) through the end of `endText`. */
function selectText(root: HTMLElement, text: string, endText = text): Selection {
  const nodes: Text[] = [];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) nodes.push(n as Text);
  const start = nodes.find((n) => n.data.includes(text)) as Text;
  const end = nodes.find((n) => n.data.includes(endText)) as Text;
  const range = document.createRange();
  range.setStart(start, start.data.indexOf(text));
  range.setEnd(end, end.data.indexOf(endText) + endText.length);
  const sel = window.getSelection() as Selection;
  sel.removeAllRanges();
  sel.addRange(range);
  return sel;
}

const README = "# Setup\n\nRun **bun install** first.\nThen start it.\n\n- one\n- two\n";

describe("refFromProse", () => {
  it("maps a highlight to the source lines it was rendered from, and keeps the text", () => {
    const root = renderProse(README);
    const ref = refFromProse(root, "README.md", selectText(root, "one", "two"));
    expect(ref).toMatchObject({
      kind: "snippet",
      path: "README.md",
      side: "RIGHT",
      from: 6,
      to: 7,
    });
    expect(ref?.quote).toBe("one\ntwo");
  });

  it("narrows to the inline element a word sits in", () => {
    const root = renderProse(README);
    const ref = refFromProse(root, "README.md", selectText(root, "bun install"));
    expect(ref?.from).toBe(3);
    expect(ref?.to).toBe(3);
  });

  it("doesn't claim a block the range only touches at offset 0", () => {
    // What a triple-click produces: the range ends at the start of the next block.
    const root = renderProse(README);
    const h1 = root.querySelector("h1")?.firstChild as Text;
    const li = root.querySelector("li")?.firstChild as Text;
    const range = document.createRange();
    range.setStart(h1, 0);
    range.setEnd(li, 0);
    const sel = window.getSelection() as Selection;
    sel.removeAllRanges();
    sel.addRange(range);
    const ref = refFromProse(root, "README.md", sel);
    expect(ref?.from).toBe(1);
    expect(ref?.to).toBe(4);
  });

  it("still attaches path + quote when the render has no source positions", () => {
    const root = renderProse(README, false);
    const ref = refFromProse(root, "README.md", selectText(root, "Then start it."));
    expect(ref).toMatchObject({ kind: "file", path: "README.md", quote: "Then start it." });
    expect(ref?.from).toBeUndefined();
  });

  it("gives two highlights in the same paragraph different ids", () => {
    const root = renderProse("Alpha beta gamma.\n");
    const a = refFromProse(root, "a.md", selectText(root, "Alpha"));
    const b = refFromProse(root, "a.md", selectText(root, "gamma"));
    expect(a?.id).not.toBe(b?.id);
  });
});

describe("quote refs in the prompt", () => {
  const file = {
    filename: "README.md",
    patch: "@@ -1,2 +1,3 @@\n # Setup\n+\n+Run **bun install** first.",
  } as PullFile;

  it("sends the highlighted text and the source lines behind it", () => {
    const out = buildFocusedContext(
      [
        {
          id: "q",
          kind: "snippet",
          path: "README.md",
          side: "RIGHT",
          from: 3,
          to: 3,
          quote: "Run bun install first.",
        },
      ],
      [file],
    );
    expect(out).toContain("## README.md:3 (text highlighted in the rendered document)");
    expect(out).toContain("> Run bun install first.");
    expect(out).toContain("+3\tRun **bun install** first.");
  });

  it("sends just the quote when there are no lines to show", () => {
    const out = buildFocusedContext(
      [{ id: "q", kind: "file", path: "README.md", quote: "Then start it." }],
      [file],
    );
    expect(out).toContain("> Then start it.");
    expect(out).not.toContain("Source lines");
  });

  it("echoes the quote into the transcript", () => {
    expect(echoRefs([{ id: "q", kind: "file", path: "README.md", quote: "Then\nstart it." }])).toBe(
      "> 📎 `README.md` “Then start it.”",
    );
  });
});
