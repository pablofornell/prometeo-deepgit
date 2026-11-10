/**
 * The rules of `clone` (mirror of `crates/gitcore/src/clone.rs`): the folder name git picks for a URL and the
 * checks on the input. The Clone dialog uses them to show errors while the user types; the browser mock uses them
 * so it refuses exactly what the backend refuses.
 *
 *   defaultDirName("git@github.com:org/repo.git")   // "repo"
 *   checkCloneInput({ url, parentDir, dirName, branch: null, depth: null })   // null, or the error text
 */

const isSep = (c: string): boolean => c === "/" || c === "\\";
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * The folder name `git clone` picks for `url`: the last path segment without a trailing `/`, `/.git` or `.git`.
 * Handles `https://host/org/repo.git/`, `git@host:org/repo.git`, `host:repo`, `file:///srv/repo.git` and paths.
 * null when no name can be found.
 */
export function defaultDirName(url: string): string | null {
  let s = url.trim();
  let end = s.length;
  while (end > 0 && (isSep(s[end - 1]) || /\s/.test(s[end - 1]))) end--;
  s = s.slice(0, end);
  // "work/repo/.git" is the repo "repo"
  if (s.endsWith(".git") && s.length > 4 && isSep(s[s.length - 5])) {
    s = s.slice(0, s.length - 4);
    while (s.length > 0 && isSep(s[s.length - 1])) s = s.slice(0, -1);
  }
  if (s.endsWith(".git")) s = s.slice(0, -4);
  while (s.length > 0 && (isSep(s[s.length - 1]) || s[s.length - 1] === ":")) s = s.slice(0, -1);
  let start = s.length;
  while (start > 0 && !isSep(s[start - 1]) && s[start - 1] !== ":") start--;
  const name = s.slice(start);
  if (name === "" || name === "." || name === ".." || CONTROL.test(name)) return null;
  return name;
}

/** Text of the URL error, or null when the URL is fine. Same rules as the backend. */
export function checkCloneUrl(url: string): string | null {
  const u = url.trim();
  if (u === "") return "Enter the URL of the repository.";
  if (u.startsWith("-")) return `Invalid repository URL "${u}": it cannot start with '-'.`;
  if (CONTROL.test(u)) return "Invalid repository URL: it contains a control character.";
  const lower = u.toLowerCase();
  if (lower.startsWith("ext::") || lower.startsWith("fd::")) return "This kind of URL (ext:: or fd::) runs commands and is not allowed.";
  return null;
}

/** Text of the folder-name error, or null. */
export function checkDirName(name: string): string | null {
  const n = name.trim();
  if (n === "") return "Enter a name for the folder.";
  if (n === "." || n.includes("/") || n.includes("\\") || n.includes("..")) return "The folder name cannot contain '/', '\\' or '..'. Use the parent folder field for the path.";
  if (CONTROL.test(n)) return "Invalid folder name: it contains a control character.";
  return null;
}

/** True for `/x`, `~`, `~/x`, `C:\x` and `\\server\x`. */
export function isAbsolutePath(p: string): boolean {
  return p.startsWith("/") || p === "~" || p.startsWith("~/") || p.startsWith("~\\") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
}

/** `parent` + `name` with one separator (the separator style of `parent`). */
export function joinPath(parent: string, name: string): string {
  const sep = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
  return parent.replace(/[\\/]+$/, "") + sep + name;
}

export interface CloneInput {
  url: string;
  parentDir: string;
  dirName: string;
  branch: string | null;
  depth: number | null;
}

/** First error of the clone input (URL, name, branch, depth, parent), or null. The disk checks stay with the backend. */
export function checkCloneInput(i: CloneInput): string | null {
  const url = checkCloneUrl(i.url);
  if (url) return url;
  const name = checkDirName(i.dirName);
  if (name) return name;
  if (i.branch !== null) {
    if (i.branch.trim() === "") return "The branch name is empty.";
    if (i.branch.startsWith("-")) return `Invalid branch "${i.branch}": it cannot start with '-'.`;
    if (CONTROL.test(i.branch)) return "Invalid branch: it contains a control character.";
  }
  if (i.depth !== null && (!Number.isInteger(i.depth) || i.depth < 1)) return "The depth must be at least 1.";
  const parent = i.parentDir.trim();
  if (parent === "") return "Choose the parent folder.";
  if (!isAbsolutePath(parent)) return "The parent folder must be an absolute path.";
  return null;
}

const trimSep = (p: string): string => p.replace(/(.)[\\/]+$/, "$1");

/** Text that looks like something to clone: a scheme URL, `user@host:path` or a path ending in `.git`. */
export function looksLikeRepoUrl(text: string): boolean {
  const t = text.trim();
  if (t === "" || /\s/.test(t) || t.length > 500) return false;
  return /^(https?|ssh|git|file):\/\/\S+$/i.test(t) || /^[\w.-]+@[\w.-]+:\S+$/.test(t) || /\.git\/?$/.test(t);
}

/**
 * True when a clone into `parent` is found again by rescanning the project folder. A `~` path cannot be compared with
 * an absolute one here, so it counts as inside: the backend decides and says so when it is not.
 */
export function insideProject(parent: string, projectPath: string): boolean {
  const a = trimSep(parent.trim());
  const b = trimSep(projectPath);
  if (a.startsWith("~") !== b.startsWith("~")) return true;
  return a === b || a.startsWith(b + "/") || a.startsWith(b + "\\");
}
