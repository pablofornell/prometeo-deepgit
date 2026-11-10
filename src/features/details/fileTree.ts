/** Changed-files tree of a commit (pure): folders compacted like JetBrains ("a/b/c"), directories first. */
import type { FileChange } from "../../api/types";

export interface DirNode {
  kind: "dir";
  /** `d:` + full path of the deepest folder of a compacted chain. */
  id: string;
  /** Shown name; a compacted chain is "a/b/c". */
  name: string;
  children: TreeNode[];
  files: number;
  additions: number;
  deletions: number;
}

export interface FileNode {
  kind: "file";
  /** `f:` + path. */
  id: string;
  name: string;
  change: FileChange;
}

export type TreeNode = DirNode | FileNode;

export const fileId = (path: string) => `f:${path}`;

const byName = (a: TreeNode, b: TreeNode) => {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
};

/** Builds the folder tree of `files`. */
export function buildFileTree(files: readonly FileChange[]): TreeNode[] {
  interface Raw {
    name: string;
    path: string;
    dirs: Map<string, Raw>;
    files: FileNode[];
  }
  const root: Raw = { name: "", path: "", dirs: new Map(), files: [] };
  for (const change of files) {
    const parts = change.path.split("/");
    const name = parts.pop() as string;
    let node = root;
    for (const part of parts) {
      let next = node.dirs.get(part);
      if (!next) {
        next = { name: part, path: node.path ? `${node.path}/${part}` : part, dirs: new Map(), files: [] };
        node.dirs.set(part, next);
      }
      node = next;
    }
    node.files.push({ kind: "file", id: fileId(change.path), name, change });
  }

  const convert = (raw: Raw): DirNode => {
    let cur = raw;
    let name = raw.name;
    // compact single-child folder chains (a folder whose only content is one folder)
    while (cur.files.length === 0 && cur.dirs.size === 1) {
      cur = [...cur.dirs.values()][0];
      name += "/" + cur.name;
    }
    const children: TreeNode[] = [...[...cur.dirs.values()].map(convert), ...cur.files].sort(byName);
    let additions = 0;
    let deletions = 0;
    let count = 0;
    for (const c of children) {
      if (c.kind === "dir") {
        additions += c.additions;
        deletions += c.deletions;
        count += c.files;
      } else {
        additions += c.change.additions ?? 0;
        deletions += c.change.deletions ?? 0;
        count++;
      }
    }
    return { kind: "dir", id: `d:${cur.path}`, name, children, files: count, additions, deletions };
  };

  return [...[...root.dirs.values()].map(convert), ...root.files].sort(byName);
}

/** Ids of every directory (to expand all by default). */
export function dirIds(nodes: readonly TreeNode[]): string[] {
  const out: string[] = [];
  const walk = (list: readonly TreeNode[]) => {
    for (const n of list) {
      if (n.kind === "dir") {
        out.push(n.id);
        walk(n.children);
      }
    }
  };
  walk(nodes);
  return out;
}

/** Totals for the "Changed files" header. */
export function totals(files: readonly FileChange[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += f.additions ?? 0;
    deletions += f.deletions ?? 0;
  }
  return { additions, deletions };
}

/** Sorted flat list (by path), for the "List" view. */
export function flatFiles(files: readonly FileChange[]): FileNode[] {
  return [...files]
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: "base", numeric: true }))
    .map((change) => ({ kind: "file", id: fileId(change.path), name: change.path.slice(change.path.lastIndexOf("/") + 1), change }));
}
