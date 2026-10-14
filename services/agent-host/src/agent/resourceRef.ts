/**
 * A linked resource's URL parsed into the structured target the reply tools need.
 * Parsers are host-agnostic (the link's `source` names the provider) and return
 * undefined rather than guess, since a wrong target comments on someone else's PR.
 */

import type { ConversationLink } from "../session/manager.js";

export interface GithubTarget {
  owner: string;
  repo: string;
  number: number;
}

export interface GitlabTarget {
  /** The project path, which GitLab accepts URL-encoded in place of the numeric id. */
  projectId: string;
  iid: string;
  isMr: boolean;
}

export interface JiraTarget {
  issueKey: string;
}

/** Path segments of a URL, or undefined when it is not a parseable http(s) URL. */
function segments(url: string | undefined): string[] | undefined {
  if (!url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  return parsed.pathname.split("/").filter((s) => s.length > 0).map(decodeURIComponent);
}

/** `https://github.com/<owner>/<repo>/(pull|issues)/<number>` plus any suffix; the host is not checked since enterprise hosts differ. */
export function parseGithubUrl(url: string | undefined): GithubTarget | undefined {
  const segs = segments(url);
  if (!segs || segs.length < 4) return undefined;
  const [owner, repo, kind, num] = segs;
  if (!["pull", "pulls", "issues", "issue"].includes(kind)) return undefined;
  if (!/^\d+$/.test(num)) return undefined;
  return { owner, repo, number: Number(num) };
}

/** `https://gitlab.com/<group>/…/<project>/-/(merge_requests|issues)/<iid>`, where the kind segment rather than a fixed position splits project from iid since the `/-/` is optional and subgroups nest. */
export function parseGitlabUrl(url: string | undefined): GitlabTarget | undefined {
  const segs = segments(url);
  if (!segs) return undefined;
  const at = segs.findIndex((s) => s === "merge_requests" || s === "issues");
  if (at < 1) return undefined;
  const iid = segs[at + 1];
  if (!iid || !/^\d+$/.test(iid)) return undefined;
  const path = segs.slice(0, at).filter((s) => s !== "-");
  if (path.length < 2) return undefined; // need at least namespace/project
  return { projectId: path.join("/"), iid, isMr: segs[at] === "merge_requests" };
}

/** `https://<site>/browse/<KEY-123>`. */
export function parseJiraUrl(url: string | undefined): JiraTarget | undefined {
  const segs = segments(url);
  if (!segs) return undefined;
  const at = segs.indexOf("browse");
  const key = at >= 0 ? segs[at + 1] : undefined;
  if (!key || !/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(key)) return undefined;
  return { issueKey: key.toUpperCase() };
}

/** The structured `ref` derived from a link's URL for links written without one, or undefined when nothing is derivable; a GitLab issue's number goes in `iid`, never `mrIid`. */
export function refFromUrl(source: string, url: string | undefined): ConversationLink["ref"] | undefined {
  if (!url) return undefined;
  switch (source) {
    case "github": {
      const t = parseGithubUrl(url);
      return t ? { owner: t.owner, repo: t.repo, number: t.number } : undefined;
    }
    case "gitlab": {
      const t = parseGitlabUrl(url);
      if (!t) return undefined;
      return t.isMr ? { projectId: t.projectId, mrIid: t.iid } : { projectId: t.projectId, iid: t.iid };
    }
    case "jira": {
      const t = parseJiraUrl(url);
      return t ? { issueKey: t.issueKey } : undefined;
    }
    default:
      return undefined;
  }
}

/** The link with a derived `ref` filled in when it has none; an explicit ref always wins. */
export function withDerivedRef(link: ConversationLink): ConversationLink {
  if (link.ref && Object.keys(link.ref).length > 0) return link;
  const ref = refFromUrl(link.source, link.url);
  return ref ? { ...link, ref } : link;
}

/** The canonical `resource_type` per source, mirroring webhooks/resources.py `_TYPE_ALIASES` since both services write the same uniquely keyed table; unknown types pass through unchanged. */
export function canonicalResourceType(source: string, resourceType: string): string {
  return ALIASES[source]?.[resourceType.toLowerCase()] ?? resourceType;
}

const ALIASES: Record<string, Record<string, string>> = {
  github: { pr: "pull_request", pull_request: "pull_request", issue: "issue" },
  gitlab: { mr: "merge_request", merge_request: "merge_request", issue: "issue" },
  jira: { ticket: "issue", issue: "issue" },
  slack: { message: "thread", thread: "thread" },
};
