/**
 * Index and worktree operations of the Local changes view on groups of files. Everything goes through
 * `state/actions` (toasts, conflict handling, refresh); these helpers only group the files by repo.
 */
import { plural, toast } from "../../components/ui";
import * as actions from "../../state/actions";
import { confirmAction } from "../../state/dialogs";
import { repoById } from "../../state/workspace";
import { groupByRepo, type FileItem } from "./model";

/** Paths git needs to touch for a file: a rename also affects its old path when it is unstaged. */
const pathsOf = (items: readonly FileItem[], withOld: boolean): string[] => {
  const out = new Set<string>();
  for (const { file } of items) {
    out.add(file.path);
    if (withOld && file.status === "renamed" && file.oldPath) out.add(file.oldPath);
  }
  return [...out];
};

/** True when every item is already staged. */
export const allStaged = (items: readonly FileItem[]): boolean => items.length > 0 && items.every((i) => i.section === "staged");

/** Items that Discard can act on: unstaged and untracked files (git restores the worktree only). */
export const discardable = (items: readonly FileItem[]): FileItem[] => items.filter((i) => i.section === "unstaged");

/** Stages the unstaged / conflicted files (a conflicted file is marked resolved). */
export async function stageItems(items: readonly FileItem[]): Promise<void> {
  const todo = items.filter((i) => i.section !== "staged");
  await Promise.all([...groupByRepo(todo)].map(([repoId, list]) => actions.stage(repoId, pathsOf(list, false))));
}

/** Unstages the staged files. */
export async function unstageItems(items: readonly FileItem[]): Promise<void> {
  const todo = items.filter((i) => i.section === "staged");
  await Promise.all([...groupByRepo(todo)].map(([repoId, list]) => actions.unstage(repoId, pathsOf(list, true))));
}

/** Space: stages when anything is not staged yet, otherwise unstages. */
export function toggleStage(items: readonly FileItem[]): Promise<void> {
  return allStaged(items) ? unstageItems(items) : stageItems(items);
}

/**
 * Discards the worktree changes of the unstaged files after a confirmation. One repo: the confirmation of
 * `actions.discard`. Several repos: one confirmation for all.
 */
export async function discardItems(items: readonly FileItem[]): Promise<void> {
  const todo = discardable(items);
  if (todo.length === 0) {
    toast({ kind: "info", title: "Nothing to discard", body: "Staged files and conflicts are not discarded here. Unstage the files first." });
    return;
  }
  const groups = groupByRepo(todo);
  const untracked = (list: FileItem[]) => list.filter((i) => i.file.status === "untracked").length;
  if (groups.size === 1) {
    const [[repoId, list]] = [...groups];
    await actions.discard(repoId, pathsOf(list, false), { untracked: untracked(list) });
    return;
  }
  const names = [...groups.keys()].map((id) => repoById(id)?.name ?? id);
  const r = await confirmAction({
    title: "Discard changes",
    message: [
      `Discard changes in ${plural(todo.length, "file")} of ${plural(groups.size, "repository", "repositories")}: ${names.join(", ")}?`,
      ...(untracked(todo) ? [`${plural(untracked(todo), "untracked file")} will be deleted.`] : []),
      "This cannot be undone.",
    ],
    confirmLabel: `Discard ${plural(todo.length, "file")}`,
    danger: true,
  });
  if (!r) return;
  await Promise.all([...groups].map(([repoId, list]) => actions.discard(repoId, pathsOf(list, false), { confirm: false, untracked: untracked(list) })));
}
