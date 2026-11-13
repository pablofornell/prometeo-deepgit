/**
 * Node model of the sidebar tree (DESIGN.md 5.3) and the pure functions that build and filter it.
 * Folder -> Repo -> Local / one node per remote / Tags / Stashes / Submodules -> leaves, nested repos after the groups.
 */
import type { LocalBranch, RemoteBranch, Refs, RepoInfo, RepoSummary, Stash, Submodule, Tag } from "../../api/types";

export type GroupKind = "local" | "tags" | "stashes" | "submodules";

export type SidebarNode =
  /** Folder of repos (ITERATION-3 1). `path` is relative to the project root; `repoIds` lists every repo below it (all levels). */
  | { id: string; kind: "folder"; label: string; path: string; repoIds: string[]; children: SidebarNode[] }
  | { id: string; kind: "repo"; repoId: string; label: string; children: SidebarNode[] }
  | { id: string; kind: "group"; repoId: string; label: string; group: GroupKind; count: number; children: SidebarNode[] }
  | { id: string; kind: "remote"; repoId: string; label: string; count: number; children: SidebarNode[] }
  | { id: string; kind: "branch"; repoId: string; label: string; branch: LocalBranch; children?: undefined }
  | { id: string; kind: "remoteBranch"; repoId: string; label: string; remote: RemoteBranch; children?: undefined }
  | { id: string; kind: "tag"; repoId: string; label: string; tag: Tag; children?: undefined }
  | { id: string; kind: "stash"; repoId: string; label: string; stash: Stash; children?: undefined }
  | { id: string; kind: "submodule"; repoId: string; label: string; sub: Submodule; children?: undefined }
  | { id: string; kind: "more"; repoId: string; label: string; groupId: string; hidden: number; children?: undefined }
  | { id: string; kind: "loading"; repoId: string; label: string; children?: undefined };

/** Lists longer than this show their first `HEAD_COUNT` entries and a "N more…" link (DESIGN.md 5.3 rule 5). */
export const LONG_LIST = 8;
export const HEAD_COUNT = 2;

export const ids = {
  folder: (path: string) => `dir:${path}`,
  repo: (repoId: string) => `repo:${repoId}`,
  group: (repoId: string, g: GroupKind) => `grp:${repoId}:${g}`,
  remote: (repoId: string, remote: string) => `rem:${repoId}:${remote}`,
};

export interface BuildContext {
  /** Refs of a repo, or undefined while loading. Only called for repos that must show children. */
  refsOf: (repoId: string) => Refs | undefined;
  summaryOf: (repoId: string) => RepoSummary | undefined;
  /** Ids of expanded nodes. */
  expanded: ReadonlySet<string>;
  /** Group ids whose "N more…" was clicked. */
  moreOpen: ReadonlySet<string>;
  /** Speed search text (lower case, trimmed); "" = off. A search shows every match and loads every repo. */
  query: string;
}

/** Lists the leaves of a long list with the "N more…" rule. Returns the leaves to show, plus the link when needed. */
function truncate(groupId: string, repoId: string, leaves: SidebarNode[], ctx: BuildContext): SidebarNode[] {
  if (ctx.query || leaves.length <= LONG_LIST || ctx.moreOpen.has(groupId)) return leaves;
  return [...leaves.slice(0, HEAD_COUNT), { id: `more:${groupId}`, kind: "more", repoId, label: `${leaves.length - HEAD_COUNT} more…`, groupId, hidden: leaves.length - HEAD_COUNT }];
}

