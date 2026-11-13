/**
 * The "Add to .gitignore…" item of the context menus (docs/design/ITERATION-3.md section 11.1). The Local changes list and
 * the Files tree both use it. Each one lists the rows that the menu applies to.
 */
import type { MenuItem } from "../components/ui";

/** A file or a folder row. `path` is relative to the repo. A repo root row has an empty path. */
export interface IgnoreRef {
  repoId: string;
  path: string;
  isDir: boolean;
}

/** Opens the dialog for the items of one repo (`actions.addToIgnore`). */
export type OpenIgnore = (repoId: string, items: { path: string; isDir: boolean }[]) => Promise<void> | void;

/** The refs the item can apply to: not a repo root, not a `.gitignore` file. */
export function ignorable(refs: readonly IgnoreRef[]): IgnoreRef[] {
  return refs.filter((r) => r.path.replace(/^\/+|\/+$/g, "") !== "" && (r.isDir || r.path.split("/").pop() !== ".gitignore"));
}

/**
 * The separator and the item, to add after `Copy absolute path`. Gives no items when nothing applies. The item is
 * disabled for rows of different repositories. `open` opens the dialog (`actions.addToIgnore`). It is a parameter so this
 * module does not load the UI, and a test can use a stand-in.
 */
export function ignoreMenuItems(refs: readonly IgnoreRef[], open: OpenIgnore): MenuItem[] {
  const list = ignorable(refs);
  if (list.length === 0) return [];
  const repoIds = new Set(list.map((r) => r.repoId));
  const one = repoIds.size === 1;
  return [
    { separator: true },
    {
      label: list.length > 1 ? `Add ${list.length} files to .gitignore…` : "Add to .gitignore…",
      disabled: !one,
      tooltip: one ? undefined : "Select files of one repository.",
      onSelect: () => void open(list[0].repoId, list.map((r) => ({ path: r.path, isDir: r.isDir }))),
    },
  ];
}
