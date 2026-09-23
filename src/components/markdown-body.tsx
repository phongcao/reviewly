import { GhAttachment, isGhAttachmentUrl } from "@/components/gh-attachment";
import { MermaidDiagram } from "@/components/mermaid-diagram";
import { safeOpenUrl } from "@/lib/ui";
import { cn } from "@/lib/utils";
import type { Element, Root, RootContent } from "hast";
import { Children, type ComponentPropsWithoutRef, type ReactNode, isValidElement } from "react";
import ReactMarkdown, { type ExtraProps, type Options, type UrlTransform } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

interface Props {
  children: string | null | undefined;
  className?: string;
  /**
   * Rewrite link/image URLs before rendering — e.g. the Markdown preview
   * resolves a document's relative paths against its repo. Omitted, links are
   * left as-authored (react-markdown's own protocol filtering still applies).
   */
  urlTransform?: UrlTransform;
  /**
   * Stamp each rendered element with the source lines it came from
   * (`data-source-start` / `data-source-end`), so a text selection in the
   * rendered document can be mapped back to the file — see `refFromProse`.
   */
  sourceLines?: boolean;
}

// Allow GitHub-flavored details/summary and the usual rehype-sanitize defaults.
const schema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "details", "summary"],
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "id"],
  },
};

function ExternalLink({ href, children, ...rest }: ComponentPropsWithoutRef<"a">) {
  // remark-gfm autolinks bare URLs as `<a href="X">X</a>`. When that URL is a
  // GitHub user-attachment (image or video), render the actual media instead
  // so users see the screenshot/recording inline like on github.com.
  if (href && isGhAttachmentUrl(href) && isAutoLink(href, children)) {
    return <GhAttachment url={href} />;
  }
  return (
    <a
      {...rest}
      href={href ?? "#"}
      onClick={(e) => {
        e.preventDefault();
        if (href) safeOpenUrl(href);
      }}
    >
      {children}
    </a>
  );
}

function isAutoLink(href: string, children: ReactNode): boolean {
  const kids = Children.toArray(children);
  if (kids.length !== 1) return false;
  const only = kids[0];
  if (typeof only === "string") return only === href;
  if (isValidElement(only)) return false;
  return false;
}

function MarkdownImage({ src, alt }: ComponentPropsWithoutRef<"img">) {
  if (typeof src === "string" && isGhAttachmentUrl(src)) {
    return <GhAttachment url={src} alt={alt} />;
  }
  return <img src={src} alt={alt ?? ""} />;
}

/** The source of a ```mermaid fence, or null for any other `<pre>`. */
function mermaidSource(pre: Element | undefined): string | null {
  const code = pre?.children.find((c): c is Element => c.type === "element");
  if (!code || code.tagName !== "code") return null;
  const cls = code.properties.className;
  if (!Array.isArray(cls) || !cls.includes("language-mermaid")) return null;
  let text = "";
  for (const c of code.children) if (c.type === "text") text += c.value;
  return text.trim() ? text : null;
}

function MarkdownPre({ node, ...rest }: ComponentPropsWithoutRef<"pre"> & ExtraProps) {
  const diagram = mermaidSource(node);
  if (diagram != null) {
    // `rest` carries any data-source-* line stamps, so the diagram still maps
    // back to its fence for selection → Ask AI.
    const { children: _code, ...attrs } = rest;
    return <MermaidDiagram {...attrs} code={diagram} />;
  }
  return <pre {...rest} />;
}

/**
 * Rehype plugin behind `sourceLines`. Runs after sanitize, so the attributes
 * don't need allow-listing — and survive because hast positions are kept
 * through both rehype-raw and rehype-sanitize.
 */
function rehypeSourceLines() {
  const walk = (nodes: RootContent[]) => {
    for (const n of nodes) {
      if (n.type !== "element") continue;
      const el = n as Element;
      if (el.position) {
        el.properties.dataSourceStart = el.position.start.line;
        el.properties.dataSourceEnd = el.position.end.line;
      }
      walk(el.children);
    }
  };
  return (tree: Root) => walk(tree.children);
}

type Plugins = NonNullable<Options["rehypePlugins"]>;
const rehypePlugins: Plugins = [rehypeRaw, [rehypeSanitize, schema]];
const rehypePluginsWithLines: Plugins = [...rehypePlugins, rehypeSourceLines];

const components = {
  a: ExternalLink,
  img: MarkdownImage,
  pre: MarkdownPre,
};

/**
 * Render a GitHub-style markdown body (review body, comment, issue) with
 * the project's `.prose-reviewly` theme. Supports embedded HTML like
 * `<details>` blocks, renders ```mermaid fences as diagrams, silently drops
 * HTML comments, routes all link
 * clicks to the OS browser, and proxies GitHub-hosted media through Rust
 * with our auth token so screenshots/videos load.
 */
export function MarkdownBody({ children, className, urlTransform, sourceLines }: Props) {
  if (!children) return null;
  return (
    <div className={cn("prose-reviewly", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={sourceLines ? rehypePluginsWithLines : rehypePlugins}
        components={components}
        urlTransform={urlTransform}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