/** Children of a repo node built from its refs (branch groups only; nested repos are added by the caller). */
export function buildGroups(repoId: string, refs: Refs, ctx: BuildContext): SidebarNode[] {
  const out: SidebarNode[] = [];

  const local = [...refs.local].sort((a, b) => Number(b.isHead) - Number(a.isHead) || a.name.localeCompare(b.name));
  if (local.length > 0) {
    const gid = ids.group(repoId, "local");
    out.push({
      id: gid,
      kind: "group",
      repoId,
      group: "local",
      label: "Local",
      count: local.length,
      children: local.map((b) => ({ id: `b:${repoId}:${b.name}`, kind: "branch" as const, repoId, label: b.name, branch: b })),
    });
  }

  const byRemote = new Map<string, RemoteBranch[]>();
  for (const r of refs.remote) {
    if (r.name === "HEAD") continue;
    byRemote.set(r.remote, [...(byRemote.get(r.remote) ?? []), r]);
  }
  for (const remote of [...refs.remotes.map((r) => r.name), ...byRemote.keys()].filter((n, i, a) => a.indexOf(n) === i)) {
    const list = (byRemote.get(remote) ?? []).sort((a, b) => a.name.localeCompare(b.name));
    if (list.length === 0) continue;
    const gid = ids.remote(repoId, remote);
    const leaves: SidebarNode[] = list.map((r) => ({ id: `rb:${repoId}:${r.fullName}`, kind: "remoteBranch" as const, repoId, label: r.name, remote: r }));
    out.push({ id: gid, kind: "remote", repoId, label: remote, count: list.length, children: truncate(gid, repoId, leaves, ctx) });
  }

  if (refs.tags.length > 0) {
    const gid = ids.group(repoId, "tags");
    const tags = [...refs.tags].sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
    const leaves: SidebarNode[] = tags.map((t) => ({ id: `tag:${repoId}:${t.name}`, kind: "tag" as const, repoId, label: t.name, tag: t }));
    out.push({ id: gid, kind: "group", repoId, group: "tags", label: "Tags", count: tags.length, children: truncate(gid, repoId, leaves, ctx) });
  }

  if (refs.stashes.length > 0) {
    out.push({
      id: ids.group(repoId, "stashes"),
      kind: "group",
      repoId,
      group: "stashes",
      label: "Stashes",
      count: refs.stashes.length,
      children: refs.stashes.map((s) => ({ id: `stash:${repoId}:${s.index}`, kind: "stash" as const, repoId, label: `stash@{${s.index}}: ${s.message}`, stash: s })),
    });
  }

  if (refs.submodules.length > 0) {
    out.push({
      id: ids.group(repoId, "submodules"),
      kind: "group",
      repoId,
      group: "submodules",
      label: "Submodules",
      count: refs.submodules.length,
      children: refs.submodules.map((s) => ({ id: `sub:${repoId}:${s.path}`, kind: "submodule" as const, repoId, label: s.path, sub: s })),
    });
  }
  return out;
}

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

const segments = (name: string) => name.replace(/\\/g, "/").split("/").filter(Boolean);
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

/** Builds the tree. Single repo: the repo level is skipped and its groups are the roots. */
export function buildTree(repos: readonly RepoInfo[], ctx: BuildContext): SidebarNode[] {
  const { roots, children } = nestRepos(repos);

  const repoNode = (repo: RepoInfo): SidebarNode => {
    const nested = (children.get(repo.id) ?? []).map(repoNode);
    const show = ctx.query !== "" || ctx.expanded.has(ids.repo(repo.id));
    const refs = show ? ctx.refsOf(repo.id) : undefined;
    const groups = refs ? buildGroups(repo.id, refs, ctx) : [];
    const kids: SidebarNode[] = refs || nested.length > 0 ? [...groups, ...nested] : [{ id: `loading:${repo.id}`, kind: "loading", repoId: repo.id, label: "Loading…" }];
    return { id: ids.repo(repo.id), kind: "repo", repoId: repo.id, label: repoLabel(repo), children: kids };
  };

  const groupNode = (g: RepoGroup): SidebarNode => {
    if (g.kind === "repo") return repoNode(g.repo);
    const kids = g.children.map(groupNode);
    return { id: ids.folder(g.path), kind: "folder", label: g.label, path: g.path, repoIds: repoIdsBelow(kids), children: kids };
  };

  if (repos.length === 1) {
    const only = repos[0];
    const refs = ctx.refsOf(only.id);
    return refs ? buildGroups(only.id, refs, ctx) : [{ id: `loading:${only.id}`, kind: "loading", repoId: only.id, label: "Loading…" }];
  }
  return groupRepos(roots).map(groupNode);
}

