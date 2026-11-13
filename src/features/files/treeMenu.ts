/**
 * The context menu of a row of the Files tree: `Copy path`, `Copy absolute path`, and `Add to .gitignore…`
 * (docs/design/ITERATION-3.md section 11.1). The repo root row of a multi-repo tree has no menu.
 */
import { copyText, openContextMenu, type MenuItem } from "../../components/ui";
import { addToIgnore } from "../../state/actions";
import { ignoreMenuItems } from "../../state/ignoreMenu";
import { repoById } from "../../state/workspace";
import type { TreeNode } from "./model";

/** The path of a folder or file node without a trailing slash. */
const cleanPath = (path: string): string => path.replace(/\/+$/, "");

/** The items of the menu of `node`. Empty for a repo row. */
export function treeMenuItems(node: TreeNode): MenuItem[] {
  if (node.kind === "repo") return [];
  const path = cleanPath(node.path);
  const root = repoById(node.repoId)?.path ?? "";
  return [
    { label: "Copy path", icon: "copy", onSelect: () => void copyText(path) },
    { label: "Copy absolute path", icon: "path", onSelect: () => void copyText(`${root}/${path}`) },
    ...ignoreMenuItems([{ repoId: node.repoId, path, isDir: node.kind === "dir" }], addToIgnore),
  ];
}

/** Opens the menu of `node` at the pointer. */
export function openTreeMenu(node: TreeNode, e: MouseEvent): void {
  openContextMenu(e, treeMenuItems(node));
}
