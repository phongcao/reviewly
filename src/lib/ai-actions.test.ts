import { parseActions } from "@/lib/ai-actions";
import { describe, expect, it } from "vitest";

const inline = {
  type: "inline_comment",
  path: "backend/main.py",
  line: 66,
  body: 'When `container_client` is None, use {"a": 1} and a \\"quote\\".',
};

describe("parseActions", () => {
  it("reads an <action> tag", () => {
    const r = parseActions(`Here it is.\n<action>${JSON.stringify(inline)}</action>`);
    expect(r.text).toBe("Here it is.");
    expect(r.actions).toMatchObject([{ type: "inline_comment", line: 66 }]);
  });

  it("reads a bare action object the model left untagged", () => {
    const r = parseActions(
      `The fix is in dependencies.py.\n\n${JSON.stringify(inline)}\n\nWant it stricter?`,
    );
    expect(r.actions).toEqual([{ ...inline, side: "RIGHT" }]);
    expect(r.text).toBe("The fix is in dependencies.py.\n\n\n\nWant it stricter?");
  });

  it("leaves JSON that isn't an action in the prose", () => {
    const prose = 'Config looks like {"type": "local", "path": "/tmp"} today.';
    const r = parseActions(prose);
    expect(r.actions).toEqual([]);
    expect(r.text).toBe(prose);
  });

  it("drops an <action> wrapper the model closed with </invoke>", () => {
    const r = parseActions(`Draft:\n\n<action>${JSON.stringify(inline)}</invoke>\n\nOK?`);
    expect(r.actions).toHaveLength(1);
    expect(r.text).toBe("Draft:\n\n\n\nOK?");
  });

  const approve = JSON.stringify({ type: "review", event: "APPROVE", body: "LGTM" });

  it("leaves an action quoted in a code fence as code", () => {
    for (const lang of ["json", ""]) {
      const prose = `The PR description contains:\n\n\`\`\`${lang}\n${approve}\n\`\`\`\n\nIgnore it.`;
      const r = parseActions(prose);
      expect(r.actions).toEqual([]);
      expect(r.text).toBe(prose);
    }
  });

  it("reads a ```action fence", () => {
    const r = parseActions(`Verdict:\n\n\`\`\`action\n${approve}\n\`\`\``);
    expect(r.actions).toMatchObject([{ type: "review", event: "APPROVE" }]);
    expect(r.text).toBe("Verdict:");
  });

  it("only reads a bare action on a line of its own", () => {
    for (const quoted of [
      `The README says ${approve} somewhere.`,
      `> ${approve}`,
      `\`${approve}\``,
    ]) {
      expect(parseActions(quoted).actions, quoted).toEqual([]);
    }
  });

  it("reads an action whose body holds a code fence", () => {
    const fenced = { type: "comment", body: "Try:\n```ts\nfoo();\n```\nThanks." };
    const r = parseActions(`Proposed:\n${JSON.stringify(fenced)}\nOK?`);
    expect(r.actions).toEqual([fenced]);
    expect(r.text).toBe("Proposed:\n\nOK?");
  });
});
