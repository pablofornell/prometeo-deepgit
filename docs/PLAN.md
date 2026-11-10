# DeepGit — architecture contract

This file is the contract between the backend (Rust) and the frontend (SolidJS).
Do not change a type or a command signature here without the coordinator.
All JSON is **camelCase** (`#[serde(rename_all = "camelCase")]`). Enums with data use
`#[serde(tag = "kind", rename_all = "camelCase")]`.

## 1. Stack

- Tauri 2, Rust edition 2021, toolchain 1.99.
- Frontend: SolidJS 1, TypeScript 5 (strict), Vite 6. No UI framework. No CSS framework.
- Git access: the `git` CLI (as IntelliJ does). No libgit2.
- Theme: `docs/design/tokens.css` + `docs/design/DESIGN.md` (the designer owns them).

## 2. Repository layout

```
Cargo.toml                 workspace: members = ["src-tauri", "crates/gitcore"]
crates/gitcore/            pure Rust library, no Tauri dependency
  src/lib.rs               re-exports
  src/error.rs             GitError
  src/runner.rs            Git runner (spawn git, env, console sink)
  src/discover.rs          find repositories under a folder
  src/model.rs             all serde types of section 4
  src/log.rs               git log loading + multi-repo merge
  src/graph.rs             lane layout (section 6)
  src/refs.rs              branches, tags, remotes, stashes, head, ahead/behind
  src/status.rs            working tree status (porcelain v2)
  src/diff.rs              unified diff parser, commit file list
  src/ops.rs               write operations
  src/state.rs             in-progress operation detection
src-tauri/                 Tauri app
  src/main.rs, src/lib.rs  setup, plugins, command registration
  src/commands.rs          #[tauri::command] wrappers (section 5)
  src/workspace.rs         projects persistence (JSON in app config dir)
  src/logsession.rs        cached log sessions (section 5.2)
  src/watcher.rs           file watcher -> "repo-changed" events
src/                       SolidJS UI
  api/types.ts             TS mirror of section 4
  api/tauri.ts             typed invoke wrappers + browser mock fallback
  api/mock.ts              fake multi-repo backend for `npm run dev` in a browser
  theme/                   tokens.css (copy of docs/design/tokens.css), fonts
  styles/                  global CSS
  state/                   stores (workspace, selection, log, status, settings)
  components/ui/           primitives: Icon, Button, Menu, Popup, Dialog, Toast,
                           Splitter, VirtualList, Tree, Tooltip, Kbd, Badge
  features/titlebar/  features/sidebar/  features/log/  features/details/
  features/diff/      features/changes/  features/palette/ features/console/
  features/dialogs/   features/statusbar/ features/welcome/
```

## 3. Git runner rules (gitcore/runner.rs)

- Every call: `git -C <repo> -c core.quotepath=false -c color.ui=never -c log.showSignature=false --no-pager <args>`.
- Env: `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`, `GIT_OPTIONAL_LOCKS=0` for read commands, `GIT_EDITOR=true` (no editor for merge/rebase --continue).
- Never use a shell. Pass args as a Vec.
- Each call reports a `ConsoleEntry` to an optional sink (`Arc<dyn Fn(ConsoleEntry) + Send + Sync>`). stdout/stderr in the entry are truncated to 8 KiB.
- Non-zero exit → `GitError::Command { args, code, stderr }`.
- Read commands are safe to run in parallel. Write commands for the same repo are serialized by the app (a per-repo `tokio::sync::Mutex` in src-tauri).
- `fetch`, `pull`, `push` and `clone` are network commands: own process group, `ssh -o BatchMode=yes`, killed after 120 s without output or 60 min in total. `Git::run_streaming(dir, repo_id, args, &CancelToken, on_stderr)` runs one of them and hands its stderr to a callback while it runs; the token kills the process group and the call returns `GitError::Cancelled` ("The operation was cancelled.").

## 4. Types (Rust names; TS mirror is identical, camelCase)

New in this part (the rest is in `model.rs` / `src/api/types.ts`):
`MergeMode = "ff" | "noFf" | "ffOnly" | "squash"`;
`MergeOpts { mode: MergeMode (default "ff"), message: string | null, noCommit: bool, allowUnrelatedHistories: bool }`
(rules of IntelliJ `GitMergeOption`: a message needs a merge commit, so not with `ffOnly`, `squash` or `noCommit`;
`noCommit` is not for `ffOnly` and `squash`; a blank message is no message; other mixes are refused with `GitError::Invalid`);
`CloneOpts { branch: string | null, depth: number | null, recurseSubmodules: bool }`;
`CloneTarget = { kind: "project", projectId } | { kind: "newProject" }`;
`CloneProgress { phase: string, percent: number | null }` (the event adds `operationId`);
`CloneResult { path: string, project: Project, createdProject: bool }`.

