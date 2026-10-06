import { Fragment } from "react";

/** Model text with its backtick spans as `<code>`. Nothing else is
 * interpreted: a claim row is a checker's sentence, not markdown. */
export function CodeSpans({ text }: { text: string }) {
  const parts = text.split("`");
  // An odd backtick leaves an unclosed span — render the text as-is.
  if (parts.length % 2 === 0) return <>{text}</>;
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <code key={i} className="rounded bg-foreground/[0.06] px-1 font-mono text-[0.95em]">
            {p}
          </code>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}
