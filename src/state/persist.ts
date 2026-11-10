/**
 * localStorage helpers. Every key is stored as JSON under the prefix `deepgit.ui.`
 * (`deepgit.ui.theme`, `deepgit.ui.split.sidebar`, ...). Failures (private mode, quota) are ignored.
 */
const PREFIX = "deepgit.ui.";

/** Reads `deepgit.ui.<key>`; returns `fallback` when missing or unparsable. */
export function loadPersisted<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

/** Writes `deepgit.ui.<key>`. */
export function savePersisted<T>(key: string, value: T): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

/** Deletes `deepgit.ui.<key>` (the setting falls back to its default). */
export function removePersisted(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
}
