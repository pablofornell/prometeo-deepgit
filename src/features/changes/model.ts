/**
 * Pure logic of the Local changes view: the flat row model (repo / section / directory / file rows), the
 * directory tree with compressed single-child chains (DESIGN.md 5.9), range selection and the commit
 * message helpers. No Solid, no DOM: unit tested in `model.test.ts`.
 */
import type { FileChange, WorkingTree } from "../../api/types";

export type Section = "conflicts" | "staged" | "unstaged";
export type ViewMode = "tree" | "flat";

export const SECTIONS: readonly Section[] = ["conflicts", "staged", "unstaged"];
export const SECTION_TITLE: Record<Section, string> = { conflicts: "Conflicts", staged: "Staged", unstaged: "Unstaged" };

/** Soft limit of the commit subject line (DESIGN.md 5.12). */
export const SUBJECT_LIMIT = 72;

/** One file of one repo in one section: what stage / unstage / discard act on. */
export interface FileItem {
  repoId: string;
  section: Section;
  file: FileChange;
}

export type Row =
  | { kind: "repo"; key: string; repoId: string; depth: 0 }
  | { kind: "section"; key: string; repoId: string; section: Section; depth: number; count: number; open: boolean }
  | { kind: "dir"; key: string; repoId: string; section: Section; depth: number; path: string; name: string; files: FileChange[]; open: boolean }
  | { kind: "file"; key: string; repoId: string; section: Section; depth: number; file: FileChange; tree: boolean };

// ---------------------------------------------------------------- keys

export const repoKey = (repoId: string): string => `r:${repoId}`;
export const sectionKey = (repoId: string, s: Section): string => `s:${repoId}:${s}`;
export const dirKey = (repoId: string, s: Section, path: string): string => `d:${repoId}:${s}:${path}`;
export const fileKey = (repoId: string, s: Section, path: string): string => `f:${repoId}:${s}:${path}`;

/** File and directory rows can be selected; repo and section rows only collapse. */
export const isSelectableKey = (key: string): boolean => key.startsWith("f:") || key.startsWith("d:");

// ---------------------------------------------------------------- tree

export interface DirNode {
  kind: "dir";
  /** Full path of the (possibly compressed) directory, e.g. "src/refunds". */
  path: string;
  /** Label: the compressed chain, e.g. "src/refunds". */
  name: string;
  children: TreeNode[];
  /** Every file below this directory. */
  files: FileChange[];
}
export interface FileNode {
  kind: "file";
  file: FileChange;
}
export type TreeNode = DirNode | FileNode;

const byName = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });

/** Sorts by path, case-insensitive (flat mode). */
export function sortFiles(files: readonly FileChange[]): FileChange[] {
  return [...files].sort((a, b) => byName(a.path, b.path));
}

/**
 * Builds the directory tree of `files`: directories first, then files, both alphabetical. A directory that
 * only contains one directory is merged with it (`src` + `refunds` -> `src/refunds`).
 */
export function buildTree(files: readonly FileChange[]): TreeNode[] {
  interface Mut {
    name: string;
    path: string;
    dirs: Map<string, Mut>;
    files: FileChange[];
  }
  const root: Mut = { name: "", path: "", dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = cur.dirs.get(parts[i]);
      if (!next) {
        next = { name: parts[i], path: cur.path ? `${cur.path}/${parts[i]}` : parts[i], dirs: new Map(), files: [] };
        cur.dirs.set(parts[i], next);
      }
      cur = next;
    }
    cur.files.push(f);
  }
  const convert = (m: Mut): DirNode => {
    let node = m;
    let name = m.name;
    // compress chains of directories that contain exactly one directory and nothing else
    while (node.files.length === 0 && node.dirs.size === 1) {
      const [only] = node.dirs.values();
      name = `${name}/${only.name}`;
      node = only;
    }
    const dirs = [...node.dirs.values()].sort((a, b) => byName(a.name, b.name)).map(convert);
    const kids: TreeNode[] = [...dirs, ...sortFiles(node.files).map((file): FileNode => ({ kind: "file", file }))];
    const all: FileChange[] = [];
    for (const k of kids) {
      if (k.kind === "dir") all.push(...k.files);
      else all.push(k.file);
    }
    return { kind: "dir", path: node.path, name, children: kids, files: all };
  };
  const dirs = [...root.dirs.values()].sort((a, b) => byName(a.name, b.name)).map(convert);
  return [...dirs, ...sortFiles(root.files).map((file): FileNode => ({ kind: "file", file }))];
}

// ---------------------------------------------------------------- rows

export interface RepoFiles {
  repoId: string;
  wt: WorkingTree;
}

export interface BuildInput {
  repos: readonly RepoFiles[];
  /** Show a repo row above each repo (multi-repo projects). */
  grouped: boolean;
  mode: ViewMode;
  /** Keys (`repoKey`, `sectionKey`, `dirKey`) of collapsed rows. */
  collapsed: ReadonlySet<string>;
}

