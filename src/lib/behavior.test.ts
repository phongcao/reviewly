import { isPureRefactor, parseBehavior } from "@/lib/behavior";
import { describe, expect, it } from "vitest";

const ok = JSON.stringify({
  symbol: "calculate_price",
  before: ["Sum every item.", "Apply item discounts."],
  after: ["Skip items where `quantity <= 0`.", "Sum the rest.", "Apply item discounts."],
  changes: [{ type: "new_guard", text: "Items where `quantity <= 0` no longer contribute." }],
});

describe("parseBehavior", () => {
  it("parses a well-formed reply", () => {
    const b = parseBehavior(ok);
    expect(b?.symbol).toBe("calculate_price");
    expect(b?.before).toHaveLength(2);
    expect(b?.after).toHaveLength(3);
    expect(b?.changes[0]).toEqual({
      type: "new_guard",
      text: "Items where `quantity <= 0` no longer contribute.",
    });
  });

  it("strips a markdown fence", () => {
    expect(parseBehavior(`\`\`\`json\n${ok}\n\`\`\``)?.symbol).toBe("calculate_price");
  });

  it("ignores a chatty preamble and an illustrative example", () => {
    const chatty = `Sure! For example {"before":["x"],"after":["y"],"changes":[]}\n\nHere it is:\n${ok}`;
    expect(parseBehavior(chatty)?.symbol).toBe("calculate_price");
  });

  it("accepts a bare string in the changes array", () => {
    const b = parseBehavior('{"before":["a"],"after":["b"],"changes":["it changed"]}');
    expect(b?.changes).toEqual([{ type: "behavior_added", text: "it changed" }]);
  });

  it("normalizes near-miss change types", () => {
    const b = parseBehavior(
      '{"before":[],"after":["x"],"changes":[{"type":"refactor","text":"a"},{"type":"signature_change","text":"b"},{"type":"guard","text":"c"}]}',
    );
    expect(b?.changes.map((c) => c.type)).toEqual([
      "refactor_only",
      "contract_change",
      "new_guard",
    ]);
  });

  it("never downgrades an unknown type to refactor_only", () => {
    // Claiming "no behavioral change" on a type we didn't recognize is the one
    // error that hides a real bug.
    const b = parseBehavior('{"before":["a"],"after":["b"],"changes":[{"type":"wat","text":"x"}]}');
    expect(b?.changes[0].type).toBe("behavior_added");
  });

  it("handles an added symbol with no before", () => {
    const b = parseBehavior(
      '{"symbol":"newFn","before":[],"after":["Does a thing."],"changes":[]}',
    );
    expect(b?.before).toEqual([]);
    expect(b?.after).toEqual(["Does a thing."]);
  });

  it("returns null for a reply with no usable content", () => {
    expect(parseBehavior("I couldn't determine the behavior.")).toBeNull();
    expect(parseBehavior('{"before":[],"after":[],"changes":[]}')).toBeNull();
    expect(parseBehavior("")).toBeNull();
  });

  it("drops blank bullets rather than rendering empty rows", () => {
    const b = parseBehavior('{"before":["a","","  "],"after":["b"],"changes":[]}');
    expect(b?.before).toEqual(["a"]);
  });
});

describe("isPureRefactor", () => {
  it("is true only when every stated change is refactor_only", () => {
    expect(
      isPureRefactor({
        symbol: "x",
        before: ["a"],
        after: ["a"],
        changes: [{ type: "refactor_only", text: "reorganized" }],
      }),
    ).toBe(true);
    expect(
      isPureRefactor({
        symbol: "x",
        before: ["a"],
        after: ["b"],
        changes: [
          { type: "refactor_only", text: "reorganized" },
          { type: "new_guard", text: "and a guard" },
        ],
      }),
    ).toBe(false);
  });

  it("is false when nothing was stated at all", () => {
    expect(isPureRefactor({ symbol: "x", before: ["a"], after: ["a"], changes: [] })).toBe(false);
  });
});
