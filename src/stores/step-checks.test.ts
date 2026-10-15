import { useStepChecks } from "@/stores/step-checks";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(() => useStepChecks.setState({ byKey: {} }));

describe("forget", () => {
  const record = {
    type: "claims" as const,
    result: "partial" as const,
    claims: [],
    checkedAt: 1,
    provider: "claude",
  };

  it("drops only the matching stops' checks, and hands them back", () => {
    const s = useStepChecks.getState();
    s.set("o/r#1@h", "l1#a.ts:1:A", record);
    s.set("o/r#1@h", "#b.ts:2:B", record);

    const gone = s.forget("o/r#1@h", (id) => id.startsWith("l1#"));

    const after = useStepChecks.getState();
    expect(Object.keys(after.byKey["o/r#1@h"])).toEqual(["#b.ts:2:B"]);
    expect(Object.keys(gone)).toEqual(["l1#a.ts:1:A"]);

    // Undo puts them back.
    after.importEntries({ "o/r#1@h": gone });
    expect(useStepChecks.getState().byKey["o/r#1@h"]["l1#a.ts:1:A"]).toEqual(record);
  });

  it("leaves other heads alone", () => {
    const s = useStepChecks.getState();
    s.set("o/r#1@h1", "l1#a.ts:1:A", record);
    s.forget("o/r#1@h2", () => true);
    expect(useStepChecks.getState().byKey["o/r#1@h1"]["l1#a.ts:1:A"]).toEqual(record);
  });
});
