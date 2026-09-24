import { cn } from "@/lib/utils";
import { AlertTriangle } from "lucide-react";
import { type HTMLAttributes, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

type Mermaid = typeof import("mermaid").default;

// Mermaid is ~1MB with its diagram renderers — load it the first time a
// document actually contains a diagram, never on app start.
let loader: Promise<Mermaid> | null = null;
function loadMermaid(): Promise<Mermaid> {
  loader ??= import("mermaid").then((m) => m.default);
  return loader;
}

// `mermaid.initialize` is global state, so renders are serialized: each one
// sets its theme and renders before the next may touch the config.
let queue: Promise<unknown> = Promise.resolve();
function renderDiagram(id: string, text: string, theme: "light" | "dark"): Promise<string> {
  const run = queue.then(async () => {
    const mermaid = await loadMermaid();
    // Mermaid sizes node boxes by measuring label text, so it needs the real
    // font (a `var()` doesn't resolve there) and that font must be loaded —
    // otherwise labels overflow and get clipped.
    await document.fonts.ready;
    const fontFamily = getComputedStyle(document.documentElement)
      .getPropertyValue("--font-sans")
      .trim();
    mermaid.initialize({
      startOnLoad: false,
      // Diagram source comes from PR content — keep mermaid's own sanitizing,
      // no click handlers or script-bearing labels.
      securityLevel: "strict",
      theme: theme === "light" ? "default" : "dark",
      fontFamily: fontFamily || undefined,
      // Throw on bad syntax instead of injecting mermaid's error SVG into <body>.
      suppressErrorRendering: true,
    });
    const { svg } = await mermaid.render(id, text);
    return svg;
  });
  queue = run.catch(() => undefined);
  return run;
}

function readScheme(): "light" | "dark" {
  return document.documentElement.classList.contains("light") ? "light" : "dark";
}

/** The scheme on <html> (`useAppliedTheme` toggles `.light`), kept live. */
function useDocumentScheme(): "light" | "dark" {
  const [scheme, setScheme] = useState(readScheme);
  useEffect(() => {
    const obs = new MutationObserver(() => setScheme(readScheme()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return scheme;
}

type Rgba = [number, number, number, number];

function parseRgb(css: string): Rgba | null {
  const m = css.match(/^rgba?\(([^)]+)\)$/);
  if (!m) return null;
  const [r, g, b, a = 1] = m[1]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number);
  return [r, g, b, a];
}

// WCAG relative luminance and contrast ratio.
function luminance([r, g, b]: Rgba): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const DARK_TEXT: Rgba = [31, 35, 40, 1];
const LIGHT_TEXT: Rgba = [240, 246, 252, 1];

/**
 * Diagrams often `classDef` a pastel `fill` without a text `color`, written
 * against the light theme — under the dark theme's near-white labels that
 * text all but vanishes (github.com has the same problem). Wherever a label
 * reads poorly against its own shape's fill, flip it to dark or light text.
 * Labels an author colored legibly are left alone.
 */
function fixLabelContrast(root: HTMLElement) {
  for (const group of root.querySelectorAll<SVGGElement>("g.node, g.cluster")) {
    const shape = group.querySelector(
      ":scope > rect, :scope > polygon, :scope > path, :scope > circle",
    );
    const fill = shape && parseRgb(getComputedStyle(shape).fill);
    // No fill, or mostly see-through: the label sits on the page, not the shape.
    if (!fill || fill[3] < 0.5) continue;
    for (const label of group.querySelectorAll<HTMLElement | SVGElement>(
      ".nodeLabel, .cluster-label span, text",
    )) {
      const isSvgText = label instanceof SVGElement;
      const style = getComputedStyle(label);
      const fg = parseRgb(isSvgText ? style.fill : style.color);
      if (fg && contrast(fg, fill) >= 4.5) continue;
      const pick = contrast(DARK_TEXT, fill) >= contrast(LIGHT_TEXT, fill) ? DARK_TEXT : LIGHT_TEXT;
      label.style.setProperty(
        isSvgText ? "fill" : "color",
        `rgb(${pick.slice(0, 3).join(" ")})`,
        "important",
      );
    }
  }
}

interface Props extends HTMLAttributes<HTMLElement> {
  /** Mermaid source, as written in the ```mermaid fence. */
  code: string;
}

/**
 * Render a ```mermaid code fence as the diagram it describes, like github.com
 * does. Falls back to the raw source (plus the parse error) when the diagram
 * doesn't parse, so a broken diagram is still reviewable.
 */
export function MermaidDiagram({ code, className, ...rest }: Props) {
  const scheme = useDocumentScheme();
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [state, setState] = useState<
    { status: "loading" } | { status: "ok"; svg: string } | { status: "error"; message: string }
  >({ status: "loading" });
  const svgHost = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    renderDiagram(id, code, scheme).then(
      (svg) => !cancelled && setState({ status: "ok", svg }),
      (err: unknown) =>
        !cancelled &&
        setState({ status: "error", message: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      cancelled = true;
    };
  }, [id, code, scheme]);

  // Before paint, so the unreadable labels never flash.
  useLayoutEffect(() => {
    if (state.status === "ok" && svgHost.current) fixLabelContrast(svgHost.current);
  }, [state]);

  if (state.status === "error") {
    return (
      <div {...rest} className={cn("prose-mermaid-error", className)}>
        <div className="prose-mermaid-error-banner">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span>Couldn't render this Mermaid diagram — showing its source.</span>
        </div>
        <pre>
          <code>{code}</code>
        </pre>
        <p className="prose-mermaid-error-detail">{state.message}</p>
      </div>
    );
  }

  if (state.status === "loading") {
    return (
      <div {...rest} className={cn("prose-mermaid is-loading", className)} aria-busy>
        Rendering diagram…
      </div>
    );
  }

  return (
    <div
      {...rest}
      ref={svgHost}
      className={cn("prose-mermaid", className)}
      // SVG is produced by mermaid with securityLevel "strict" (DOMPurify'd).
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized mermaid output
      dangerouslySetInnerHTML={{ __html: state.svg }}
    />
  );
}
