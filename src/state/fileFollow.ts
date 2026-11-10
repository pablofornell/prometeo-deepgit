/**
 * Which file the "File changes" tab shows after the selected commit changed (README contract, "Right column").
 * Pure, so it is tested without the UI.
 */
import type { SelectedFile } from "./selection";

export interface CommitFiles {
  repoId: string;
  oid: string;
  parents: readonly string[];
  files: readonly { path: string; oldPath?: string | null }[];
}

/**
 * The open commit file `f` stays open when the new commit `d` changes the same path in the same repository: it is
 * re-pointed to `d` (against the first parent, or parent `parentIdx`). Otherwise (also for a Local changes file) the result is `null`: the caller
 * returns to "Changed files" (and drops a commit file). A file that already belongs to `d` is returned as it is.
 */
export function followFile(f: SelectedFile | null, d: CommitFiles, parentIdx = 0): SelectedFile | null {
  if (!f || f.spec.kind !== "commit" || f.repoId !== d.repoId) return null;
  if (f.spec.oid === d.oid) return f;
  const change = d.files.find((x) => x.path === f.path);
  if (!change) return null;
  return {
    repoId: d.repoId,
    spec: { kind: "commit", oid: d.oid, parent: parentIdx === 0 ? null : d.parents[parentIdx] ?? null },
    path: change.path,
    oldPath: change.oldPath ?? undefined,
  };
}