```rust
pub struct RepoInfo { pub id: String, pub name: String, pub path: String,
                      pub color: u8, pub custom_color: Option<String> }
// id = first 12 hex chars of sha1(canonical path). name = path relative to project root,
// or the folder name when the repo is the project root.
// color = index in the 12-colour palette (PALETTE_SIZE = 12, src/theme/colors.css). It is always set.
// custom_color = "#RRGGBB" (upper case) the user typed in; when set it wins over `color`.
// `custom_color` is `#[serde(default)]`: old workspace.json files load (None).
//
// Colour assignment (src-tauri/src/workspace.rs, gitcore/src/palette.rs):
// - A new repo gets the palette index that is used least among the repos of the workspace that show
//   a palette colour (repos with a custom colour show none). Ties: the lowest index.
// - A repo the workspace already knows (same id, in any project) keeps `color` and `custom_color`
//   when a project is added again or rescanned. A repo that vanished frees its colour.
// - One repo has one colour: `repo_set_color` changes every copy of the repo in all projects.

pub struct Project { pub id: String, pub name: String, pub path: String, pub repos: Vec<RepoInfo>,
                     pub color: u8, pub custom_color: Option<String> }
// Same rules for the project colour: least-used index among the projects, `custom_color` wins.
// Old files have no project colour (`color` = 255 on load, `UNASSIGNED`); the workspace gives each such
// project the least-used index when it loads.

pub struct Workspace { pub projects: Vec<Project>, pub active_project_id: Option<String>,
                       pub ui: serde_json::Value /* opaque UI state the frontend saves */ }

pub enum RepoStateKind { Clean, Merging, Rebasing, CherryPicking, Reverting, Bisecting }

pub struct RepoSummary {
  pub repo_id: String,
  pub branch: Option<String>,        // None when detached
  pub head_oid: Option<String>,      // None in an empty repo
  pub upstream: Option<String>,      // "origin/main"
  pub ahead: u32, pub behind: u32,
  pub staged: u32, pub unstaged: u32, pub untracked: u32, pub conflicted: u32,
  pub state: RepoStateKind,
  pub stash_count: u32,
}

pub struct LocalBranch { pub name: String, pub oid: String, pub upstream: Option<String>,
  pub ahead: u32, pub behind: u32, pub is_head: bool, pub gone: bool /* upstream deleted */ }
pub struct RemoteBranch { pub remote: String, pub name: String /* "main" */, pub full_name: String /* "origin/main" */, pub oid: String }
pub struct Tag { pub name: String, pub oid: String /* peeled commit */, pub annotated: bool }
pub struct Stash { pub index: u32, pub message: String, pub oid: String, pub time: i64 }
pub struct Remote { pub name: String, pub url: String }
pub struct Submodule { pub path: String, pub oid: String, pub status: char /* ' ', '+', '-', 'U' */ }
pub struct Refs { pub local: Vec<LocalBranch>, pub remote: Vec<RemoteBranch>, pub tags: Vec<Tag>,
  pub stashes: Vec<Stash>, pub remotes: Vec<Remote>, pub submodules: Vec<Submodule> }

pub enum RefKind { Head, Local, Remote, Tag, Stash }
pub struct RefLabel { pub kind: RefKind, pub name: String, pub is_current: bool }
// Head label = "HEAD" only when detached. The checked-out local branch has is_current = true.

pub struct GraphSegment { pub x1: u16, pub y1: u8, pub x2: u16, pub y2: u8, pub color: u16 }
// y: 0 = top edge of row, 1 = row middle (node centre), 2 = bottom edge of row.
pub struct GraphRow { pub node: u16, pub color: u16, pub segments: Vec<GraphSegment>, pub width: u16 }
// width = number of lanes used in this row (max column index + 1).

pub struct CommitRow {
  pub repo_id: String, pub oid: String, pub parents: Vec<String>,
  pub author_name: String, pub author_email: String, pub author_time: i64,
  pub committer_time: i64, pub subject: String,
  pub refs: Vec<RefLabel>, pub graph: GraphRow,
}

