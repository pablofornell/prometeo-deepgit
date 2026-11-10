/**
 * Node model of the sidebar tree (DESIGN.md 5.3) and the pure functions that build and filter it.
 * Repo -> Local / one node per remote / Tags / Stashes / Submodules -> leaves, nested repos after the groups.
 */
import type { LocalBranch, RemoteBranch, Refs, RepoInfo, RepoSummary, Stash, Submodule, Tag } from "../../api/types";

export type GroupKind = "local" | "tags" | "stashes" | "submodules";

export type SidebarNode =
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

/** Builds the tree. Single repo: the repo level is skipped and its groups are the roots. */
export function buildTree(repos: readonly RepoInfo[], ctx: BuildContext): SidebarNode[] {
  const { roots, children } = nestRepos(repos);

  const repoNode = (repo: RepoInfo): SidebarNode => {
    const nested = (children.get(repo.id) ?? []).map(repoNode);
    const show = ctx.query !== "" || ctx.expanded.has(ids.repo(repo.id));
    const refs = show ? ctx.refsOf(repo.id) : undefined;
    const groups = refs ? buildGroups(repo.id, refs, ctx) : [];
    const kids: SidebarNode[] = refs || nested.length > 0 ? [...groups, ...nested] : [{ id: `loading:${repo.id}`, kind: "loading", repoId: repo.id, label: "Loading…" }];
    return { id: ids.repo(repo.id), kind: "repo", repoId: repo.id, label: repo.name, children: kids };
  };

  if (repos.length === 1) {
    const only = repos[0];
    const refs = ctx.refsOf(only.id);
    return refs ? buildGroups(only.id, refs, ctx) : [{ id: `loading:${only.id}`, kind: "loading", repoId: only.id, label: "Loading…" }];
  }
  return roots.map(repoNode);
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
