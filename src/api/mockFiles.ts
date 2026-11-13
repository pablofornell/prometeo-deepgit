/**
 * Worktree files of the browser mock: the fake disk of every repo and the rules of the file commands
 * (`list_files`, `read_text_file`, `write_text_file`, `search_files`). The rules are those of
 * crates/gitcore/src/files.rs. Two differences: the mock also refuses Windows-style paths, and it
 * words a bad regex in its own way.
 */
import { fileText } from "./mockDiff";
import type { FileList, SearchResult, TextFile } from "./types";

export const MAX_LISTED_FILES = 100_000;
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
export const MAX_HITS = 2_000;
export const MAX_HIT_CHARS = 400;
const BINARY_SCAN_BYTES = 8000;
export const CHANGED_ON_DISK = "The file changed on disk. Reload it before you save.";
export const SEARCH_TEXT_INVALID = "The search text cannot contain a line break or a NUL character.";

const encoder = new TextEncoder();

/** The rejection shape of a failed command (same as `fail` in mock.ts). */
function refuse(message: string, detail?: string): never {
  throw detail ? { message, detail } : { message };
}

function fnv(text: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Version of a file's text: a hash of it and its UTF-8 byte length. Opaque: only equality matters. */
export function versionOf(text: string): string {
  const hash = fnv(text, 0x811c9dc5).toString(16).padStart(8, "0") + fnv(text, 0x9e3779b9).toString(16).padStart(8, "0");
  return `${hash}-${encoder.encode(text).length}`;
}

/** Orders strings by their UTF-8 bytes, as git and the Rust side do (JS string order differs above U+FFFF). */
export function byBytes(a: string, b: string): number {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

/** A NUL byte in the first 8 000 bytes marks a file as binary (git's rule). */
export function isBinary(text: string): boolean {
  return encoder.encode(text).subarray(0, BINARY_SCAN_BYTES).includes(0);
}

/** Why a path is refused, or null. The same checks as `files::check_path` and `ops::check_rel`. */
export function filePathError(path: string): string | null {
  if (path === "") return "No file path given.";
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path)) return `path outside the repo: ${path}`;
  const parts = path.split(/[\\/]/);
  if (parts.includes("..")) return `path outside the repo: ${path}`;
  if (parts.some((p) => p.toLowerCase() === ".git")) return `path inside the git folder: ${path}`;
  return null;
}

/** The map key of a path: no empty and no `.` parts (`src//main.rs` is `src/main.rs`). */
export function fileKey(path: string): string {
  return path.split("/").filter((p) => p !== "" && p !== ".").join("/");
}

/** True when some file lies under `key` (the repo root is `""`). */
export function isFolder(files: Map<string, string>, key: string): boolean {
  if (key === "") return true;
  const prefix = key + "/";
  for (const k of files.keys()) if (k.startsWith(prefix)) return true;
  return false;
}

/**
 * The ignored entries, sorted by bytes (`IgnoredEntries` in files.rs). A folder with no file that is not ignored is one
 * entry that ends with "/", the outermost such folder. The files inside it are not listed. Other ignored files stand alone.
 */
export function ignoredEntries(files: Map<string, string>, ignored: Set<string>): string[] {
  // For each folder: how many files lie below it, and how many of those are ignored.
  const below = new Map<string, { all: number; ignored: number }>();
  for (const path of files.keys()) {
    const isIgnored = ignored.has(path);
    for (let i = path.indexOf("/"); i >= 0; i = path.indexOf("/", i + 1)) {
      const dir = path.slice(0, i + 1);
      const c = below.get(dir) ?? { all: 0, ignored: 0 };
      c.all++;
      if (isIgnored) c.ignored++;
      below.set(dir, c);
    }
  }
  const out = new Set<string>();
  for (const path of ignored) {
    if (!files.has(path)) continue;
    let entry = path;
    for (let i = path.indexOf("/"); i >= 0; i = path.indexOf("/", i + 1)) {
      const dir = path.slice(0, i + 1);
      const c = below.get(dir);
      if (c && c.all === c.ignored) {
        entry = dir;
        break;
      }
    }
    out.add(entry);
  }
  return [...out].sort(byBytes);
}

/** Sorted, capped paths that are not ignored, and the ignored entries (`files::list_files`). `truncated` also covers the ignored list. */
export function listFiles(files: Map<string, string>, ignored: Set<string>, max = MAX_LISTED_FILES): FileList {
  const all = [...files.keys()].filter((k) => !ignored.has(k)).sort(byBytes);
  const entries = ignoredEntries(files, ignored);
  return { files: all.slice(0, max), ignored: entries.slice(0, max), truncated: all.length > max || entries.length > max };
}