pub struct LogQuery {
  pub repo_ids: Vec<String>,        // 1 or more repos of the active project
  pub refs: Vec<String>,            // empty = --branches --remotes --tags HEAD
  pub text: Option<String>,         // --grep=<t> -i (message) ; if it looks like a hex hash (>=4 chars) also match oid prefix
  pub author: Option<String>,       // --author=<a> -i
  pub path: Option<String>,         // -- <path>
  pub since: Option<i64>, pub until: Option<i64>, // unix seconds
  pub max_count: u32,               // default 50_000 per repo
}
pub struct LogSessionInfo { pub session_id: u64, pub total: u32, pub max_lanes: u16, pub truncated: bool,
  pub skipped: Vec<SkippedRepo> /* default empty */ }
// Repos left out of the combined log because loading them failed (folder gone, git error).
// JS: skipped: { repoId, message }[]. log_open fails only when ALL requested repos fail.
pub struct SkippedRepo { pub repo_id: String, pub message: String }

pub enum FileStatus { Added, Modified, Deleted, Renamed, Copied, TypeChanged, Untracked, Conflicted, Ignored }
pub struct FileChange { pub path: String, pub old_path: Option<String>, pub status: FileStatus,
  pub additions: Option<u32>, pub deletions: Option<u32>, pub binary: bool }

pub struct Person { pub name: String, pub email: String, pub time: i64, pub tz: String /* "+0100" */ }
pub struct CommitDetails { pub repo_id: String, pub oid: String, pub parents: Vec<String>,
  pub author: Person, pub committer: Person, pub subject: String, pub body: String,
  pub refs: Vec<RefLabel>, pub files: Vec<FileChange> /* vs first parent; root commit vs empty tree */ }

pub struct WorkingTree { pub repo_id: String, pub staged: Vec<FileChange>, pub unstaged: Vec<FileChange>,
  pub conflicted: Vec<FileChange> /* untracked files are in unstaged with status Untracked */ }

pub enum DiffSpec {
  Commit { oid: String, parent: Option<String> }, // parent None = first parent
  Staged,                                          // index vs HEAD
  Unstaged,                                        // worktree vs index; untracked = whole file added
}
pub enum LineKind { Context, Add, Del }
pub struct DiffLine { pub kind: LineKind, pub old_no: Option<u32>, pub new_no: Option<u32>, pub text: String }
pub struct Hunk { pub old_start: u32, pub old_lines: u32, pub new_start: u32, pub new_lines: u32,
  pub header: String /* text after the second @@ */, pub lines: Vec<DiffLine> }
pub struct FileDiff { pub path: String, pub old_path: Option<String>, pub binary: bool,
  pub hunks: Vec<Hunk>, pub too_large: bool /* > 20_000 lines: hunks empty */ }

pub struct ConsoleEntry { pub id: u64, pub repo_id: Option<String>, pub args: Vec<String>,
  pub started_at: i64 /* unix ms */, pub duration_ms: u64, pub exit_code: Option<i32>,
  pub stdout: String, pub stderr: String }

pub struct RepoChanged { pub repo_id: String } // event payload

pub struct OpResult { pub ok: bool, pub message: String /* git stdout+stderr summary */,
  pub conflicts: bool }

pub enum ResetMode { Soft, Mixed, Hard, Keep }

// Error sent to the frontend:
pub struct ApiError { pub message: String, pub detail: Option<String> /* stderr */ }
```

## 5. Tauri commands (src-tauri/commands.rs)

All commands are `async`, return `Result<T, ApiError>`. TS wrappers live in `src/api/tauri.ts`
with the same name in camelCase (e.g. `logOpen`).

### 5.1 Workspace
| command | args | returns |
|---|---|---|
| `workspace_load` | – | `Workspace` |
| `workspace_save_ui` | `ui: Value` | `()` |
| `project_add` | `path: String` | `Project` (repos discovered, depth ≤ 4, skip `node_modules`, `target`, `.git` internals, hidden dirs except the root; a folder that is a repo is still scanned for nested repos) |
| `project_remove` | `projectId` | `()` |
| `project_rescan` | `projectId` | `Project` |
| `project_set_active` | `projectId` | `()` |
| `repo_set_color` | `repoId`, `color: Option<u8>`, `custom: Option<String>` | `RepoInfo` (updated; saves the workspace) |
| `project_set_color` | `projectId`, `color: Option<u8>`, `custom: Option<String>` | `Project` (updated; saves the workspace) |

Colour commands (`color`, `custom`): give a palette index (`0..11`) **or** a `#RRGGBB` string **or** neither.
- `color = Some(i)`: sets the palette index and clears the custom colour. Error `Unknown palette color` when `i >= 12`.
- `custom = Some(hex)`: sets the custom colour (stored upper case) and keeps the palette index. Error `Invalid color, expected #RRGGBB` for anything else.
- both `None` ("Auto"): clears the custom colour and sets `color` to the least-used index among the other repos (or projects).
- both `Some`: error `Give a palette color or a custom color, not both`. Unknown id: `unknown repository` / `unknown project`.
The browser mock (`src/api/mock.ts`, `mockColors.ts`) applies the same rules and messages.
| `repo_summaries` | `repoIds: Vec<String>` | `Vec<RepoSummary>` (parallel) |

