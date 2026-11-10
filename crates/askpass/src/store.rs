//! Saved credentials. The system key store (Secret Service, Keychain, Credential Manager) sits
//! behind `SecretBackend`; the app implements it with the `keyring` crate and the tests with
//! `MemoryBackend`. `IndexedStore` adds the list of the keys DeepGit saved, so "forget all" can
//! remove exactly those (the key store itself cannot be searched by every backend).

use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::Mutex;

/// An error never carries a secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    /// No usable key store (no Secret Service on a headless Linux, locked and refused...).
    Unavailable(String),
    Failed(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Unavailable(m) => write!(f, "key store unavailable: {m}"),
            StoreError::Failed(m) => write!(f, "key store error: {m}"),
        }
    }
}

impl std::error::Error for StoreError {}

/// One secret per key. A missing entry is `Ok(None)` for `get` and `Ok(())` for `delete`.
pub trait SecretBackend: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<String>, StoreError>;
    fn set(&self, key: &str, secret: &str) -> Result<(), StoreError>;
    fn delete(&self, key: &str) -> Result<(), StoreError>;
}

/// What the broker needs.
pub trait CredentialStore: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<String>, StoreError>;
    fn set(&self, key: &str, secret: &str) -> Result<(), StoreError>;
    fn delete(&self, key: &str) -> Result<(), StoreError>;
    /// `Ok` when the store works at all (a lookup of a key that does not exist).
    fn probe(&self) -> Result<(), StoreError>;
    /// Forgets every credential DeepGit saved. Returns how many were removed.
    fn clear_all(&self) -> Result<usize, StoreError>;
}

/// A backend plus the persisted list of the keys that were saved through it.
pub struct IndexedStore<B: SecretBackend> {
    backend: B,
    index_path: Option<PathBuf>,
    keys: Mutex<BTreeSet<String>>,
}

impl<B: SecretBackend> IndexedStore<B> {
    /// `index_path`: a JSON file with the key names (no secrets). `None` keeps the list in memory.
    pub fn new(backend: B, index_path: Option<PathBuf>) -> Self {
        let keys = index_path
            .as_deref()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|b| serde_json::from_slice::<Vec<String>>(&b).ok())
            .unwrap_or_default()
            .into_iter()
            .collect();
        IndexedStore {
            backend,
            index_path,
            keys: Mutex::new(keys),
        }
    }

    /// The keys DeepGit saved.
    pub fn keys(&self) -> Vec<String> {
        self.lock().iter().cloned().collect()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeSet<String>> {
        self.keys.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn persist(&self, keys: &BTreeSet<String>) {
        let Some(path) = &self.index_path else {
            return;
        };
        let Ok(json) = serde_json::to_vec_pretty(&keys.iter().collect::<Vec<_>>()) else {
            return;
        };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }
}

impl<B: SecretBackend> CredentialStore for IndexedStore<B> {
    fn get(&self, key: &str) -> Result<Option<String>, StoreError> {
        self.backend.get(key)
    }

    fn set(&self, key: &str, secret: &str) -> Result<(), StoreError> {
        self.backend.set(key, secret)?;
        let mut keys = self.lock();
        if keys.insert(key.to_string()) {
            self.persist(&keys);
        }
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<(), StoreError> {
        self.backend.delete(key)?;
        let mut keys = self.lock();
        if keys.remove(key) {
            self.persist(&keys);
        }
        Ok(())
    }

    fn probe(&self) -> Result<(), StoreError> {
        self.backend.get("deepgit-probe").map(|_| ())
    }

    fn clear_all(&self) -> Result<usize, StoreError> {
        let mut keys = self.lock();
        let mut removed = 0;
        let mut first_error = None;
        for key in keys.clone() {
            match self.backend.delete(&key) {
                Ok(()) => {
                    keys.remove(&key);
                    removed += 1;
                }
                Err(e) => {
                    first_error.get_or_insert(e);
                }
            }
        }
        self.persist(&keys);
        match first_error {
            Some(e) if removed == 0 => Err(e),
            _ => Ok(removed),
        }
    }
}

/// Secrets in memory: tests, and the fallback when no key store exists.
#[derive(Default)]
pub struct MemoryBackend {
    map: Mutex<HashMap<String, String>>,
    /// Makes every call fail like a missing Secret Service.
    unavailable: bool,
}

impl MemoryBackend {
    pub fn new() -> Self {
        Self::default()
    }

    /// A backend whose every call fails with `StoreError::Unavailable`.
    pub fn unavailable() -> Self {
        MemoryBackend {
            unavailable: true,
            ..Default::default()
        }
    }

    fn map(&self) -> Result<std::sync::MutexGuard<'_, HashMap<String, String>>, StoreError> {
        if self.unavailable {
            return Err(StoreError::Unavailable("no key store".into()));
        }
        Ok(self.map.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

impl SecretBackend for MemoryBackend {
    fn get(&self, key: &str) -> Result<Option<String>, StoreError> {
        Ok(self.map()?.get(key).cloned())
    }

    fn set(&self, key: &str, secret: &str) -> Result<(), StoreError> {
        self.map()?.insert(key.to_string(), secret.to_string());
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<(), StoreError> {
        self.map()?.remove(key);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_keys_are_listed_and_forgotten() {
        let dir = tempfile::tempdir().unwrap();
        let index = dir.path().join("credentials.json");
        let store = IndexedStore::new(MemoryBackend::new(), Some(index.clone()));
        store.set("https://a@h", "pw1").unwrap();
        store.set("/k/id", "pw2").unwrap();
        assert_eq!(store.get("https://a@h").unwrap().as_deref(), Some("pw1"));
        // the index file holds the key names, never a secret
        let text = std::fs::read_to_string(&index).unwrap();
        assert!(text.contains("https://a@h") && text.contains("/k/id"));
        assert!(!text.contains("pw1") && !text.contains("pw2"));
        // a new store reads the index back
        let again = IndexedStore::new(MemoryBackend::new(), Some(index.clone()));
        assert_eq!(again.keys(), vec!["/k/id", "https://a@h"]);
        assert_eq!(store.clear_all().unwrap(), 2);
        assert_eq!(store.get("https://a@h").unwrap(), None);
        assert_eq!(std::fs::read_to_string(&index).unwrap().trim(), "[]");
    }

    #[test]
    fn deleting_one_key_updates_the_index() {
        let store = IndexedStore::new(MemoryBackend::new(), None);
        store.set("a", "1").unwrap();
        store.delete("a").unwrap();
        store.delete("never-saved").unwrap();
        assert!(store.keys().is_empty());
    }

    #[test]
    fn an_unavailable_backend_reports_it_and_keeps_the_index_clean() {
        let store = IndexedStore::new(MemoryBackend::unavailable(), None);
        assert!(matches!(store.probe(), Err(StoreError::Unavailable(_))));
        assert!(store.set("a", "1").is_err());
        assert!(store.keys().is_empty());
    }
}
