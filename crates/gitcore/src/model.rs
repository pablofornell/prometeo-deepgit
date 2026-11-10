//! All serde types of PLAN.md section 4. JSON is camelCase; enums with data are tagged by `kind`.

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub color: u8,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub repos: Vec<RepoInfo>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub projects: Vec<Project>,
    pub active_project_id: Option<String>,
    /// Opaque UI state the frontend saves.
    #[serde(default)]
    pub ui: serde_json::Value,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum RepoStateKind {
    #[default]
    Clean,
    Merging,
    Rebasing,
    CherryPicking,
    Reverting,
    Bisecting,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RepoSummary {
    pub repo_id: String,
    /// `None` when detached.
    pub branch: Option<String>,
    /// `None` in an empty repo.
    pub head_oid: Option<String>,
    /// e.g. "origin/main".
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub staged: u32,
    pub unstaged: u32,
    pub untracked: u32,
    pub conflicted: u32,
    pub state: RepoStateKind,
    pub stash_count: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LocalBranch {
    pub name: String,
    pub oid: String,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub is_head: bool,
    /// Upstream deleted.
    pub gone: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBranch {
    pub remote: String,
    /// "main"
    pub name: String,
    /// "origin/main"
    pub full_name: String,
    pub oid: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub name: String,
    /// Peeled commit.
    pub oid: String,
    pub annotated: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Stash {
    pub index: u32,
    pub message: String,
    pub oid: String,
    pub time: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    pub name: String,
    pub url: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Submodule {
    pub path: String,
    pub oid: String,
    /// ' ', '+', '-' or 'U'.
    pub status: char,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Refs {
    pub local: Vec<LocalBranch>,
    pub remote: Vec<RemoteBranch>,
    pub tags: Vec<Tag>,
    pub stashes: Vec<Stash>,
    pub remotes: Vec<Remote>,
    pub submodules: Vec<Submodule>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RefKind {
    Head,
    Local,
    Remote,
    Tag,
    Stash,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RefLabel {
    pub kind: RefKind,
    pub name: String,
    pub is_current: bool,
}

/// y: 0 = top edge of row, 1 = row middle (node centre), 2 = bottom edge of row.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GraphSegment {
    pub x1: u16,
    pub y1: u8,
    pub x2: u16,
    pub y2: u8,
    pub color: u16,
}

/// `width` = number of lanes used in this row (max column index + 1).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GraphRow {
    pub node: u16,
    pub color: u16,
    pub segments: Vec<GraphSegment>,
    pub width: u16,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommitRow {
    pub repo_id: String,
    pub oid: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub author_time: i64,
    pub committer_time: i64,
    pub subject: String,
    pub refs: Vec<RefLabel>,
    pub graph: GraphRow,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct LogQuery {
    /// 1 or more repos of the active project.
    pub repo_ids: Vec<String>,
    /// Empty = --branches --remotes --tags HEAD.
    pub refs: Vec<String>,
    pub text: Option<String>,
    pub author: Option<String>,
    pub path: Option<String>,
    pub since: Option<i64>,
    pub until: Option<i64>,
    /// Per repo. 0 means the default of 50_000.
    pub max_count: u32,
}

pub const DEFAULT_MAX_COUNT: u32 = 50_000;

impl Default for LogQuery {
    fn default() -> Self {
        LogQuery {
            repo_ids: Vec::new(),
            refs: Vec::new(),
            text: None,
            author: None,
            path: None,
            since: None,
            until: None,
            max_count: DEFAULT_MAX_COUNT,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LogSessionInfo {
    pub session_id: u64,
    pub total: u32,
    pub max_lanes: u16,
    pub truncated: bool,
    /// Repos that could not be loaded (folder gone, git error); the others are in the log.
    #[serde(default)]
    pub skipped: Vec<SkippedRepo>,
}

/// A repo left out of a combined log because loading it failed.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkippedRepo {
    pub repo_id: String,
    pub message: String,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Untracked,
    Conflicted,
    Ignored,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub old_path: Option<String>,
    pub status: FileStatus,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
    pub binary: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub name: String,
    pub email: String,
    pub time: i64,
    /// "+0100"
    pub tz: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    pub repo_id: String,
    pub oid: String,
    pub parents: Vec<String>,
    pub author: Person,
    pub committer: Person,
    pub subject: String,
    pub body: String,
    pub refs: Vec<RefLabel>,
    /// Versus the first parent; a root commit versus the empty tree.
    pub files: Vec<FileChange>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WorkingTree {
    pub repo_id: String,
    pub staged: Vec<FileChange>,
    /// Untracked files are here with status `Untracked`.
    pub unstaged: Vec<FileChange>,
    pub conflicted: Vec<FileChange>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DiffSpec {
    /// `parent: None` = first parent.
    Commit { oid: String, parent: Option<String> },
    /// Index vs HEAD.
    Staged,
    /// Worktree vs index; untracked = whole file added.
    Unstaged,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LineKind {
    Context,
    Add,
    Del,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: LineKind,
    pub old_no: Option<u32>,
    pub new_no: Option<u32>,
    pub text: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    /// Text after the second `@@`.
    pub header: String,
    pub lines: Vec<DiffLine>,
}

/// Identity of a hunk: the four numbers of its `@@ -a,b +c,d @@` header and, when sent, a hash
/// of its body (`hunk_hash`) so an edit that keeps the header is noticed too.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HunkRef {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
}

impl HunkRef {
    /// The four header numbers, whatever the hash.
    pub fn same_header(&self, other: &HunkRef) -> bool {
        (
            self.old_start,
            self.old_lines,
            self.new_start,
            self.new_lines,
        ) == (
            other.old_start,
            other.old_lines,
            other.new_start,
            other.new_lines,
        )
    }
}

impl Hunk {
    /// Header numbers plus the body hash.
    pub fn hunk_ref(&self) -> HunkRef {
        HunkRef {
            old_start: self.old_start,
            old_lines: self.old_lines,
            new_start: self.new_start,
            new_lines: self.new_lines,
            hash: Some(hunk_hash(self)),
        }
    }
}

/// FNV-1a (32 bit) over the UTF-8 bytes of, for each line of the hunk in order, one kind char
/// (`' '` context, `'+'` add, `'-'` del), the line text and `"\n"`; 8 lowercase hex digits. The
/// frontend computes the same from the `Hunk` it shows.
pub fn hunk_hash(h: &Hunk) -> String {
    let mut hash: u32 = 0x811c_9dc5;
    let mut feed = |byte: u8| {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(0x0100_0193);
    };
    for line in &h.lines {
        feed(match line.kind {
            LineKind::Context => b' ',
            LineKind::Add => b'+',
            LineKind::Del => b'-',
        });
        line.text.bytes().for_each(&mut feed);
        feed(b'\n');
    }
    format!("{hash:08x}")
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub binary: bool,
    pub hunks: Vec<Hunk>,
    /// More than 20_000 diff lines: `hunks` is empty.
    pub too_large: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleEntry {
    pub id: u64,
    pub repo_id: Option<String>,
    pub args: Vec<String>,
    /// Unix ms.
    pub started_at: i64,
    pub duration_ms: u64,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RepoChanged {
    pub repo_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpResult {
    pub ok: bool,
    /// git stdout+stderr summary.
    pub message: String,
    pub conflicts: bool,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ResetMode {
    Soft,
    Mixed,
    Hard,
    Keep,
}

/// Error sent to the frontend.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    pub message: String,
    /// stderr
    pub detail: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(kind: LineKind, text: &str) -> DiffLine {
        DiffLine {
            kind,
            old_no: None,
            new_no: None,
            text: text.to_string(),
        }
    }

    /// Test vector shared with the TypeScript implementation (computed independently in Python).
    #[test]
    fn hunk_hash_matches_the_shared_test_vector() {
        let h = Hunk {
            old_start: 1,
            old_lines: 2,
            new_start: 1,
            new_lines: 3,
            header: String::new(),
            lines: vec![
                line(LineKind::Context, "fn main() {"),
                line(LineKind::Del, "    old \u{e9}"),
                line(LineKind::Add, "    new"),
                line(LineKind::Add, ""),
                line(LineKind::Context, "}"),
            ],
        };
        // " fn main() {\n-    old é\n+    new\n+\n }\n"
        assert_eq!(hunk_hash(&h), "107351ed");
        assert_eq!(h.hunk_ref().hash.as_deref(), Some("107351ed"));
        let empty = Hunk { lines: vec![], ..h };
        assert_eq!(hunk_hash(&empty), "811c9dc5");
    }
}
