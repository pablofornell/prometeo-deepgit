/** Log visibility of the repos below a folder row of the sidebar (ITERATION-3 1.4, 1.5). */
import { projectRepos, selectedRepoIds, setSelectedRepoIds } from "../../state/workspace";

/** True when every repo in `repoIds` is hidden from the log. */
export const allHidden = (repoIds: readonly string[]): boolean => {
  const shown = selectedRepoIds();
  return repoIds.every((id) => !shown.includes(id));
};

/** True when hiding `repoIds` would leave the log without a repo (the filter keeps at least one). */
export const wouldHideAll = (repoIds: readonly string[]): boolean => selectedRepoIds().every((id) => repoIds.includes(id));

/** Shows only the repos of the folder in the log. */
export function showOnly(repoIds: readonly string[]): void {
  setSelectedRepoIds(projectRepos().map((r) => r.id).filter((id) => repoIds.includes(id)));
}

/** Hides the repos of the folder from the log. Does nothing when no repo would stay. */
export function hideFolder(repoIds: readonly string[]): void {
  if (wouldHideAll(repoIds)) return;
  setSelectedRepoIds(selectedRepoIds().filter((id) => !repoIds.includes(id)));
}

/** Icon click: all shown -> hide them; some or none shown -> show them all. */
export function toggleFolder(repoIds: readonly string[]): void {
  const shown = selectedRepoIds();
  if (repoIds.every((id) => shown.includes(id))) hideFolder(repoIds);
  else setSelectedRepoIds(projectRepos().map((r) => r.id).filter((id) => shown.includes(id) || repoIds.includes(id)));
}
