/**
 * Order and grouping of the repos of a project, as the sidebar shows them (ITERATION-3 1.1): folders first, then repos,
 * each by name. Pure functions on `RepoInfo` (`name` is the path relative to the project root).
 * `projectRepos()` returns the repos in this order, so the combined graph orders its lane groups the same way.
 */
import type { RepoInfo } from "../api/types";

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

/** Repos grouped by containing repo: a repo whose path lies inside another repo is its child (DESIGN.md 5.3 rule 6). */
export function nestRepos(repos: readonly RepoInfo[]): { roots: RepoInfo[]; children: Map<string, RepoInfo[]> } {
  const children = new Map<string, RepoInfo[]>();
  const roots: RepoInfo[] = [];
  for (const r of repos) {
    let parent: RepoInfo | undefined;
    for (const p of repos) {
      if (p.id === r.id) continue;
      if (norm(r.path).startsWith(norm(p.path) + "/") && (!parent || norm(p.path).length > norm(parent.path).length)) parent = p;
    }
    if (parent) children.set(parent.id, [...(children.get(parent.id) ?? []), r]);
    else roots.push(r);
  }
  return { roots, children };
}

/** A level of the repo tree: a folder that holds 2 or more repos, or a repo (ITERATION-3 1.1). */
export type RepoGroup =
  | { kind: "repo"; repo: RepoInfo; label: string }
  | { kind: "folder"; path: string; label: string; /** top-level repos below, all levels of folders */ count: number; children: RepoGroup[] };

/** Parts of a repo name or folder path. */
export const segments = (name: string) => name.replace(/\\/g, "/").split("/").filter(Boolean);
/** Case-insensitive, numbers in numeric order. */
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
const groupKey = (g: RepoGroup) => (g.kind === "folder" ? g.path : g.repo.name);

/** Folders first, then repos; each group by name. */
function sortGroups(list: RepoGroup[]): RepoGroup[] {
  return list.sort((a, b) => Number(b.kind === "folder") - Number(a.kind === "folder") || byName(a.label, b.label) || byName(groupKey(a), groupKey(b)));
}

interface Dir {
  dirs: Map<string, Dir>;
  repos: RepoInfo[];
}

/**
 * Groups repos by their folder, relative to the project root (`RepoInfo.name`). A folder shows only when 2 or more repos
 * are below it; a folder with one repo gives the repo to its parent. A folder whose only child is a folder merges with it
 * (`a/b/c`; the id uses the deepest path). Pass the roots of `nestRepos`: nested repos are not grouped.
 */
export function groupRepos(roots: readonly RepoInfo[]): RepoGroup[] {
  const top: Dir = { dirs: new Map(), repos: [] };
  for (const repo of roots) {
    const dirs = segments(repo.name).slice(0, -1);
    let at = top;
    for (const d of dirs) {
      let next = at.dirs.get(d);
      if (!next) at.dirs.set(d, (next = { dirs: new Map(), repos: [] }));
      at = next;
    }
    at.repos.push(repo);
  }

  const build = (dir: Dir, path: string[]): { items: RepoGroup[]; count: number } => {
    const items: RepoGroup[] = dir.repos.map((repo) => ({ kind: "repo" as const, repo, label: repoLabel(repo) }));
    let count = dir.repos.length;
    for (const [name, sub] of dir.dirs) {
      const p = [...path, name];
      const r = build(sub, p);
      count += r.count;
      if (r.count < 2) items.push(...r.items);
      else if (r.items.length === 1 && r.items[0].kind === "folder") items.push({ ...r.items[0], label: `${name}/${r.items[0].label}` });
      else items.push({ kind: "folder", path: p.join("/"), label: name, count: r.count, children: r.items });
    }
    return { items: sortGroups(items), count };
  };
  return build(top, []).items;
}

/** Row label of a repo: its folder name (the last part of the path relative to the project root). */
export function repoLabel(repo: RepoInfo): string {
  return segments(repo.name).pop() ?? repo.name;
}

/** Repos in sidebar order (depth-first, top to bottom). The combined graph orders its lane groups like this. */
export function sidebarOrder(repos: readonly RepoInfo[]): RepoInfo[] {
  const { roots, children } = nestRepos(repos);
  const out: RepoInfo[] = [];
  const addRepo = (r: RepoInfo) => {
    out.push(r);
    for (const c of children.get(r.id) ?? []) addRepo(c);
  };
  const walk = (list: readonly RepoGroup[]) => {
    for (const g of list) {
      if (g.kind === "folder") walk(g.children);
      else addRepo(g.repo);
    }
  };
  walk(groupRepos(roots));
  return out;
}
