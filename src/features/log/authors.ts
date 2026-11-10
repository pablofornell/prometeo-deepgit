/**
 * Authors seen in the log of the current project. The pool only grows while the project is open, so the author
 * popup keeps listing everybody even when the Author filter has reduced the log to one person.
 */
import { createSignal } from "solid-js";
import type { AuthorInfo } from "./scan";

const [pool, setPool] = createSignal<AuthorInfo[]>([]);
const byEmail = new Map<string, AuthorInfo>();

/** Authors sorted by number of commits seen (largest first). */
export const knownAuthors = pool;

export function mergeAuthors(authors: ReadonlyMap<string, AuthorInfo>): void {
  if (authors.size === 0) return;
  let changed = false;
  for (const [email, a] of authors) {
    const cur = byEmail.get(email);
    if (!cur || cur.count < a.count) {
      byEmail.set(email, { ...a });
      changed = true;
    }
  }
  if (changed) setPool([...byEmail.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)));
}

export function resetAuthors(): void {
  byEmail.clear();
  setPool([]);
}
