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
});
