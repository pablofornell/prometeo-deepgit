//! Cached log sessions: the merged commit rows stay in memory and the UI fetches visible ranges.

use std::sync::Arc;

use gitcore::{CommitRow, LogSessionInfo, SkippedRepo};

/// Most sessions kept at once.
pub const MAX_SESSIONS: usize = 4;

pub struct Session {
    pub rows: Vec<CommitRow>,
}

impl Session {
    /// Rows `start..start+count`, clamped to the available rows.
    pub fn range(&self, start: u32, count: u32) -> Vec<CommitRow> {
        let len = self.rows.len();
        let start = (start as usize).min(len);
        let end = start.saturating_add(count as usize).min(len);
        self.rows[start..end].to_vec()
    }

    /// Index of the first row whose oid starts with `prefix` (case-insensitive), only among the
    /// rows of `repo_id` when given.
    pub fn find(&self, prefix: &str, repo_id: Option<&str>) -> Option<u32> {
        let p = prefix.trim().to_ascii_lowercase();
        if p.is_empty() {
            return None;
        }
        self.rows
            .iter()
            .position(|r| {
                repo_id.is_none_or(|id| r.repo_id == id)
                    && r.oid.to_ascii_lowercase().starts_with(&p)
            })
            .map(|i| i as u32)
    }
}

/// Sessions ordered from least to most recently used.
pub struct LogSessions {
    next_id: u64,
    max: usize,
    items: Vec<(u64, Arc<Session>)>,
}

impl Default for LogSessions {
    fn default() -> Self {
        Self::new(MAX_SESSIONS)
    }
}

impl LogSessions {
    pub fn new(max: usize) -> Self {
        LogSessions {
            next_id: 1,
            max: max.max(1),
            items: Vec::new(),
        }
    }

    /// Stores a session, evicting the least recently used one when full.
    pub fn open(
        &mut self,
        rows: Vec<CommitRow>,
        max_lanes: u16,
        truncated: bool,
        skipped: Vec<SkippedRepo>,
    ) -> LogSessionInfo {
        let id = self.next_id;
        self.next_id += 1;
        let total = rows.len() as u32;
        while self.items.len() >= self.max {
            self.items.remove(0);
        }
        self.items.push((id, Arc::new(Session { rows })));
        LogSessionInfo {
            session_id: id,
            total,
            max_lanes,
            truncated,
            skipped,
        }
    }

    /// Looks a session up and marks it as most recently used.
    pub fn get(&mut self, id: u64) -> Option<Arc<Session>> {
        let pos = self.items.iter().position(|(i, _)| *i == id)?;
        let item = self.items.remove(pos);
        let session = item.1.clone();
        self.items.push(item);
        Some(session)
    }

    pub fn close(&mut self, id: u64) {
        self.items.retain(|(i, _)| *i != id);
    }

    #[cfg(test)]
    fn ids(&self) -> Vec<u64> {
        self.items.iter().map(|(i, _)| *i).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gitcore::GraphRow;

    fn row(oid: &str) -> CommitRow {
        CommitRow {
            repo_id: "r".into(),
            oid: oid.into(),
            parents: vec![],
            author_name: String::new(),
            author_email: String::new(),
            author_time: 0,
            committer_time: 0,
            subject: String::new(),
            refs: vec![],
            graph: GraphRow {
                node: 0,
                color: 0,
                segments: vec![],
                width: 1,
            },
        }
    }

    fn rows(n: usize) -> Vec<CommitRow> {
        (0..n).map(|i| row(&format!("{i:040x}"))).collect()
    }

    #[test]
    fn ids_increase_and_info_matches() {
        let mut s = LogSessions::new(4);
        let a = s.open(rows(3), 2, true, vec![]);
        let b = s.open(rows(5), 7, false, vec![]);
        assert_eq!(
            (a.session_id, a.total, a.max_lanes, a.truncated),
            (1, 3, 2, true)
        );
        assert_eq!(
            (b.session_id, b.total, b.max_lanes, b.truncated),
            (2, 5, 7, false)
        );
    }

    #[test]
    fn oldest_session_is_evicted() {
        let mut s = LogSessions::new(4);
        for _ in 0..5 {
            s.open(rows(1), 1, false, vec![]);
        }
        assert_eq!(s.ids(), vec![2, 3, 4, 5]);
        assert!(s.get(1).is_none());
    }

    #[test]
    fn using_a_session_protects_it_from_eviction() {
        let mut s = LogSessions::new(4);
        for _ in 0..4 {
            s.open(rows(1), 1, false, vec![]);
        }
        assert!(s.get(1).is_some());
        s.open(rows(1), 1, false, vec![]);
        assert_eq!(s.ids(), vec![3, 4, 1, 5]);
        assert!(s.get(2).is_none());
    }

    #[test]
    fn close_removes_and_default_cap_is_four() {
        let mut s = LogSessions::default();
        let a = s.open(rows(1), 1, false, vec![]);
        s.close(a.session_id);
        s.close(999);
        assert!(s.get(a.session_id).is_none());
        for _ in 0..10 {
            s.open(rows(1), 1, false, vec![]);
        }
        assert_eq!(s.ids().len(), MAX_SESSIONS);
    }

    #[test]
    fn range_is_clamped() {
        let mut s = LogSessions::new(4);
        let id = s.open(rows(10), 1, false, vec![]).session_id;
        let sess = s.get(id).unwrap();
        assert_eq!(sess.range(0, 3).len(), 3);
        assert_eq!(sess.range(8, 5).len(), 2);
        assert_eq!(sess.range(10, 5).len(), 0);
        assert_eq!(sess.range(500, 5).len(), 0);
        assert_eq!(sess.range(2, u32::MAX).len(), 8);
        assert_eq!(sess.range(0, 0).len(), 0);
        assert_eq!(sess.range(4, 2)[0].oid, format!("{:040x}", 4));
    }

    #[test]
    fn find_matches_first_oid_prefix() {
        let sess = Session {
            rows: vec![row("abc123"), row("abd999"), row("abc456")],
        };
        assert_eq!(sess.find("abc", None), Some(0));
        assert_eq!(sess.find("ABD9", None), Some(1));
        assert_eq!(sess.find("abc4", None), Some(2));
        assert_eq!(sess.find("zzz", None), None);
        assert_eq!(sess.find("", None), None);
    }

    #[test]
    fn find_can_be_limited_to_one_repo() {
        let mut other = row("abc777");
        other.repo_id = "r2".into();
        let sess = Session {
            rows: vec![row("abc123"), other, row("abc456")],
        };
        assert_eq!(sess.find("abc", None), Some(0));
        assert_eq!(sess.find("abc", Some("r2")), Some(1));
        assert_eq!(sess.find("abc", Some("r")), Some(0));
        assert_eq!(sess.find("abc7", Some("r")), None);
        assert_eq!(sess.find("abc", Some("nope")), None);
    }

    #[test]
    fn open_keeps_skipped_repos() {
        let mut s = LogSessions::new(4);
        let skipped = vec![SkippedRepo {
            repo_id: "gone".into(),
            message: "not a git repository".into(),
        }];
        let info = s.open(rows(1), 1, false, skipped.clone());
        assert_eq!(info.skipped, skipped);
        assert!(s.open(rows(1), 1, false, vec![]).skipped.is_empty());
    }
}
