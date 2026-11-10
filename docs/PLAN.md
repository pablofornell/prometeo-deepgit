# DeepGit — architecture contract

This file is the contract between the backend (Rust) and the frontend (SolidJS).
Do not change a type or a command signature here without the coordinator.
All JSON is **camelCase** (`#[serde(rename_all = "camelCase")]`). Enums with data use
`#[serde(tag = "kind", rename_all = "camelCase")]`.

## 1. Stack

- Tauri 2, Rust edition 2021, toolchain 1.99.
- Frontend: SolidJS 1, TypeScript 5 (strict), Vite 6. No UI framework. No CSS framework.
- Git access: the `git` CLI (as IntelliJ does). No libgit2.
- Theme: `src/theme/tokens.css` + `src/theme/colors.css`, spec in `docs/design/DESIGN.md` (the designer owns it).
  `docs/design/tokens.css` is v1 history (the token set of the v1 mockup), not kept up to date.

## 2. Repository layout

```
Cargo.toml                 workspace: members = ["src-tauri", "crates/gitcore", "crates/askpass"]
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
  src/conflicts.rs         unmerged files, their three versions, accept a side, save a resolution (section 5.8)
  src/state.rs             in-progress operation detection
  src/auth.rs              AuthMode, AuthBroker trait, apply_auth_env (section 5.6)
crates/askpass/            helper mode of the app binary, local IPC, credential broker (no Tauri dependency)
  src/helper.rs            what the binary does when git or ssh runs it as askpass
  src/protocol.rs          length-prefixed JSON frames; env names
  src/endpoint.rs          unix socket / loopback TCP endpoint
  src/server.rs            tokio listener (private directory, mode 0700 / 0600)
  src/prompt.rs            classifies the prompts of git and ssh
  src/broker.rs            tokens, answers, save after success, forget after failure
  src/store.rs             key store trait, index of saved keys, in-memory backend
  src/bin/askpass-helper.rs  the helper as its own program (integration tests)
src-tauri/                 Tauri app
  src/main.rs, src/lib.rs  setup, plugins, command registration
  src/commands.rs          #[tauri::command] wrappers (section 5)
  src/workspace.rs         projects persistence (JSON in app config dir)
  src/logsession.rs        cached log sessions (section 5.2)
  src/watcher.rs           file watcher -> "repo-changed" events
  src/auth.rs              auth-prompt events, auth_reply, keyring backend (section 5.6)
src/                       SolidJS UI
  api/types.ts             TS mirror of section 4
  api/tauri.ts             typed invoke wrappers + browser mock fallback
  api/mock.ts              fake multi-repo backend for `npm run dev` in a browser
  theme/                   tokens.css, colors.css (the tokens in use; started as a copy of docs/design/tokens.css), fonts
  styles/                  global CSS
  state/                   stores (workspace, selection, log, status, settings)
  components/ui/           primitives: Icon, Button, Menu, Popup, Dialog, Toast,
                           Splitter, VirtualList, Tree, Tooltip, Kbd, Badge
  features/titlebar/  features/sidebar/  features/log/  features/details/
  features/diff/      features/changes/  features/palette/ features/console/
  features/dialogs/   features/statusbar/ features/welcome/
  features/merge/          conflicts dialog and the three-pane merge window (section 5.8)
```

## 3. Git runner rules (gitcore/runner.rs)

- Every call: `git -C <repo> -c core.quotepath=false -c color.ui=never -c log.showSignature=false --no-pager <args>`.
- Env: `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`, `GIT_OPTIONAL_LOCKS=0` for read commands, `GIT_EDITOR=true` (no editor for merge/rebase --continue).
- Network commands (`fetch`, `pull`, `push` and `clone`) run in a new session (no controlling terminal) and get their authentication environment from one function, `gitcore::auth::apply_auth_env` (section 5.6).
- Never use a shell. Pass args as a Vec.
- Each call reports a `ConsoleEntry` to an optional sink (`Arc<dyn Fn(ConsoleEntry) + Send + Sync>`). stdout/stderr in the entry are truncated to 8 KiB.
- Non-zero exit → `GitError::Command { args, code, stderr }`.
- Read commands are safe to run in parallel. Write commands for the same repo are serialized by the app (a per-repo `tokio::sync::Mutex` in src-tauri).
- `fetch`, `pull`, `push` and `clone` are network commands: own process group, `ssh -o BatchMode=yes`, killed after 120 s without output or 60 min in total (a clone has no 60 min cap: a big repository keeps printing progress; the inactivity limit and Cancel still stop it). `Git::run_streaming(dir, repo_id, args, &CancelToken, on_stderr)` runs one of them and hands its stderr to a callback while it runs; the token kills the process group and the call returns `GitError::Cancelled` ("The operation was cancelled.").

