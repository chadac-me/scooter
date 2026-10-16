// The address bar is the viewer's link format: `?path=<file>#<heading>`. It is what
// the scooter-files skill tells the agent to hand the user, so it is a contract,
// not a detail; every in-app move goes through here to keep it honest.

import { BASE } from "./api";

export type Location = { path: string; hash: string };

export function current(): Location {
  const path = new URLSearchParams(location.search).get("path");
  if (path !== null) return { path, hash: decodeURIComponent(location.hash.slice(1)) };
  // An early prototype addressed files as `#/<file>`; keep those links opening.
  if (location.hash.startsWith("#/")) return { path: decodeURIComponent(location.hash.slice(2)), hash: "" };
  return { path: "", hash: "" };
}

export const hrefFor = (path: string, hash = "") =>
  `${BASE}/?path=${encodeURIComponent(path)}${hash ? `#${encodeURIComponent(hash)}` : ""}`;

const EVENT = "files:navigate";

export function navigate(path: string, hash = "", { replace = false } = {}) {
  history[replace ? "replaceState" : "pushState"](null, "", hrefFor(path, hash));
  window.dispatchEvent(new Event(EVENT));
}

/** Calls `fn` on every move: in-app navigation, and the browser's back/forward. */
export function onNavigate(fn: () => void) {
  window.addEventListener(EVENT, fn);
  window.addEventListener("popstate", fn);
  return () => {
    window.removeEventListener(EVENT, fn);
    window.removeEventListener("popstate", fn);
  };
}

export const isExternal = (href: string) => /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");

/** A document-relative href resolved the way the filesystem would, from `from`'s directory. */
export function resolveRel(from: string, href: string): string {
  const out = href.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const part of href.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/** GitHub-style heading ids, so `#failure-modes` means what it does on GitHub. */
export const slug = (text: string) =>
  text
    .toLowerCase()
    .trim()
    .replace(/[^\w\- ]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "") || "section";
