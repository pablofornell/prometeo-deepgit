/**
 * Which repos have a write operation running right now. `actions.ts` marks a repo for the duration of each call;
 * the auto-fetch reads it to stay out of the way (`isRepoBusy`).
 */
const counts = new Map<string, number>();

/** Marks the repo as busy; call the returned function when the operation ends. */
export function beginRepoOp(repoId: string): () => void {
  counts.set(repoId, (counts.get(repoId) ?? 0) + 1);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const n = (counts.get(repoId) ?? 1) - 1;
    if (n <= 0) counts.delete(repoId);
    else counts.set(repoId, n);
  };
}

/** True while an action runs in this repo (not reactive: a scheduler asks at the moment it decides). */
export const isRepoBusy = (repoId: string): boolean => (counts.get(repoId) ?? 0) > 0;
