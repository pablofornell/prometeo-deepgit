/**
 * Pure helpers of the Files tab. They do not use the DOM or Solid.
 * They cover the project tree, the git status, the search hits, the line separator, the open tabs and the match ranges.
 */
import type { FileStatus, WorkingTree } from "../../api/types";
import { fuzzyMatchPath } from "../palette/fuzzy";

/** Separates the repo id from the path in a node or tab key. A path cannot hold a NUL character. */
export const SEP = "\u0000";

/** The start of the message that the backend sends when a save finds the file changed on disk. */
export const CHANGED_ON_DISK = "The file changed on disk.";

// ---------------------------------------------------------------- tree

/** A folder. `path` is relative to the repo and ends with "/". `id` adds the repo id to it. */
export interface DirNode {
  kind: "dir";
  id: string;
  repoId: string;
  path: string;
  name: string;
  children: FileTreeNode[];
}

/** A file. `path` is relative to the repo. `id` adds the repo id to it. */
export interface FileNode {
  kind: "file";
  id: string;
  repoId: string;
  path: string;
  name: string;
}

/** The root of one repo. Use it in a project with several repos. */
export interface RepoNode {
  kind: "repo";
  id: string;
  repoId: string;
  name: string;
  children: FileTreeNode[];
}

export type FileTreeNode = DirNode | FileNode;
export type TreeNode = FileTreeNode | RepoNode;

/** Returns the id of a node or tab. Without a repo id, it returns the path. With one, it returns the repo id, `SEP`, and the path. */
export function scopeId(repoId: string, path: string): string {
  return repoId === "" ? path : repoId + SEP + path;
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/** Sorts folders before files. Compares names without case and with natural number order. */
function byName(a: FileTreeNode, b: FileTreeNode): number {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
  return collator.compare(a.name, b.name) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/**
 * Builds the folder tree of `paths` (repo-relative file paths). Each level holds its folders and files.
 * Each level is sorted with the folders first. The ids come from `scopeId`, so one path in two repos gives two ids.
 */
export function buildTree(paths: readonly string[], repoId = ""): FileTreeNode[] {
  const root: DirNode = { kind: "dir", id: scopeId(repoId, ""), repoId, path: "", name: "", children: [] };
  const dirs = new Map<string, DirNode>([["", root]]);
  // `dir` ends with "/". The function creates the folder and its missing parents.
  const dirAt = (dir: string): DirNode => {
    const have = dirs.get(dir);
    if (have) return have;
    const cut = dir.lastIndexOf("/", dir.length - 2);
    const parent = dirAt(cut < 0 ? "" : dir.slice(0, cut + 1));
    const node: DirNode = { kind: "dir", id: scopeId(repoId, dir), repoId, path: dir, name: dir.slice(cut + 1, -1), children: [] };
    dirs.set(dir, node);
    parent.children.push(node);
    return node;
  };
  for (const path of paths) {
    if (path === "" || path.endsWith("/")) continue;
    const slash = path.lastIndexOf("/");
    const parent = dirAt(slash < 0 ? "" : path.slice(0, slash + 1));
    parent.children.push({ kind: "file", id: scopeId(repoId, path), repoId, path, name: path.slice(slash + 1) });
  }
  const sortLevel = (list: FileTreeNode[]): void => {
    list.sort(byName);
    for (const n of list) if (n.kind === "dir") sortLevel(n.children);
  };
  sortLevel(root.children);
  return root.children;
}

/** Returns the root node of one repo. Its children are the tree of `paths`. */
export function repoNode(repoId: string, name: string, paths: readonly string[]): RepoNode {
  return { kind: "repo", id: repoId + SEP, repoId, name, children: buildTree(paths, repoId) };
}

// ---------------------------------------------------------------- git status

/** Returns the status of each changed file. Conflicted wins over unstaged, and unstaged wins over staged. Keys are repo-relative paths. */
export function statusMap(wt: Pick<WorkingTree, "staged" | "unstaged" | "conflicted">): Map<string, FileStatus> {
  const out = new Map<string, FileStatus>();
  for (const c of wt.staged) out.set(c.path, c.status);
  for (const c of wt.unstaged) out.set(c.path, c.status);
  for (const c of wt.conflicted) out.set(c.path, "conflicted");
  return out;
}

const F_CONFLICT = 1;
const F_TRACKED = 2;
const F_UNTRACKED = 4;

/**
 * Returns the status of every folder that holds a changed file. It reads the file statuses in one pass.
 * Keys end with "/". A folder is "conflicted" when a file below it is conflicted.
 * Otherwise it is "modified" when a tracked file below it changed. Otherwise it is "untracked" when all changed files below it are untracked.
 */
export function folderStatuses(files: ReadonlyMap<string, FileStatus>): Map<string, FileStatus> {
  const flags = new Map<string, number>();
  for (const [path, status] of files) {
    const bit = status === "conflicted" ? F_CONFLICT : status === "untracked" ? F_UNTRACKED : F_TRACKED;
    // each folder above the file; the repo root has no key
    for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1)) {
      const dir = path.slice(0, i + 1);
      flags.set(dir, (flags.get(dir) ?? 0) | bit);
    }
  }
  const out = new Map<string, FileStatus>();
  for (const [dir, f] of flags) {
    out.set(dir, f & F_CONFLICT ? "conflicted" : f & F_TRACKED ? "modified" : "untracked");
  }
  return out;
}

