import { MarkdownBody, MarkdownRepoContext } from "@/components/markdown-body";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

const repo = { owner: "acme", repo: "shop" };

function render(md: string, withRepo = true) {
  const body = <MarkdownBody>{md}</MarkdownBody>;
  return renderToStaticMarkup(
    withRepo ? (
      <MarkdownRepoContext.Provider value={repo}>{body}</MarkdownRepoContext.Provider>
    ) : (
      body
    ),
  );
}

describe("GitHub references in markdown", () => {
  it("links a bare #123 into the current repo", () => {
    expect(render("tracking here: #175")).toContain(
      '<a href="https://github.com/acme/shop/issues/175">#175</a>',
    );
  });

  it("leaves bare #123 alone without a repo", () => {
    expect(render("tracking here: #175", false)).not.toContain("<a");
  });

  it("links cross-repo references", () => {
    expect(render("see other/lib#9.", false)).toContain(
      '<a href="https://github.com/other/lib/issues/9">other/lib#9</a>',
    );
  });

  it("links @mentions", () => {
    expect(render("cc @octo-cat, thanks")).toContain(
      '<a href="https://github.com/octo-cat">@octo-cat</a>',
    );
  });

  it("ignores lookalikes", () => {
    const html = render(
      "mail a@b.com, anchor foo#12, `#5` in code, [#7](https://x.dev) link, &#39; entity, @org/team",
    );
    expect(html).not.toContain("github.com");
  });
});
