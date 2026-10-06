import { type TourNavigation, useTourNavigation } from "@/components/tour/use-tour-navigation";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The cursor logic the PR tour and the codebase tour share. jsdom does no
 * layout, so the pinned-header sync is out of reach here; every stop is made
 * to measure below the pane's top edge (nothing pinned), which leaves the
 * keyboard, the clamping, and the re-snap when the current stop leaves the
 * visible set to pin.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Opts = Parameters<typeof useTourNavigation>[0];

let root: Root;
let host: HTMLDivElement;
let nav: TourNavigation;

function Harness(props: Opts) {
  nav = useTourNavigation(props);
  return (
    <div ref={nav.scrollRef}>
      {props.visible.map((i) => (
        <section key={i} ref={(el) => nav.setStepRef(i, el && below(el, i))} />
      ))}
    </div>
  );
}

/** Measure a stop well below the pane's top edge, so it doesn't read as pinned. */
function below(el: HTMLElement, i: number): HTMLElement {
  el.getBoundingClientRect = () => ({ top: 100 * (i + 1) }) as DOMRect;
  return el;
}

function render(props: Opts) {
  act(() => root.render(<Harness {...props} />));
}

function key(k: string, init: KeyboardEventInit = {}, target: EventTarget = window) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...init }));
  });
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("useTourNavigation", () => {
  it("reports the stop it starts on", () => {
    const onActive = vi.fn();
    render({ visible: [0, 1, 2], initial: 0, onActive });
    expect(nav.active).toBe(0);
    expect(onActive).toHaveBeenCalledWith(0);
  });

  it("steps with j/k/↓/↑/Enter/d and clamps at both ends", () => {
    render({ visible: [0, 1, 2], initial: 0 });
    key("k");
    expect(nav.active).toBe(0);
    key("j");
    expect(nav.active).toBe(1);
    key("ArrowDown");
    expect(nav.active).toBe(2);
    key("Enter");
    key("d");
    expect(nav.active).toBe(2);
    expect(nav.atLast).toBe(true);
    key("ArrowUp");
    expect(nav.active).toBe(1);
  });

  it("moves through the visible stops only", () => {
    render({ visible: [0, 3, 5], initial: 0 });
    key("j");
    expect(nav.active).toBe(3);
    expect(nav.pos).toBe(1);
  });

  it("opens and dismisses the current stop with o and x", () => {
    const onOpen = vi.fn();
    const onDismiss = vi.fn();
    render({ visible: [0, 1], initial: 0, onOpen, onDismiss });
    key("j");
    key("o");
    key("x");
    expect(onOpen).toHaveBeenCalledWith(1);
    expect(onDismiss).toHaveBeenCalledWith(1);
  });

  it("ignores keys while typing, with a modifier, or when keyboard is off", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    render({ visible: [0, 1, 2], initial: 0 });
    key("j", {}, input);
    key("j", { metaKey: true });
    expect(nav.active).toBe(0);
    input.remove();

    render({ visible: [0, 1, 2], initial: 0, keyboard: false });
    key("j");
    expect(nav.active).toBe(0);
  });

  it("re-snaps into view when the current stop is hidden", () => {
    render({ visible: [0, 1, 2], initial: 0 });
    key("j");
    expect(nav.active).toBe(1);
    render({ visible: [0, 2], initial: 0 });
    expect([0, 2]).toContain(nav.active);
  });

  it("jumps straight to a stop", () => {
    const onActive = vi.fn();
    render({ visible: [0, 1, 2], initial: 0, onActive });
    act(() => nav.jumpTo(2));
    expect(nav.active).toBe(2);
    expect(onActive).toHaveBeenLastCalledWith(2);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });
});