/** Files of a section of a working tree. */
export function sectionFiles(wt: WorkingTree, s: Section): FileChange[] {
  return s === "conflicts" ? wt.conflicted : s === "staged" ? wt.staged : wt.unstaged;
}

/** Flat list of every visible row, top to bottom. Sections without files have no row. */
export function buildRows(input: BuildInput): Row[] {
  const out: Row[] = [];
  const base = input.grouped ? 1 : 0;
  for (const { repoId, wt } of input.repos) {
    if (input.grouped) {
      out.push({ kind: "repo", key: repoKey(repoId), repoId, depth: 0 });
      if (input.collapsed.has(repoKey(repoId))) continue;
    }
    for (const section of SECTIONS) {
      const files = sectionFiles(wt, section);
      if (files.length === 0) continue;
      const sKey = sectionKey(repoId, section);
      const open = !input.collapsed.has(sKey);
      out.push({ kind: "section", key: sKey, repoId, section, depth: base, count: files.length, open });
      if (!open) continue;
      if (input.mode === "flat") {
        for (const file of sortFiles(files)) {
          out.push({ kind: "file", key: fileKey(repoId, section, file.path), repoId, section, depth: base + 1, file, tree: false });
        }
        continue;
      }
      const walk = (nodes: readonly TreeNode[], depth: number): void => {
        for (const n of nodes) {
          if (n.kind === "file") {
            out.push({ kind: "file", key: fileKey(repoId, section, n.file.path), repoId, section, depth, file: n.file, tree: true });
            continue;
          }
          const key = dirKey(repoId, section, n.path);
          const dirOpen = !input.collapsed.has(key);
          out.push({ kind: "dir", key, repoId, section, depth, path: n.path, name: n.name, files: n.files, open: dirOpen });
          if (dirOpen) walk(n.children, depth + 1);
        }
      };
      walk(buildTree(files), base + 1);
    }
  }
  return out;
}

/** Files a row stands for: the file itself, or every file below a directory. Header rows have none. */
export function rowItems(row: Row): FileItem[] {
  if (row.kind === "file") return [{ repoId: row.repoId, section: row.section, file: row.file }];
  if (row.kind === "dir") return row.files.map((file) => ({ repoId: row.repoId, section: row.section, file }));
  return [];
}

/** Items of the selected keys, deduplicated (a directory and one of its files count once). */
export function selectedItems(rows: readonly Row[], selected: ReadonlySet<string>): FileItem[] {
  const seen = new Set<string>();
  const out: FileItem[] = [];
  for (const row of rows) {
    if (!selected.has(row.key)) continue;
    for (const it of rowItems(row)) {
      const k = fileKey(it.repoId, it.section, it.file.path);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(it);
    }
  }
  return out;
}

/** Groups items by repo, keeping order. */
export function groupByRepo(items: readonly FileItem[]): Map<string, FileItem[]> {
  const m = new Map<string, FileItem[]>();
  for (const it of items) {
    const l = m.get(it.repoId);
    if (l) l.push(it);
    else m.set(it.repoId, [it]);
  }
  return m;
}

// ---------------------------------------------------------------- selection

/** Selectable keys between two keys (inclusive, in either order). Empty when a key is not in `rows`. */
export function rangeKeys(rows: readonly Row[], a: string, b: string): string[] {
  const i = rows.findIndex((r) => r.key === a);
  const j = rows.findIndex((r) => r.key === b);
  if (i < 0 || j < 0) return [];
  const [from, to] = i <= j ? [i, j] : [j, i];
  return rows.slice(from, to + 1).filter((r) => isSelectableKey(r.key)).map((r) => r.key);
}

/**
 * After a reload removed `lostKey` (a file that was staged, a repo that became clean...), the nearest row that
 * still exists: first below, then above. Only selectable rows qualify (and, when given, rows that `accept` the key).
 * `null` when nothing is left.
 */
export function nearestSurvivor(oldKeys: readonly string[], lostKey: string, alive: ReadonlySet<string>, accept: (key: string) => boolean = () => true): string | null {
  const i = oldKeys.indexOf(lostKey);
  if (i < 0) return null;
  const ok = (k: string) => alive.has(k) && isSelectableKey(k) && accept(k);
  for (let k = i + 1; k < oldKeys.length; k++) if (ok(oldKeys[k])) return oldKeys[k];
  for (let k = i - 1; k >= 0; k--) if (ok(oldKeys[k])) return oldKeys[k];
  return null;
}

/** Repo id inside a row key (`f:<repoId>:<section>:<path>`). */
export const repoIdOfKey = (key: string): string => key.split(":")[1] ?? "";

// ---------------------------------------------------------------- commit message

/** Length of the first line of a message, in characters. */
export function subjectLength(message: string): number {
  const nl = message.indexOf("\n");
  return [...(nl < 0 ? message : message.slice(0, nl))].length;
}

/** Label of the primary commit button (DESIGN.md 5.12). */
export function commitLabel(repoCount: number, amend: boolean): string {
  if (amend) return repoCount > 1 ? `Amend commit in ${repoCount} repos` : "Amend commit";
  return repoCount > 1 ? `Commit in ${repoCount} repos` : "Commit";
}
