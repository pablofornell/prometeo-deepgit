/**
 * TypeScript mirror of docs/PLAN.md section 4 (the Rust truth lives in crates/gitcore/src/model.rs).
 * All JSON is camelCase. Enums without data are camelCase string unions ("cherryPicking");
 * enums with data are tagged by `kind` (see `DiffSpec`). `Option<T>` is `T | null`.
 * Do not change a type here without changing PLAN.md and the Rust model.
 */

// ---------------------------------------------------------------- workspace

export interface RepoInfo {
  /** First 12 hex chars of sha1(canonical path). */
  id: string;
  /** Path relative to the project root, or the folder name when the repo is the project root. */
  name: string;
  path: string;
  /** Index in the colour palette (0..11): `var(--dg-repo-N)`. Assigned automatically, or chosen by the user. */
  color: number;
  /** Colour the user typed in (`#RRGGBB`, upper case). Wins over `color`; null means use the palette colour. */
  customColor: string | null;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  repos: RepoInfo[];
  /** Palette index (0..11) of the project, assigned automatically or chosen by the user. */
  color: number;
  /** Custom project colour (`#RRGGBB`), or null. */
  customColor: string | null;
}

export interface Workspace {
  projects: Project[];
  activeProjectId: string | null;
  /** Opaque UI state the frontend saves with `workspaceSaveUi`. */
  ui: unknown;
}

export type RepoStateKind = "clean" | "merging" | "rebasing" | "cherryPicking" | "reverting" | "bisecting";

export interface RepoSummary {
  repoId: string;
  /** null when detached. */
  branch: string | null;
  /** null in an empty repo. */
  headOid: string | null;
  /** e.g. "origin/main". */
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  state: RepoStateKind;
  stashCount: number;
}

// ---------------------------------------------------------------- refs

export interface LocalBranch {
  name: string;
  oid: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  isHead: boolean;
  /** Upstream deleted. */
  gone: boolean;
}

export interface RemoteBranch {
  remote: string;
  /** "main" */
  name: string;
  /** "origin/main" */
  fullName: string;
  oid: string;
}

export interface Tag {
  name: string;
  /** Peeled commit. */
  oid: string;
  annotated: boolean;
}

export interface Stash {
  index: number;
  message: string;
  oid: string;
  /** Unix seconds. */
  time: number;
}

export interface Remote {
  name: string;
  url: string;
}

export interface Submodule {
  path: string;
  oid: string;
  /** ' ', '+', '-' or 'U'. */
  status: string;
}

export interface Refs {
  local: LocalBranch[];
  remote: RemoteBranch[];
  tags: Tag[];
  stashes: Stash[];
  remotes: Remote[];
  submodules: Submodule[];
}

export type RefKind = "head" | "local" | "remote" | "tag" | "stash";

export interface RefLabel {
  kind: RefKind;
  name: string;
  /** True for the checked-out local branch. */
  isCurrent: boolean;
}

// ---------------------------------------------------------------- log

/** y: 0 = top edge of the row, 1 = row middle (node centre), 2 = bottom edge of the row. */
export interface GraphSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Unbounded colour index; the UI takes `color % paletteSize`. */
  color: number;
}

export interface GraphRow {
  node: number;
  color: number;
  segments: GraphSegment[];
  /** Number of lanes used in this row (max column index + 1). */
  width: number;
}

export interface CommitRow {
  repoId: string;
  oid: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  /** Unix seconds. */
  authorTime: number;
  committerTime: number;
  subject: string;
  refs: RefLabel[];
  graph: GraphRow;
}

export interface LogQuery {
  /** 1 or more repos of the active project. */
  repoIds: string[];
  /** Empty = --branches --remotes --tags HEAD. */
  refs: string[];
  /** --grep (message, case-insensitive); a hex string of >= 4 chars also matches the oid prefix. */
  text?: string | null;
  author?: string | null;
  path?: string | null;
  /** Unix seconds. */
  since?: number | null;
  until?: number | null;
  /** Per repo. 0 / omitted = default of 50 000. */
  maxCount?: number;
}

/** A repo of the query that could not be read; the log shows the other repos. */
export interface SkippedRepo {
  repoId: string;
  message: string;
}

export interface LogSessionInfo {
  sessionId: number;
  total: number;
  maxLanes: number;
  truncated: boolean;
  /** Repos that failed to load and are missing from the log (empty when none). */
  skipped: SkippedRepo[];
}

// ---------------------------------------------------------------- files and diffs

export type FileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typeChanged"
  | "untracked"
  | "conflicted"
  | "ignored";

export interface FileChange {
  path: string;
  oldPath: string | null;
  status: FileStatus;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface Person {
  name: string;
  email: string;
  /** Unix seconds. */
  time: number;
  /** "+0100" */
  tz: string;
}

export interface CommitDetails {
  repoId: string;
  oid: string;
  parents: string[];
  author: Person;
  committer: Person;
  subject: string;
  body: string;
  refs: RefLabel[];
  /** Versus the first parent; a root commit versus the empty tree. */
  files: FileChange[];
}

export interface WorkingTree {
  repoId: string;
  staged: FileChange[];
  /** Untracked files are here, with status "untracked". */
  unstaged: FileChange[];
  conflicted: FileChange[];
}

/** Which two versions of a file a diff compares. Tagged by `kind`. */
export type DiffSpec =
  | { kind: "commit"; oid: string; /** null / omitted = first parent. */ parent?: string | null }
  | { kind: "staged" }
  | { kind: "unstaged" };

export type LineKind = "context" | "add" | "del";

export interface DiffLine {
  kind: LineKind;
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Text after the second `@@` (usually the enclosing function). */
  header: string;
  lines: DiffLine[];
}

/** The header numbers of a hunk, as the user saw it (the backend refuses to act when they moved). */
export interface HunkRef {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Content hash of the hunk lines (FNV-1a 32, see `features/diff/hunkHash.ts`); the backend refuses when it differs. */
  hash?: string;
}

/** Optional safety data for the hunk commands. Omitted fields are not sent. */
export interface HunkOpts {
  /** Old path of a staged rename. */
  oldPath?: string;
  /** Header of the hunk the user sees. */
  expected?: HunkRef;
  /** The diff context (lines) used to load the diff the user sees. */
  context?: number;
}

export interface FileDiff {
  path: string;
  oldPath: string | null;
  binary: boolean;
  hunks: Hunk[];
  /** More than 20 000 diff lines: `hunks` is empty. */
  tooLarge: boolean;
}

// ---------------------------------------------------------------- console, events, results

export interface ConsoleEntry {
  id: number;
  repoId: string | null;
  /** The git arguments (after `git -C <repo>` and the global `-c` options). */
  args: string[];
  /** Unix milliseconds. */
  startedAt: number;
  durationMs: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface RepoChanged {
  repoId: string;
}

export interface OpResult {
  ok: boolean;
  /** git stdout + stderr summary. */
  message: string;
  /** True for an expected stop (merge conflict, rebase stop): `ok` is false but it is not an error. */
  conflicts: boolean;
}

export type ResetMode = "soft" | "mixed" | "hard" | "keep";

/** Shape of every rejection of an API call (see `ApiError` in `./tauri`). */
export interface ApiErrorShape {
  message: string;
  /** stderr of the failed git command. */
  detail?: string;
}
