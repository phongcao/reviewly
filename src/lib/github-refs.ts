import type { Link, PhrasingContent, Root } from "mdast";
import { type FindAndReplaceList, findAndReplace } from "mdast-util-find-and-replace";

/** The repository bare `#123` references resolve against. */
export interface RepoRef {
  owner: string;
  repo: string;
}

// GitHub's own rules, roughly: a reference only starts at a word boundary, so
// `foo#1`, `a@b.com` and URL fragments are left alone. Usernames are 1–39
// alphanumerics with single inner hyphens.
const CROSS_REPO = /(?<![\w./#-])([\w.-]+)\/([\w.-]+)#(\d+)\b/g;
const ISSUE = /(?<![\w/#&-])#(\d+)\b/g;
const MENTION = /(?<![\w`/@.-])@([a-zA-Z\d](?:[a-zA-Z\d]|-(?=[a-zA-Z\d])){0,38})(?![\w/-])/g;

function link(url: string, text: string): Link {
  const child: PhrasingContent = { type: "text", value: text };
  return { type: "link", url, title: null, children: [child] };
}

const issueUrl = (owner: string, repo: string, n: string) =>
  // `/issues/N` redirects to `/pull/N` when N is a PR, so one URL serves both.
  `https://github.com/${owner}/${repo}/issues/${n}`;

/**
 * Remark plugin: link GitHub references the way github.com does —
 * `owner/repo#123`, `@user`, and (when `ref` gives the current repo) bare
 * `#123`. Text already inside a link or code is never touched.
 */
export function remarkGithubRefs(ref?: RepoRef | null) {
  const list: FindAndReplaceList = [
    [CROSS_REPO, (m: string, o: string, r: string, n: string) => link(issueUrl(o, r, n), m)],
    [MENTION, (m: string, user: string) => link(`https://github.com/${user}`, m)],
  ];
  if (ref) {
    list.push([ISSUE, (m: string, n: string) => link(issueUrl(ref.owner, ref.repo, n), m)]);
  }
  return (tree: Root) => findAndReplace(tree, list, { ignore: ["link", "linkReference"] });
}