## 4. Types (Rust names; TS mirror is identical, camelCase)

New in this part (the rest is in `model.rs` / `src/api/types.ts`):
`MergeMode = "ff" | "noFf" | "ffOnly" | "squash"`;
`MergeOpts { mode: MergeMode (default "ff"), message: string | null, noCommit: bool, allowUnrelatedHistories: bool }`
(rules of IntelliJ `GitMergeOption`: a message needs a merge commit, so not with `ffOnly`, `squash` or `noCommit`;
`noCommit` is not for `ffOnly` and `squash`; a blank message is no message, and the dialog sends one only when the user typed it (git's default text depends on the branch and `merge.suppressDest`); other mixes are refused with `GitError::Invalid`);
`CloneOpts { branch: string | null, depth: number | null, recurseSubmodules: bool }`;
`CloneTarget = { kind: "project", projectId } | { kind: "newProject" }`;
`CloneProgress { phase: string, percent: number | null }` (the event adds `operationId`);
`CloneResult { path: string, project: Project, createdProject: bool }`.

```rust
pub struct RepoInfo { pub id: String, pub name: String, pub path: String }
// id = first 12 hex chars of sha1(canonical path). name = path relative to project root,
// or the folder name when the repo is the project root.

pub struct Project { pub id: String, pub name: String, pub path: String, pub repos: Vec<RepoInfo> }
// Repositories and projects have no colour. Files written by older versions hold `color` and
// `customColor` on both: serde ignores them on load, and the next save drops them.

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
  pub stdout: String, pub stderr: String,
  pub background: bool /* a network command run with AuthMode::Silent (auto-fetch): hidden by default in the console */ }

pub struct RepoChanged { pub repo_id: String } // event payload

pub struct OpResult { pub ok: bool, pub message: String /* git stdout+stderr summary */,
  pub conflicts: bool }

pub enum ResetMode { Soft, Mixed, Hard, Keep }

// Merge conflicts (section 5.8). "ours" is always the user's own side ("Yours" in the UI).
pub enum SideStatus { Modified, Added, Deleted, Missing }   // camelCase strings
pub enum ConflictSide { Ours, Theirs }                      // "ours" | "theirs"
pub struct ConflictEntry { pub path: String, pub old_path: Option<String> /* reserved, always None */,
  pub ours: SideStatus, pub theirs: SideStatus,
  pub binary: bool /* binary, not UTF-8, > 2 MiB, symlink or submodule: only accept a whole side */ }
pub struct Blob { pub oid: String, pub text: Option<String> /* only valid UTF-8 without NUL, <= 2 MiB */,
  pub bytes_len: u64, pub binary: bool }                    // TS name: ConflictBlob
pub struct ConflictLabels { pub ours: String, pub theirs: String, pub base: String }
pub enum Eol { Lf, Crlf }                                   // "lf" | "crlf"
pub struct ConflictVersions { pub base: Option<Blob>, pub ours: Option<Blob>, pub theirs: Option<Blob>,
  pub labels: ConflictLabels, pub swapped: bool, pub eol: Eol }

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
| `project_add` | `path: String` | `Project` (repos discovered, depth ≤ 4, skip `node_modules`, `target`, `.git` internals, hidden dirs except the root; a folder that is a repo is still scanned for nested repos). The name is the folder name; when another project has that name already (compared as in `project_rename`), it gets a number: `api (2)`, `api (3)`. The same folder again returns the project it already is |
| `project_remove` | `projectId` | `()` |
| `project_rescan` | `projectId` | `Project` |
| `project_set_active` | `projectId` | `()` |
| `project_rename` | `projectId`, `name: String` | `Project` (updated; saves the workspace atomically). The name is trimmed. Errors: `The project name cannot be empty.`, `The project name is too long: 80 characters at most.` (characters, not bytes), `The project name cannot contain control characters (tab, new line).`, `Another project is already called "<name>".` (other projects, trimmed, Unicode NFC and a simple case fold: `name_key` / `nameKey`), `unknown project`. The id never changes (it comes from the path), and `project_rescan` keeps the name. The mock and the UI use the same rules (`src/api/projectName.ts`). |
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
| `merge` | `repoId, target, opts: MergeOpts` | `OpResult` (`git merge [--no-edit] [--no-ff \| --ff-only \| --squash] [--no-commit] [--allow-unrelated-histories] [-m message] [--end-of-options] target`; see `MergeOpts` below. `--ff-only` on diverged branches fails with "Cannot fast-forward: the branches have diverged. Choose another merge mode."; squash stages the changes and leaves no `MERGE_HEAD`; `--no-commit` leaves the repo `merging` and the commit box finishes it; git would fast-forward and ignore `--no-commit`, so mode `ff` with `noCommit` also sends `--no-ff`) |
| `rebase` | `repoId, onto` | `OpResult` (runs `git rebase --autostash onto`: a dirty worktree is stashed and restored; `op_abort` restores it too; the UI does no manual stash/pop) |
| `cherry_pick` | `repoId, oids: Vec<String>` | `OpResult` |
| `revert` | `repoId, oid` | `OpResult` |
| `reset` | `repoId, target, mode: ResetMode` | `OpResult` |
| `op_continue` / `op_abort` / `op_skip` | `repoId` | `OpResult` (acts on the detected RepoStateKind) |
| `fetch` | `repoId, remote: Option<String> /* None = --all */, prune: bool, background: Option<bool> /* auto-fetch: Silent auth, no dialog */` | `OpResult` |
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

### 5.5 Events (backend → frontend)
- `git-console` : `ConsoleEntry` (every git call).
- `clone-progress` : `{ operationId, phase, percent: number | null }` while `clone_repo` runs.
- `repo-changed` : `RepoChanged` (watcher, debounced 400 ms; also after each write command).
  The watcher watches the worktree recursively and ignores paths inside `.git` except
  `HEAD`, `index`, `refs/**`, `packed-refs`, `MERGE_HEAD`, `rebase-merge`, `rebase-apply`, `CHERRY_PICK_HEAD`.
- `auth-prompt`, `auth-prompt-close`, `auth-notice`: see 5.6.

### 5.6 Authentication (password, token, passphrase, host key)

git and ssh can ask the user. They run the app's own executable as their askpass program; the app shows the
question as a dialog and prints the answer back. Port of IntelliJ's `GitHandlerAuthenticationManager`.

**Modes** (`gitcore::AuthMode`, chosen per `Git` handle with `with_auth_mode`, default `Interactive`):

| mode | for | git | ssh |
|---|---|---|---|
| `None` | no broker, tests | `GIT_TERMINAL_PROMPT=0` | `SSH_ASKPASS_REQUIRE=never`, `GIT_SSH_COMMAND="ssh -o BatchMode=yes"` unless the user set `GIT_SSH_COMMAND`, `GIT_SSH` or `core.sshCommand` |
| `Silent` | background commands (auto-fetch): `git.clone().with_auth_mode(AuthMode::Silent)` | + `GIT_ASKPASS=<this exe>`; the helper answers from saved credentials only and fails fast | like `None` (BatchMode blocks passphrase questions) |
| `Interactive` | commands the user started | + `GIT_ASKPASS=<this exe>` | `SSH_ASKPASS=<this exe>`, `SSH_ASKPASS_REQUIRE=force`, `DISPLAY=:0.0` when unset (Unix), no `BatchMode`; a user `core.sshCommand` / `GIT_SSH_COMMAND` stays |

All modes with a broker also set `DEEPGIT_ASKPASS=1`, `DEEPGIT_ASKPASS_ENDPOINT`, `DEEPGIT_ASKPASS_TOKEN`.
User credential helpers (`credential.helper`) still run first; the helper is only called for what they cannot answer.
`Git::run*` and `Git::run_streaming` (so `clone`) do this themselves for every network command: `begin_auth(repo_id, "git <sub>")`
before the spawn, `apply_auth` on the command, `ticket.finish(&AuthOutcome { success, stderr })` after it ends (also after a cancel or
a timeout). Finishing the ticket revokes the token and withdraws an open prompt, so cancelling a clone closes its login dialog
(`auth-prompt-close`) and the helper stops waiting. A command that bypasses the runner calls the three functions by hand.
`clone_repo` runs in `Interactive` mode (a private HTTPS repository asks for a login). The `fetch` command has a `background: bool`
argument: the auto-fetch sets it and the command runs with `AuthMode::Silent`; a fetch the user starts leaves it out.

**Helper mode.** At the start of `main` (before Tauri), `askpass::run_from_env()` checks `DEEPGIT_ASKPASS=1` plus the endpoint and
token variables. If they are set, the process is a helper: it reads the prompt from argv[1], sends one request, prints the
answer and `\n` on stdout and exits 0. On cancel, timeout (6 min), unknown token or any error it prints nothing and exits 1.
No window, GTK or Tauri code runs. `SSH_ASKPASS_PROMPT=none` (an ssh info message) exits 0 without a request.

**IPC.** One request and one reply per connection. Frame = 4-byte big-endian length + JSON (max 64 KiB).
```
helper -> app   {"v":1,"token":"<64 hex>","prompt":"Username for 'https://github.com': ","hint":null|"confirm"|"none","ppid":4242|null,"sshPort":2222|null}
app -> helper   {"answer":"alice"}     or     {"answer":null}
```
Transport: Unix = domain socket `sock` (mode 0600) in a fresh directory `deepgit-askpass-<pid>-<random>` (mode 0700) under
`$XDG_RUNTIME_DIR` (else the temp dir, else `/tmp` when the path would not fit `sun_path`: 104 bytes on macOS, where the temp dir is
long); a peer with another uid is dropped; directories of dead processes (this user's only, never a link) are swept at start.
Windows = TCP on `127.0.0.1`, port chosen by the system (a named pipe would be better; untested). `DEEPGIT_ASKPASS_ENDPOINT` is
`unix:<path>` or `tcp:127.0.0.1:<port>`.
Each network command gets a fresh 32-byte random token (64 hex chars), passed only in the child's environment, never in argv. The
server answers only a live token; the token dies when the command ends (also when it is killed, and when the `AuthTicket` is
dropped without `finish`: `Drop` runs the same hook with a failed, empty outcome). The frame never carries a secret except the
answer. `ppid` (Unix) is the process that ran the helper, the git or ssh child that asks; `sshPort` is the `-p` port of that ssh
(Linux, read from `/proc`), used for the key of an ssh password.

**Prompts** (`PromptKind`): `username`, `password`, `passphrase`, `pin`, `hostkey`, `unknown`. Parsed from git's
`Username for 'https://host'` / `Password for 'https://user@host'`, ssh's `Enter passphrase for [key ]'<path>'`, `Bad passphrase, try again for <path>`,
`<user>@<host>'s password`, `Enter PIN for '<label>'` and the host-key question (`continue connecting`, or `SSH_ASKPASS_PROMPT=confirm`).
The answer to a host-key question is `yes`; Reject is a cancel.

**Events and commands.**

| name | direction | payload |
|---|---|---|
| `auth-prompt` | event | `{ id, kind, prompt, host?, user?, keyPath?, repoId?, command, withPassword, canRemember, retry }` |
| `auth-prompt-close` | event | `{ id }`: the question is gone (5 min without answer, or the command ended) |
| `auth-notice` | event | `{ kind: "storeUnavailable", message }`, once per run |
| `auth_reply` | command | `id: u64, answer: Option<String>, remember: bool, secondary: Option<String>` -> `bool` (false: nobody waits for `id`). `answer: null` = Cancel / Reject. `secondary` = password of a `withPassword` dialog |
| `set_auth_prefs` | command | `useCredentialStore: bool` (setting of the same name, default true) |
| `credentials_clear` | command | -> `u32` entries removed (all credentials DeepGit saved) |

`command` is `git <subcommand>` only (a URL can carry a secret). HTTPS: git asks the user name, then the password. The
`username` prompt has `withPassword: true`: the dialog shows both fields; `answer` = user name, `secondary` = password. The password
prompt that follows (same host and user) is answered from it without a second dialog. If `secondary` is missing, a second `password` prompt is shown.
Prompts are shown one at a time (`state/authQueue.ts`).

**Timeouts.** An unanswered prompt is cancelled after 5 min. While a prompt is open (counter `AuthContext.prompting`), the 120 s
inactivity timeout does not count; the 60 min cap still does.

**Saved credentials** (system key store through the `keyring` crate: Secret Service, Keychain, Credential Manager; service
`DeepGit`). Keys: HTTPS password `https://user@host[/path]` (as git prints it), HTTPS user name `login:https://host`, ssh key passphrase = the key path as ssh
prints it, ssh password `ssh://user@host` (`ssh://user@host:port` when the helper knows a port other than 22), PIN `pin:<label>`.
git prints a user name percent-encoded in the URL (`alice%40example.com`); `Prompt.user` is decoded, the key keeps the text git printed. A host-key answer and an `unknown` prompt are never saved.
- Nothing is saved while the command runs. After exit 0 the credentials the user asked to remember are saved, on a thread of their own: the end of the command waits at most 3 s (`SAVE_WAIT`) for a locked key store, and slowness never marks the store unavailable (only an error it returns does).
- After a failure the saved entries the command used are deleted only on a precise sign tied to a host (`askpass::rejected_keys`): `Authentication failed for '<url>'` and `'<url>': The requested URL returned error: 401|403` (the HTTPS entries of that origin), `HTTP Basic: Access denied` / `Invalid username or password` without a URL (only when the command used one HTTPS origin), ssh's `<user>@<host>: Permission denied (...password...)` (that ssh password). A bare `Permission denied` (a server hook, a local file, a work tree) never deletes anything; neither do key passphrases here.
- One command may ask the same question many times without being rejected: `git fetch --all` (one git per remote) and submodules (one git each) ask for the same login. The command keeps what it answered and answers a repeat the same way; no dialog opens. A repeat counts as a rejection only where one process asks again after a wrong answer, which is ssh (passphrase, password, PIN: up to 3 times in one process): the same `ppid` asking again deletes the saved entry and opens the dialog with `retry: true`. HTTPS questions are never rejections (git fails right after a rejected login). Without a pid (Windows) every ssh repeat counts as a rejection.
- The key store does not work (no Secret Service...): `canRemember` is false, `auth-notice` is sent once, login still works.
- `useCredentialStore` off: nothing is read, saved or offered.
- The names of saved keys (no secrets) are listed in `<app config dir>/credentials.json`, so `credentials_clear` removes exactly those.
- A secret is never logged, never put in an error, never in the `git-console` entry (the answer goes helper -> git on a pipe).

### 5.7 Clone

| command | args | returns |
|---|---|---|
| `clone_repo` | `operationId: String, url: String, parentDir: String, dirName: String, opts: CloneOpts, target: CloneTarget` | `CloneResult` |
| `clone_cancel` | `operationId: String` | `()` (does nothing when that clone has finished; an id that is not running yet is remembered for 60 s, at most 64, and `clone_repo` with it then fails at once with "The operation was cancelled.") |

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
`{ kind: "project", projectId }` rescans that project (the clone folder must be inside its folder and one a scan finds: not deeper than 4 levels, not below `node_modules`, `target`, `dist`, `build`, `.venv` or a dot folder, see `discover::not_found_reason`; this is checked
before the clone starts, and if the rescan still misses the repo the error says where the clone is on disk) and `{ kind: "newProject" }` adds a project whose folder is the clone.
Two clones into the same target folder cannot run together (the second fails before touching anything).
`gitcore::clone::default_dir_name(url)` is the folder name git would pick (`https://h/o/r.git/` -> `r`,
`git@h:o/r.git` -> `r`, `file:///x/r` -> `r`, `/x/r/.git` -> `r`).

### 5.8 Merge conflicts (gitcore/conflicts.rs)
| command | args | returns |
|---|---|---|
| `conflicts` | `repoId` | `Vec<ConflictEntry>` (`git ls-files --unmerged -z`, sorted by path; empty when nothing is unmerged) |
| `conflict_versions` | `repoId, path` | `ConflictVersions` (stages 1, 2, 3 read with `git cat-file --batch`; a missing stage is `None`) |
| `accept_side` (write) | `repoId, paths: Vec<String>, side: ConflictSide` | `()` |
| `save_resolution` (write) | `repoId, path, content: String, expectedOursOid, expectedTheirsOid, expectedBaseOid: Option<String>, resolved: bool` | `()` |

**Yours and Theirs, and the rebase swap.** Git calls stage 2 "ours" and stage 3 "theirs". During a
**rebase** git replays the user's commit on top of the upstream, so stage 2 is the upstream and stage 3 is
the user's commit. Every type and argument of this section speaks the user's language: `ours` is
**Yours** and `theirs` is **Theirs**. `conflicts::side_stages` is the one function that maps them to
stages, per file: yours = 3 and theirs = 2 only for a conflict the rebase itself made (`rebase-merge/` or
`rebase-apply/` without `rebase-apply/applying`, no `MERGE_HEAD` / `CHERRY_PICK_HEAD` / `REVERT_HEAD`, and a
`REBASE_HEAD` whose `<path>` blob is the stage 3 blob, or is not there: a rename); merge, cherry-pick, revert,
`git am`, and a cherry-pick, revert or `stash pop` done while a rebase is stopped: yours = 2, theirs = 3.
(`state::detect` puts `CHERRY_PICK_HEAD` / `REVERT_HEAD` before the rebase directories, so such a repo is
`cherryPicking` / `reverting`.) A stash popped at a conflict stop whose file is identical to the replayed commit's
looks like the rebase's. `ConflictVersions.swapped` tells the UI which case it got; the UI does not map anything.

- `SideStatus` per side, from the stage and the base: present with a base = `modified`, present without =
  `added`, absent with a base = `deleted`, absent without = `missing`. Modify/modify, add/add (no base),
  delete/modify and modify/delete are all this one table.
- Labels: Yours = the branch (`HEAD <short>` when detached); during a rebase `branch (abc1234 subject)` of
  the commit being replayed (`REBASE_HEAD`, `rebase-merge/stopped-sha`, `rebase-apply/original-commit`).
  Theirs = `MERGE_HEAD` as a branch name (else `abc1234 subject`), the cherry-picked / reverted commit
  (`CHERRY_PICK_HEAD`, `REVERT_HEAD`), or the branch the rebase goes onto (`onto`). Without an operation: "Theirs".
- `accept_side`: each path must be conflicted now (else `Invalid`: "<path> is no longer in conflict.").
  A side that has the file (or a symlink): `checkout --ours|--theirs -- paths` (git's own flag, after the swap),
  then `add -A -- paths`. A side that has a submodule (gitlink, mode 160000): `update-index --add --cacheinfo
  160000,<oid>,<path>` from the chosen stage (`checkout` does not move a gitlink and `add` would record the
  checked-out commit); the submodule's worktree is never touched. A side that deleted it: `rm -q -- paths`
  (`--cached` for a submodule). Paths: no NUL or line break (a leading `-` is fine), no `..` or absolute path,
  `--literal-pathspecs` and `--` on every call.
- `save_resolution`: writes `content` (UTF-8, LF line ends) to the worktree file in the file's line ending
  (`eol`: the worktree file, else the first version that has line breaks; CRLF is the majority rule; a file whose
  versions mix CRLF and LF keeps each line's own ending: a line takes the ending it has in Yours, else Theirs, else the
  base, a new line gets LF), never through
  a symlink and never outside the repo, keeping the file mode of an existing file (a new file gets the exec bit
  when an index entry has it). `resolved = true` then runs `git add`; `false` only writes (the file keeps conflict
  markers and stays unmerged; the UI writes the markers). Refused (`Invalid`) when: the path is no longer conflicted;
  `expectedOursOid`, `expectedTheirsOid` or `expectedBaseOid` (the `oid` of the Yours, Theirs and base blobs the
  editor loaded; an omitted or null one means "that version is absent") differs from the index ("The conflict
  changed. Reload the merge."); any version is binary, not UTF-8, over 2 MiB, a symlink or a submodule; the content has a NUL.
  Content is never rebuilt from lossy-decoded text: a non-UTF-8 file only allows `accept_side`.

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
- Conflicts: the conflicts dialog and the merge window open through `actions.openConflicts(repoIds)` and
  `actions.openMerge(repoId, path)`; writes go through `actions.acceptSide` and `actions.saveResolution`.
  The merge logic is the pure model `features/merge/model.ts` (a port of IntelliJ's merge model, vitest-tested).
  The mock has two demo repos: `docs-site` merging (4 files) and `ledger-service` rebasing (2 files, swapped).
- No `any` in exported types. No network requests at runtime.

## 9. Verification

- `cargo test --workspace` (tests create temporary repos with `git init` in `tempfile` dirs; `gitcore/tests/conflicts.rs` covers modify/modify, add/add, delete/modify both ways, binary, non-UTF-8, CRLF, rebase swap, cherry-pick, file mode). `crates/askpass/tests/e2e.rs` runs the real helper against the broker with real `git credential fill` and `ssh-add`; `src-tauri/tests/helper_mode.rs` runs the real app binary as a helper with no display.
- `npx vitest run` (the merge model, the mock backend and the other pure logic).
- `cargo clippy --workspace -- -D warnings`.
- `npm run build` (tsc + vite).
- Browser: `npm run dev` + Playwright screenshots of the main views on the mock backend.
- Desktop: `npm run tauri build -- --no-bundle` and a smoke run on this repo.