### 5.2 Log (server-side sessions; the UI only fetches visible rows)
| command | args | returns |
|---|---|---|
| `log_open` | `query: LogQuery` | `LogSessionInfo` (loads all repos in parallel, merges, computes the graph, keeps rows in memory) |
| `log_rows` | `sessionId, start: u32, count: u32` | `Vec<CommitRow>` |
| `log_find` | `sessionId, oid: String` (prefix ok), `repoId: Option<String>` (when given, only rows of that repo match) | `Option<u32>` index |
| `log_close` | `sessionId` | `()` (keep max 4 sessions; evict the oldest) |

### 5.3 Read
| `refs` | `repoId` | `Refs` |
| `commit_details` | `repoId, oid` | `CommitDetails` |
| `branches_containing` | `repoId, oid` | `Vec<String>` (local + remote names) |
| `working_tree` | `repoId` | `WorkingTree` |
| `file_diff` | `repoId, spec: DiffSpec, path: String, oldPath: Option<String>, context: u32` | `FileDiff` |
| `file_content` | `repoId, rev: Option<String> /* None = worktree */, path` | `String` (max 2 MiB) |
| `last_commit_message` | `repoId` | `String` |

### 5.4 Write (per-repo serialized; each emits `repo-changed` after)
| `stage` / `unstage` / `discard` | `repoId, paths: Vec<String>` | `()` (discard of untracked = delete file) |
| `stage_hunk` | `repoId, path, hunkIndex: u32, reverse: bool /* true = unstage */, oldPath: Option<String> /* renamed file */, expected: Option<{oldStart, oldLines, newStart, newLines, hash?: String}> /* hunk identity; stale ("The file changed. Reload the diff.") if the header numbers or, when sent, the body hash no longer match; hash = `hunk_hash`, see below */, context: Option<u32> /* diff context lines, default 3; must match the diff the UI showed */` | `()` (built from Unstaged/Staged diff with context 3, applied with `git apply --cached [-R] --unidiff-zero=false`) |
| `discard_hunk` | `repoId, path, hunkIndex, expected: Option<{oldStart, oldLines, newStart, newLines}>, context: Option<u32>` (same meaning as in `stage_hunk`) | `()` |
| `commit` | `repoId, message, amend: bool, signOff: bool` | `OpResult` (`signOff` = `--signoff`: a `Signed-off-by: <name> <email>` trailer of the committer; with an empty message and `amend` it is `--amend --no-edit --signoff`. A message that has that exact line already is not signed again: git alone only looks at the last trailer and would add a second line after e.g. a `Co-authored-by`) |
| `checkout` | `repoId, target: String, newBranch: Option<String>` | `OpResult` (remote branch target + newBranch = `checkout -b new --track remote/x`) |
| `branch_create` | `repoId, name, startPoint: String, checkout: bool` | `OpResult` |
| `branch_delete` | `repoId, name, force: bool, remote: bool` | `OpResult` (remote form: `name` is `"remote/branch"`, resolved against the longest configured remote name, then `push <remote> --delete refs/heads/<branch>`) |
| `branch_rename` | `repoId, oldName, newName` | `OpResult` |
| `merge` | `repoId, target, opts: MergeOpts` | `OpResult` (`git merge [--no-edit] [--no-ff \| --ff-only \| --squash] [--no-commit] [--allow-unrelated-histories] [-m message] [--end-of-options] target`; see `MergeOpts` below. `--ff-only` on diverged branches fails with "Cannot fast-forward: the branches have diverged. Choose another merge mode."; squash stages the changes and leaves no `MERGE_HEAD`; `--no-commit` leaves the repo `merging` and the commit box finishes it) |
| `rebase` | `repoId, onto` | `OpResult` (runs `git rebase --autostash onto`: a dirty worktree is stashed and restored; `op_abort` restores it too; the UI does no manual stash/pop) |
| `cherry_pick` | `repoId, oids: Vec<String>` | `OpResult` |
| `revert` | `repoId, oid` | `OpResult` |
| `reset` | `repoId, target, mode: ResetMode` | `OpResult` |
| `op_continue` / `op_abort` / `op_skip` | `repoId` | `OpResult` (acts on the detected RepoStateKind) |
| `fetch` | `repoId, remote: Option<String> /* None = --all */, prune: bool` | `OpResult` |
| `pull` | `repoId, rebase: bool` | `OpResult` |
| `push` | `repoId, remote: Option<String>, branch: Option<String> /* pushed as `refs/heads/<b>:refs/heads/<b>`; a leading `+` or any `:`, `^`, `~` is rejected */, force: bool /* --force-with-lease */, setUpstream: bool, tags: bool` | `OpResult` |
| `stash_save` | `repoId, message: Option<String>, includeUntracked: bool, keepIndex: bool` | `OpResult` |
| `stash_apply` / `stash_pop` / `stash_drop` | `repoId, index, oid: Option<String>` (stash commit the UI listed; the call fails with "The stash list changed. Reload." if `stash@{index}` is no longer it) | `OpResult` |
| `tag_create` | `repoId, name, target, message: Option<String>` | `OpResult` |
| `tag_delete` | `repoId, name` | `OpResult` |