/** Ids of the repos at any level below `nodes` (repo nodes, nested repos too), in tree order. */
function repoIdsBelow(nodes: readonly SidebarNode[]): string[] {
  const out: string[] = [];
  const walk = (list: readonly SidebarNode[]) => {
    for (const n of list) {
      if (n.kind === "repo") out.push(n.repoId);
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** Ids of the folder nodes in `nodes`, at any level, including the nodes themselves. */
export function folderIds(nodes: readonly SidebarNode[]): string[] {
  const out: string[] = [];
  const walk = (list: readonly SidebarNode[]) => {
    for (const n of list) {
      if (n.kind === "folder") out.push(n.id);
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** Absolute path of a folder node, from the path of one repo below it (`repo.name` is relative to the project root). */
export function folderAbsPath(folderPath: string, repo: RepoInfo): string {
  const drop = segments(repo.name).length - segments(folderPath).length;
  const parts = repo.path.split(/[\\/]/);
  const sep = repo.path.includes("\\") ? "\\" : "/";
  return parts.slice(0, Math.max(0, parts.length - drop)).join(sep);
}

/** Worst state of a set of repos: conflict, then dirty, else clean. */
export function worstDot(repoIds: readonly string[], summaryOf: (repoId: string) => RepoSummary | undefined): RepoDot {
  let worst: RepoDot = "clean";
  for (const id of repoIds) {
    const d = repoDot(summaryOf(id));
    if (d === "conflict") return d;
    if (d === "dirty") worst = d;
  }
  return worst;
}

/** Keeps the nodes whose label matches `query` (case-insensitive substring) or that have a matching descendant; only matching descendants stay. */
export function filterTree(nodes: readonly SidebarNode[], query: string): SidebarNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...nodes];
  const walk = (list: readonly SidebarNode[]): SidebarNode[] => {
    const out: SidebarNode[] = [];
    for (const n of list) {
      if (n.kind === "more" || n.kind === "loading") continue;
      if (n.children) {
        const kids = walk(n.children);
        if (kids.length > 0 || n.label.toLowerCase().includes(q)) out.push({ ...n, children: kids } as SidebarNode);
      } else if (n.label.toLowerCase().includes(q)) out.push(n);
    }
    return out;
  };
  return walk(nodes);
}

/** Ids of every node that has children (a search expands all of them). */
export function expandableIds(nodes: readonly SidebarNode[]): Set<string> {
  const out = new Set<string>();
  const walk = (list: readonly SidebarNode[]) => {
    for (const n of list) {
      if (n.children && n.children.length > 0) {
        out.add(n.id);
        walk(n.children);
      }
    }
  };
  walk(nodes);
  return out;
}

/** Text of the repo-state badge: "rebasing", "merging"... or null when clean. */
export function stateLabel(state: RepoSummary["state"]): string | null {
  switch (state) {
    case "merging": return "merging";
    case "rebasing": return "rebasing";
    case "cherryPicking": return "cherry-picking";
    case "reverting": return "reverting";
    case "bisecting": return "bisecting";
    default: return null;
  }
}

export type RepoDot = "clean" | "dirty" | "conflict";

/** Dot at the end of a repo row: operation in progress or conflicts, dirty tree, clean. */
export function repoDot(s: RepoSummary | undefined): RepoDot {
  if (!s) return "clean";
  if (s.state !== "clean" || s.conflicted > 0) return "conflict";
  return s.staged + s.unstaged + s.untracked > 0 ? "dirty" : "clean";
}
