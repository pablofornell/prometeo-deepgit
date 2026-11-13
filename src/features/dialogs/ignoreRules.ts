/**
 * Pure rules of the "Add to .gitignore" dialog (docs/design/ITERATION-3.md section 11). They do not use the DOM or Solid.
 * They cover the pattern options of a path, the escape of special characters, the match count on a file list, and the
 * check of lines that the target file holds already.
 */
import ignore from "ignore";

/** A file or a folder to ignore. `path` is relative to the repo root, with `/` separators. */
export interface IgnoreItem {
  path: string;
  isDir: boolean;
}

export type OptionKind = "file" | "name" | "ext" | "folder" | "folderName" | "these" | "custom";

export interface PatternOption {
  kind: OptionKind;
  label: string;
  /** The lines of the option. One line, except for `these`. */
  lines: string[];
}

/** The count of matched files shows only for a list of at most this size (section 11.4). */
export const MAX_COUNTED_FILES = 50_000;

/** Removes the slashes at both ends of a path. */
export function cleanPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

/**
 * Escapes the characters of a path segment that a gitignore line reads in a special way: `#`, `!`, `[`, `]`, `*`, `?`,
 * a leading space, a trailing space (git drops it) and `\` itself.
 */
export function escapeSegment(segment: string): string {
  return segment
    .replace(/[\\#![\]*?]/g, "\\$&")
    .replace(/ +$/, (spaces) => "\\ ".repeat(spaces.length))
    .replace(/^ /, "\\ ");
}

const escapePath = (path: string): string => path.split("/").map(escapeSegment).join("/");

/** The last extension of a file name, without the dot. Empty for a dotfile without one (`.env`) and for `name.`. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1) : "";
}

/** The last segment of a path. */
export const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** The folder of a path, or an empty string at the root. */
export const parentOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** The ready-made options of one file or folder (section 11.3, rows 1 to 5), in the order of the table. */
export function patternOptions(item: IgnoreItem): PatternOption[] {
  const path = cleanPath(item.path);
  const out: PatternOption[] = [];
  if (!item.isDir) {
    const name = baseName(path);
    out.push({ kind: "file", label: "This file", lines: ["/" + escapePath(path)] });
    out.push({ kind: "name", label: "This name anywhere", lines: [escapeSegment(name)] });
    const ext = extensionOf(name);
    if (ext) out.push({ kind: "ext", label: "This extension anywhere", lines: ["*." + escapeSegment(ext)] });
  }
  const folder = item.isDir ? path : parentOf(path);
  if (folder !== "") {
    out.push({ kind: "folder", label: "This folder", lines: ["/" + escapePath(folder) + "/"] });
    out.push({ kind: "folderName", label: "This folder name anywhere", lines: [escapeSegment(baseName(folder)) + "/"] });
  }
  return out;
}

/** The kind that the dialog selects first: the file for a file, the folder for a folder (section 11.3, rule 1). */
export const defaultKind = (item: IgnoreItem): OptionKind => (item.isDir ? "folder" : "file");

/** One `/<path>` line for each item, and `/<path>/` for a folder (section 11.3, rule 2). Repeated lines come once. */
export function thesePatterns(items: readonly IgnoreItem[]): string[] {
  const lines = items.map((i) => {
    const path = cleanPath(i.path);
    return "/" + escapePath(path) + (i.isDir ? "/" : "");
  });
  return [...new Set(lines)];
}

/** The lines of a text: one pattern each. Empty lines and a trailing `\r` go away. */
export function parseLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.trim() !== "");
}

/** What a count says about a set of lines: the files they match, and how many of those are tracked. */
export interface MatchCount {
  matched: number;
  tracked: number;
}

/**
 * Counts the files of `files` that `lines` match, with the rules of git (the `ignore` package). A folder line matches the
 * files below it. `tracked` holds the paths that git tracks; it counts the matched files among them.
 * `ignoreCase` is `core.ignorecase` of the repo: git matches case-sensitively on Linux, so the `ignore` default (true) is wrong.
 * Returns null when there is no list, or the list is too long (section 11.4, rule 3).
 * The count is a preview of the new lines alone. It does not read the existing rules, so a `!` rule in a nested `.gitignore`
 * that re-includes a file is not seen (known limit).
 */
export function countMatches(
  files: readonly string[] | null,
  tracked: ReadonlySet<string>,
  lines: readonly string[],
  ignoreCase: boolean,
): MatchCount | null {
  if (!files || files.length > MAX_COUNTED_FILES) return null;
  const rules = ignore({ ignorecase: ignoreCase }).add([...lines]);
  let matched = 0;
  let trackedMatched = 0;
  for (const f of files) {
    if (!rules.ignores(f)) continue;
    matched++;
    if (tracked.has(f)) trackedMatched++;
  }
  return { matched, tracked: trackedMatched };
}

/** `1 file`, `84 files`. */
export const fileCountLabel = (n: number): string => `${n} ${n === 1 ? "file" : "files"}`;

/** The lines that the target file does not hold yet, and the number of those that it holds. A repeated line counts once. */
export function splitKnown(existing: string, lines: readonly string[]): { fresh: string[]; known: string[] } {
  const have = new Set(existing.split(/\r?\n/));
  const fresh: string[] = [];
  const known: string[] = [];
  for (const l of new Set(lines)) (have.has(l) ? known : fresh).push(l);
  return { fresh, known };
}

/** The note of section 11.5 for `n` matched tracked files, or null. */
export function trackedNote(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? "This file is tracked. Git ignores only untracked files." : `${n} matching files are tracked. Git ignores only untracked files.`;
}

/** The title of the success toast: the pattern when there is one, else the number of patterns (section 11.7, rule 5). */
export function addedTitle(added: readonly string[], targetName: string): string {
  return added.length === 1 ? `Added ${added[0]} to ${targetName}` : `Added ${added.length} patterns to ${targetName}`;
}