A git failure that is an expected outcome (merge conflict, rebase stop) returns
`OpResult { ok: false, conflicts: true }`, **not** an error. An operation that stopped without
conflicts (empty cherry-pick, failing hook) also returns `OpResult { ok: false, conflicts: false }`
and stays in progress for continue / skip / abort. Every other failure returns `ApiError` with a
friendly `message` (e.g. "Push rejected: the remote has new commits. Pull first.") and the raw git
stderr in `detail`. Also `ok: false, conflicts: true`: a command that exits 0 but leaves unmerged
files, e.g. a rebase whose autostash could not be restored (message: "Rebase done, but your local
changes conflict with it. They are kept in the stash (stash@{0}). Resolve the files, then drop the
stash."). `op_continue` / `op_skip` that stop again without conflicts (empty commit) return
`OpResult { ok: false, conflicts: false }` as well.

`hunk_hash(h: &Hunk) -> String` (gitcore, mirrored in TS): FNV-1a 32 bit (offset `0x811c9dc5`,
prime `0x01000193`, wrapping u32 multiply) over the UTF-8 bytes of, for each line of the hunk in
order, one kind char (`' '` context, `'+'` add, `'-'` del) + `text` + `"\n"`; 8 lowercase hex
digits. Test vector: lines `[Context "fn main() {", Del "    old é", Add "    new", Add "",
Context "}"]` -> `107351ed`; no lines -> `811c9dc5`. The backend hashes the hunk parsed from the
current diff (same parser and lossy decoding as the UI).

Network commands (`fetch`, `pull`, `push`, run with `--progress`) are killed after 120 s without
any output on stdout or stderr, or after 60 min in total; the error is `Timeout`. When a killed
`pull` leaves `.git/index.lock`, the message says "A git lock file may remain: .git/index.lock"
(the file is not removed).

### 5.6 Clone

| command | args | returns |
|---|---|---|
| `clone_repo` | `operationId: String, url: String, parentDir: String, dirName: String, opts: CloneOpts, target: CloneTarget` | `CloneResult` |
| `clone_cancel` | `operationId: String` | `()` (does nothing when that clone has finished) |

`git clone --progress [--branch b] [--depth n] [--recurse-submodules] -- <url> <parentDir>/<dirName>`, run in
`parentDir`. The frontend makes `operationId` up; it ties the `clone-progress` events and `clone_cancel` to the call.
Rules (`gitcore::clone::plan_clone`, mirrored in `src/api/cloneRules.ts` and the mock): the URL is trimmed, not empty,
does not start with `-`, has no control character and no `ext::` / `fd::` transport; `dirName` is one path segment (no
`/`, `\`, `..`); `parentDir` is an existing absolute folder (`~` is expanded); the target does not exist, or is an
empty folder (not a link); the branch passes `check_name`; the depth is at least 1.
Stderr is cut at `\r` / `\n` and every `Phase: NN%` segment ("Receiving objects", "Resolving deltas", "Counting
objects", "Compressing objects", "Updating files"; "Enumerating objects: 11, done." has `percent: null`) becomes one
`clone-progress` event, once per change. A failed, timed out or cancelled clone removes what it made: the folder when the
clone created it, else only the files in it (it was empty). On success `target` decides where the repo goes:
`{ kind: "project", projectId }` rescans that project (the parent folder must be inside its folder: this is checked
before the clone starts) and `{ kind: "newProject" }` adds a project whose folder is the clone.
`gitcore::clone::default_dir_name(url)` is the folder name git would pick (`https://h/o/r.git/` -> `r`,
`git@h:o/r.git` -> `r`, `file:///x/r` -> `r`, `/x/r/.git` -> `r`).

### 5.5 Events (backend → frontend)
- `git-console` : `ConsoleEntry` (every git call).
- `clone-progress` : `{ operationId, phase, percent: number | null }` while `clone_repo` runs.
- `repo-changed` : `RepoChanged` (watcher, debounced 400 ms; also after each write command).
  The watcher watches the worktree recursively and ignores paths inside `.git` except
  `HEAD`, `index`, `refs/**`, `packed-refs`, `MERGE_HEAD`, `rebase-merge`, `rebase-apply`, `CHERRY_PICK_HEAD`.

## 6. Graph layout algorithm (gitcore/graph.rs)

Input: rows in display order, each with `key` (repoId + oid) and `parent keys`.
State: `lanes: Vec<Option<Lane{ expect: Key, color: u16 }>>`, `next_color: u16`.

For each row:
1. `matches` = lanes whose `expect == row.key`. If empty, allocate a lane (first `None`
   slot, else push) with `color = next_color++`. `node` = leftmost match.
2. Top half: for each matching lane `L`: segment `(L,0)->(node,1)` with the lane colour.
3. Pass-through: for each other active lane `L` (not matching): segment `(L,0)->(L,2)`.
4. Free all matching lanes.
5. Parents in order. Parent 0: if a lane already expects it → segment `(node,1)->(thatLane,2)`;
   else put it in lane `node` with the node colour → segment `(node,1)->(node,2)`.
   Parent i>0: if a lane already expects it → segment to that lane; else allocate the first
   free slot (`None`) **right of `node`** or push, colour `next_color++`, segment `(node,1)->(slot,2)`.
6. Row colour = colour of lane `node` before freeing. Trim trailing `None` lanes.
   `width` = max x in the row's segments and node + 1. `max_lanes` = max width.
Colour index is unbounded; the UI takes `color % paletteSize`.

## 7. Multi-repo log merge (gitcore/log.rs)

- One `git log` per repo, in parallel (std threads or rayon-free `std::thread::scope`):
  `git log --topo-order --date-order --no-color --max-count=N --format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%ct%x1f%s%x1e <refs or --branches --remotes --tags HEAD> [filters] [-- path]`
- Refs from `git for-each-ref --format=%(objectname)%00%(*objectname)%00%(refname)%00%(HEAD)`.
- Merge: k-way, take the head whose `committer_time` is greatest. Only pop from list fronts
  (keeps each repo's topo order).
- Graph keys include the repo id, so repos never share lanes.

## 8. Frontend rules

- `src/api/tauri.ts`: `const isTauri = '__TAURI_INTERNALS__' in window`. In a browser, every
  wrapper calls `mock.ts`. The mock has a project "acme-platform" with 4 repos and a
  single-repo project "deepgit", with ~3000 fake commits incl. merges, and implements the graph
  algorithm of section 6 in TS. `npm run dev` must show a fully usable UI in a browser.
- Lists use `VirtualList` (fixed row height). The log fetches rows in pages of 200 with an LRU
  page cache, and discards the cache when the session changes.
- Stores: plain Solid `createStore`/signals in `src/state/*.ts`. No global event bus except
  `src/state/events.ts` (subscribes to `git-console` and `repo-changed` once).
- Each feature folder exports one root component, named in DESIGN.md. Feature code imports
  only from `api/`, `state/`, `components/ui/` and its own folder.
- Keyboard: a single `src/state/keymap.ts` registry. Search Everywhere: Shift Shift and Ctrl+K.
- No `any` in exported types. No network requests at runtime.

## 9. Verification

- `cargo test -p gitcore` (tests create temporary repos with `git init` in `tempfile` dirs).
- `cargo clippy --workspace -- -D warnings`.
- `npm run build` (tsc + vite).
- Browser: `npm run dev` + Playwright screenshots of the main views on the mock backend.
- Desktop: `npm run tauri build -- --no-bundle` and a smoke run on this repo.
