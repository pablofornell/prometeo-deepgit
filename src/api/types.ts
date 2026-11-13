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
}

export interface Project {
  id: string;
  name: string;
  path: string;
  repos: RepoInfo[];
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

/** The untracked files of a stash (`git stash -u`). */
export interface StashUntracked {
  oid: string;
  /** Status "added": the files are new in the untracked commit. */
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

// ---------------------------------------------------------------- project files

/** Tracked and untracked files of the worktree, without the ignored ones. */
export interface FileList {
  /** Relative paths, sorted by bytes. */
  files: string[];
  /** More than 100 000 files: the list stops there. */
  truncated: boolean;
}

/** A worktree file read as text. */
export interface TextFile {
  /** Empty when `binary` or `tooLarge`. */
  content: string;
  /** A hash of the bytes and their length. Send it back when saving. Empty when `tooLarge`. */
  version: string;
  /** A NUL byte in the first 8 000 bytes, or not UTF-8. */
  binary: boolean;
  /** Over 2 MiB. Not loaded. */
  tooLarge: boolean;
}

/** The file `appendIgnoreRules` writes: `.gitignore` at the repo root, or `.git/info/exclude` (only on this computer). */
export type IgnoreTarget = "gitignore" | "exclude";

/** An ignore file with the case rule of its repo. */
export interface IgnoreFile {
  /** The text. Empty when the file does not exist. */
  content: string;
  /** `core.ignorecase` of the repo (false when unset). Git then matches ignore patterns without regard to case. */
  ignoreCase: boolean;
}

/** One matching line of a search. */
export interface SearchHit {
  path: string;
  /** 1-based. */
  line: number;
  /** 1-based, in characters. */
  column: number;
  /** The line, cut to 400 characters. */
  text: string;
}

export interface SearchResult {
  /** At most 2 000 hits, sorted by path and line. */
  hits: SearchHit[];
  truncated: boolean;
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
  /** A network command started by a background caller (the auto-fetch): hidden from the status bar and, by default, the console. */
  background: boolean;
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

/** How a merge joins the histories: fast-forward when possible, `--no-ff`, `--ff-only`, `--squash`. */
export type MergeMode = "ff" | "noFf" | "ffOnly" | "squash";

/**
 * Options of `merge`. A message needs a merge commit (not `ffOnly`, `squash` or `noCommit`); `noCommit` is not for
 * `ffOnly` and `squash`. The backend refuses other mixes (see `features/dialogs/mergeOptions.ts`).
 */
export interface MergeOpts {
  mode: MergeMode;
  /** Message of the merge commit; null / blank keeps git's default. */
  message: string | null;
  /** `--no-commit`. */
  noCommit: boolean;
  /** `--allow-unrelated-histories`. */
  allowUnrelatedHistories: boolean;
}

/** Options of `cloneRepo`. */
export interface CloneOpts {
  /** `--branch`: a branch or tag to check out. null = the remote HEAD. */
  branch: string | null;
  /** `--depth`: a shallow clone (at least 1). null = full history. */
  depth: number | null;
  recurseSubmodules: boolean;
}

/** Where a clone is added. Tagged by `kind`. */
export type CloneTarget =
  /** The folder of this project must contain the clone: the project is rescanned. */
  | { kind: "project"; projectId: string }
  /** A new project whose folder is the clone. */
  | { kind: "newProject" };

/** Payload of the `clone-progress` event: one phase of git's progress output. */
export interface CloneProgress {
  /** The id given to `cloneRepo`. */
  operationId: string;
  /** "Receiving objects", "Resolving deltas", "Counting objects"... */
  phase: string;
  /** 0..100; null when git prints the phase without a percentage. */
  percent: number | null;
}

export interface CloneResult {
  /** Absolute path of the new repository. */
  path: string;
  /** The project that now holds it (rescanned, or new). */
  project: Project;
  /** True when `project` was just created. */
  createdProject: boolean;
}

// ---------------------------------------------------------------- authentication (PLAN.md section 5.6)

/** What git or ssh is asking for. */
export type AuthPromptKind = "username" | "password" | "passphrase" | "pin" | "hostkey" | "unknown";

/** Payload of the `auth-prompt` event: one question of a running git command. */
export interface AuthPrompt {
  /** Pass it back to `authReply`. */
  id: number;
  kind: AuthPromptKind;
  /** The text git or ssh sent; for a host key it holds the fingerprint. */
  prompt: string;
  /** `https://github.com` (HTTPS), `alice@host` (ssh password) or the host of a host-key question. */
  host?: string;
  user?: string;
  /** Path of the ssh key a passphrase is for. */
  keyPath?: string;
  repoId?: string;
  /** The command that asks, e.g. `git push` (never holds arguments). */
  command: string;
  /** A `username` dialog that also asks the password: git asks it right after. Send it as `secondary`. */
  withPassword: boolean;
  /** Show the "Remember" checkbox (the key store works and the setting is on). */
  canRemember: boolean;
  /** The previous answer to this same question was rejected. */
  retry: boolean;
}

/** Payload of `auth-notice`, sent once per run. */
export interface AuthNotice {
  kind: "storeUnavailable";
  message: string;
}

// ---------------------------------------------------------------- merge conflicts

/** Status of one side of a conflicted file versus the common ancestor. */
export type SideStatus = "modified" | "added" | "deleted" | "missing";

/** `"ours"` is the user's own side ("Yours"): stage 2 of the index, but stage 3 during a rebase. */
export type ConflictSide = "ours" | "theirs";

/** One unmerged file. `ours` / `theirs` already follow the user's view (rebase swap done by the backend). */
export interface ConflictEntry {
  path: string;
  /** Reserved for rename conflicts; always null for now. */
  oldPath: string | null;
  ours: SideStatus;
  theirs: SideStatus;
  /** Binary, not UTF-8, over 2 MiB, a symlink or a submodule: only "Accept Yours / Theirs". */
  binary: boolean;
}

/** One version of a conflicted file. */
export interface ConflictBlob {
  /** Object id; send the ids of all three versions back as `ExpectedOids` when saving. */
  oid: string;
  /** The content, only when it is valid UTF-8, not binary and at most 2 MiB. */
  text: string | null;
  bytesLen: number;
  binary: boolean;
}

/**
 * The blob ids of the three versions the merge editor loaded (`ConflictBlob.oid`, null = that version is absent). A save
 * is refused unless all three still match the index: a change of either side (or the base) makes the editor stale.
 */
export interface ExpectedOids {
  ours: string | null;
  theirs: string | null;
  base: string | null;
}

export interface ConflictLabels {
  /** The user's side: a branch name, or "branch (abc1234 subject)" during a rebase. */
  ours: string;
  /** MERGE_HEAD, the picked / reverted commit, or the branch a rebase goes onto. */
  theirs: string;
  base: string;
}

export interface ConflictVersions {
  /** null: add/add conflict. */
  base: ConflictBlob | null;
  /** null: the user's side deleted the file. */
  ours: ConflictBlob | null;
  theirs: ConflictBlob | null;
  labels: ConflictLabels;
  /** True during a rebase (the backend already swapped `ours` / `theirs` for you). */
  swapped: boolean;
  /** Line ending of the file; the editor works with LF and the backend converts back when saving. */
  eol: "lf" | "crlf";
}

/** Shape of every rejection of an API call (see `ApiError` in `./tauri`). */
export interface ApiErrorShape {
  message: string;
  /** stderr of the failed git command. */
  detail?: string;
}