/** What `read_text_file` returns for a file with this text (`files::read_text_file`). */
export function readText(text: string): TextFile {
  if (encoder.encode(text).length > MAX_TEXT_BYTES) return { content: "", version: "", binary: false, tooLarge: true };
  if (isBinary(text)) return { content: "", version: versionOf(text), binary: true, tooLarge: false };
  return { content: text, version: versionOf(text), binary: false, tooLarge: false };
}

/** The message for a search text that cannot be used, or null. */
export function searchTextError(query: string): string | null {
  return /[\0\n\r]/.test(query) ? SEARCH_TEXT_INVALID : null;
}

/**
 * Searches the files that are not ignored, like `git grep -n --column -I`. Gives one hit per matching line, at the
 * 1-based character column of its first match. Sorts the hits by path and line. Cuts each text to 400 characters.
 * Throws the rejection shape for a bad regex.
 */
export function searchFiles(
  files: Map<string, string>,
  ignored: Set<string>,
  query: string,
  caseSensitive: boolean,
  regex: boolean,
  max = MAX_HITS,
): SearchResult {
  const refused = searchTextError(query);
  if (refused !== null) refuse(refused);
  if (query === "") return { hits: [], truncated: false };
  let re: RegExp | null = null;
  if (regex) {
    try {
      re = new RegExp(query, caseSensitive ? "" : "i");
    } catch {
      refuse(`fatal: invalid regular expression: ${query}`);
    }
  }
  const needle = caseSensitive ? query : query.toLowerCase();
  const hits: SearchResult["hits"] = [];
  for (const path of [...files.keys()].filter((k) => !ignored.has(k)).sort(byBytes)) {
    const content = files.get(path) ?? "";
    if (isBinary(content)) continue;
    content.split("\n").forEach((raw, i) => {
      // git matches the raw line, carriage return included. Only the text drops it.
      const at = re ? (re.exec(raw)?.index ?? -1) : (caseSensitive ? raw : raw.toLowerCase()).indexOf(needle);
      if (at < 0) return;
      const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      hits.push({
        path,
        line: i + 1,
        column: Array.from(raw.slice(0, at)).length + 1,
        text: Array.from(text).slice(0, MAX_HIT_CHARS).join(""),
      });
    });
  }
  return { hits: hits.slice(0, max), truncated: hits.length > max };
}

/** A small, realistic file for each path the fixed set names. */
export const FIXED_FILES: Record<string, string> = {
  "README.md": "# Overview\n\nThis repository holds the service code.\n\n## Build\n\nRun `npm run build` to build the app.\n",
  ".gitignore": "node_modules/\ndist/\ntarget/\n*.log\n",
  "package.json": '{\n  "name": "project",\n  "version": "0.1.0",\n  "private": true,\n  "scripts": {\n    "build": "tsc && vite build",\n    "test": "vitest run"\n  }\n}\n',
  "src/main.rs": 'fn main() {\n    let port = 8080;\n    println!("listening on {port}");\n}\n',
  "src/lib.rs": "pub mod app;\n\n/// Adds two numbers.\npub fn add(a: i64, b: i64) -> i64 {\n    a + b\n}\n",
  "src/app/view.ts": "export function render(root: HTMLElement, title: string): void {\n  root.textContent = title;\n}\n",
  "docs/guide.md": "# Guide\n\nStart with the getting started page.\n\n- Install the tools.\n- Run the tests.\n",
};

/** Files on disk that the ignore rules hide (`.gitignore` above). */
export const IGNORED_FILES: Record<string, string> = {
  "dist/bundle.js": "// generated, ignored\n",
  "build.log": "build started\n",
};

/**
 * Builds the fake disk of a new repo: the fixed set, the ignored files, and every path in `paths` (the paths the
 * mock shows as tracked, untracked or conflicted). Each of those gets the text `fileText` makes for it.
 */
export function initialWorktree(paths: Iterable<string>): { files: Map<string, string>; ignored: Set<string> } {
  const files = new Map<string, string>();
  for (const p of paths) {
    const key = fileKey(p);
    if (key !== "") files.set(key, fileText(key, "worktree"));
  }
  for (const [p, text] of Object.entries(FIXED_FILES)) files.set(p, text);
  const ignored = new Set<string>();
  for (const [p, text] of Object.entries(IGNORED_FILES)) {
    files.set(p, text);
    ignored.add(p);
  }
  return { files, ignored };
}
