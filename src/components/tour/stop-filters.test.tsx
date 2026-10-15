import { type StopFilterKind, StopFilters } from "@/components/tour/stop-filters";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

// React only runs `act` cleanly when told it's in a test environment.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const labels = (counts: Record<StopFilterKind, number>, active: StopFilterKind | null = null) => {
  const el = document.createElement("div");
  el.innerHTML = renderToStaticMarkup(
    <StopFilters counts={counts} active={active} onChange={() => {}} />,
  );
  return [...el.querySelectorAll("button")].map((b) => b.textContent?.trim());
};

describe("StopFilters", () => {
  it("shows only counts above zero, most urgent first", () => {
    expect(labels({ disputed: 2, unverified: 0, unchecked: 4 })).toEqual([
      "2 disputed",
      "4 unchecked",
    ]);
    expect(labels({ disputed: 1, unverified: 3, unchecked: 0 })).toEqual([
      "1 disputed",
      "3 unverified",
    ]);
  });

  it("shows nothing when no stop needs the reviewer", () => {
    expect(labels({ disputed: 0, unverified: 0, unchecked: 0 })).toEqual([]);
  });

  it("keeps a selected count visible after it drops to zero, so it can be cleared", () => {
    expect(labels({ disputed: 0, unverified: 0, unchecked: 0 }, "disputed")).toEqual([
      "0 disputed",
    ]);
  });

  it("selects a filter on click, and clears it on a second click", () => {
    const el = document.createElement("div");
    document.body.append(el);
    const root = createRoot(el);
    const counts = { disputed: 2, unverified: 0, unchecked: 4 };
    const picks: (StopFilterKind | null)[] = [];
    const render = (active: StopFilterKind | null) =>
      act(() =>
        root.render(
          <StopFilters counts={counts} active={active} onChange={(k) => picks.push(k)} />,
        ),
      );
    render(null);
    const disputed = () =>
      [...el.querySelectorAll("button")].find((b) => b.textContent?.includes("disputed"));
    act(() => disputed()?.click());
    render("disputed");
    expect(disputed()?.getAttribute("aria-pressed")).toBe("true");
    act(() => disputed()?.click());
    expect(picks).toEqual(["disputed", null]);
    act(() => root.unmount());
    el.remove();
  });
});