/** Returns the status that a folder shows. Read it from the map of `folderStatuses`. Returns null when nothing changed. */
export function folderStatus(dirPath: string, folders: ReadonlyMap<string, FileStatus>): FileStatus | null {
  return folders.get(dirPath.endsWith("/") ? dirPath : dirPath + "/") ?? null;
}

// ---------------------------------------------------------------- search hits

export interface HitGroup<T extends { path: string }> {
  path: string;
  hits: T[];
}

/** Groups the hits by file. The groups come in path order. Each group keeps the order of its hits (by line). */
export function groupHits<T extends { path: string }>(hits: readonly T[]): HitGroup<T>[] {
  const byPath = new Map<string, T[]>();
  for (const h of hits) {
    const list = byPath.get(h.path);
    if (list) list.push(h);
    else byPath.set(h.path, [h]);
  }
  return [...byPath.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, list]) => ({ path, hits: list }));
}

/** Returns the UTF-16 offset in `text` of a 1-based column. The column counts characters (code points). The result stops at the end of `text`. */
export function columnOffset(text: string, column: number): number {
  let i = 0;
  for (let c = 1; c < column && i < text.length; c++) i += (text.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
  return i;
}

export interface MatchOptions {
  caseSensitive: boolean;
  regex: boolean;
}

/**
 * Returns the range `[from, to)` of the match that starts at `column`. The offsets are UTF-16 offsets in `line`.
 * When the function cannot check the match, it returns `from === to`. The caller then places only the cursor.
 */
export function matchRange(line: string, column: number, query: string, o: MatchOptions): { from: number; to: number } {
  const from = columnOffset(line, column);
  if (query === "") return { from, to: from };
  if (o.regex) {
    let re: RegExp;
    try {
      re = new RegExp(query, (o.caseSensitive ? "" : "i") + "y");
    } catch {
      return { from, to: from };
    }
    re.lastIndex = from;
    const m = re.exec(line);
    return m && m[0].length > 0 ? { from, to: from + m[0].length } : { from, to: from };
  }
  const seg = line.slice(from, from + query.length);
  const same = o.caseSensitive ? seg === query : seg.toLowerCase() === query.toLowerCase();
  return same ? { from, to: from + query.length } : { from, to: from };
}

// ---------------------------------------------------------------- text files

/** Returns "\r\n" when the content has a CRLF line break. Otherwise it returns "\n". The editor keeps this separator on save. */
export function lineSeparatorOf(content: string): "\r\n" | "\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

/** Returns true when a save failed because the file changed on disk. */
export function isStaleVersion(message: string): boolean {
  return message.startsWith(CHANGED_ON_DISK);
}

/** Returns the message of a rejected call. */
export function errorText(e: unknown): string {
  return e instanceof Object && "message" in e ? String(e.message) : String(e);
}

// ---------------------------------------------------------------- open tabs

/**
 * Opens `key` in the tab list `tabs`. The function changes the list. A new key goes to the end.
 * A key that is already open is not added again. The function returns the key, which is the active tab.
 */
export function openTab(tabs: string[], key: string): string {
  if (!tabs.includes(key)) tabs.push(key);
  return key;
}

/**
 * Closes `key` in `tabs`. The function changes the list. When `key` is the active tab, the next active tab is its right
 * neighbour. If there is none, the left neighbour becomes active. If there is none, the result is null.
 * Closing another tab keeps `active`.
 */
export function closeTab(tabs: string[], key: string, active: string | null): string | null {
  const i = tabs.indexOf(key);
  if (i < 0) return active;
  tabs.splice(i, 1);
  if (active !== key) return active;
  if (i < tabs.length) return tabs[i];
  return i > 0 ? tabs[i - 1] : null;
}

/**
 * Returns the labels of the tabs of `paths`. A tab whose file name another tab also uses gets a `hint`.
 * The hint is the name of the parent folder, shown in muted text. A root file has no folder. Its hint is `rootHints[i]`,
 * which is the repo name in a project with several repos. Otherwise the hint is empty.
 * The tabs with a unique name get an empty hint.
 */
export function tabLabels(paths: readonly string[], rootHints: readonly string[] = []): { name: string; hint: string }[] {
  const names = paths.map((p) => p.slice(p.lastIndexOf("/") + 1));
  const count = new Map<string, number>();
  for (const n of names) count.set(n, (count.get(n) ?? 0) + 1);
  return paths.map((p, i) => {
    const name = names[i];
    if ((count.get(name) ?? 0) < 2) return { name, hint: "" };
    const dir = p.slice(0, p.length - name.length).replace(/\/$/, "");
    const folder = dir.slice(dir.lastIndexOf("/") + 1);
    return { name, hint: folder !== "" ? folder : (rootHints[i] ?? "") };
  });
}

// ---------------------------------------------------------------- quick open

/**
 * Ranks `items` against `query` with the fuzzy path match. An empty query keeps the order of `items`.
 * The best match comes first. A shorter path wins a tie. `limit` caps the number of results.
 */
export function rankFiles<T>(query: string, items: readonly T[], pathOf: (item: T) => string, limit = 50): { item: T; positions: number[] }[] {
  if (query.trim() === "") return items.slice(0, limit).map((item) => ({ item, positions: [] }));
  const hits: { item: T; positions: number[]; score: number; index: number; length: number }[] = [];
  items.forEach((item, index) => {
    const path = pathOf(item);
    const m = fuzzyMatchPath(query, path);
    if (m) hits.push({ item, positions: m.positions, score: m.score, index, length: path.length });
  });
  hits.sort((a, b) => b.score - a.score || a.length - b.length || a.index - b.index);
  return hits.slice(0, limit).map(({ item, positions }) => ({ item, positions }));
}
