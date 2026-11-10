/** Context menus of the sidebar tree (DESIGN.md 5.3, 5.11). Every item names the exact branches it acts on. */
import { copyText, plural, type MenuItem } from "../../components/ui";
import * as actions from "../../state/actions";
import { repoColorMenu } from "../../state/colorActions";
import { branchColumn } from "../../state/branchTable";
import { setChangesRepoId, setMainTab } from "../../state/selection";
import { isRepoFilterActive, projectRepos, repoById, selectAllRepos, selectOnlyRepo, selectedRepoIds, summary, toggleRepo } from "../../state/workspace";
import type { SidebarNode } from "./nodes";
import { stateLabel } from "./nodes";

type Node<K extends SidebarNode["kind"]> = Extract<SidebarNode, { kind: K }>;

const currentOf = (repoId: string): string | null => summary(repoId)?.branch ?? null;

/** "Checkout X in all repos that have it" (multi-repo only). */
function inAllRepos(name: string): MenuItem[] {
  if (projectRepos().length < 2) return [];
  const col = branchColumn(name);
  const ids = col ? projectRepos().filter((r) => col.cells[r.id]?.state !== "missing").map((r) => r.id) : [];
  if (ids.length < 2) return [];
  return [
    { separator: true },
    { label: `Checkout ${name} in all ${ids.length} repos that have it`, icon: "matrix", onSelect: () => void actions.checkout(ids, name, { branchOnly: true }) },
    { label: `New branch from ${name} in ${plural(ids.length, "repo")}…`, icon: "newBranch", onSelect: () => void actions.createBranch(ids, name, { startLabel: name }) },
  ];
}

function repoMenu(n: Node<"repo">): MenuItem[] {
  const id = n.repoId;
  const repo = repoById(id);
  const s = summary(id);
  const shown = selectedRepoIds().includes(id);
  const items: MenuItem[] = [];
  if (projectRepos().length > 1) {
    items.push(
      { label: "Show only this repository in the log", icon: "log", onSelect: () => selectOnlyRepo(id) },
      { label: shown ? "Hide from the log" : "Show in the log", icon: "eye", disabled: shown && selectedRepoIds().length === 1, onSelect: () => toggleRepo(id) },
      { label: "Show all repositories", disabled: !isRepoFilterActive(), onSelect: selectAllRepos },
      { separator: true },
    );
  }
  const op = s ? stateLabel(s.state) : null;
  if (op) {
    items.push(
      { label: `Continue ${op}`, icon: "arrowRight", onSelect: () => void actions.opContinue(id) },
      { label: `Abort ${op}`, icon: "close", danger: true, onSelect: () => void actions.opAbort(id) },
      { separator: true },
    );
  }
  items.push(
    { label: "Fetch", icon: "fetch", onSelect: () => void actions.fetch(id) },
    { label: "Pull", icon: "pull", onSelect: () => void actions.pull(id) },
    { label: "Push…", icon: "push", onSelect: () => void actions.push(id) },
    { separator: true },
    { label: "New branch…", icon: "newBranch", onSelect: () => void actions.createBranch([id], "HEAD", { startLabel: `${repo?.name ?? id} @ HEAD` }) },
    { label: "Stash changes…", icon: "stashPush", onSelect: () => void actions.stashSave([id]) },
    { label: "Show local changes", icon: "changes", onSelect: () => { setChangesRepoId(id); setMainTab("changes"); } },
    { separator: true },
    ...(repo ? [repoColorMenu(repo)] : []),
    { label: "Copy path", icon: "copy", onSelect: () => void copyText(repo?.path ?? "") },
  );
  return items;
}

function localBranchMenu(n: Node<"branch">): MenuItem[] {
  const { repoId, branch } = n;
  const x = branch.name;
  const cur = currentOf(repoId);
  const isCurrent = branch.isHead;
  const curLabel = cur ?? "HEAD";
  return [
    { label: `Checkout ${x}`, icon: "checkout", disabled: isCurrent, onSelect: () => void actions.checkout(repoId, x) },
    { label: `New branch from ${x}…`, icon: "newBranch", onSelect: () => void actions.createBranch([repoId], x, { startLabel: x }) },
    {
      label: `Checkout ${x} and rebase onto ${curLabel}`,
      icon: "rebase",
      disabled: isCurrent || !cur,
      onSelect: async () => {
        const r = await actions.checkout(repoId, x);
        if (r.ok.length > 0 && cur) void actions.rebase(repoId, cur);
      },
    },
    { separator: true },
    { label: `Merge ${x} into ${curLabel}`, icon: "merge", disabled: isCurrent, onSelect: () => void actions.merge([repoId], x) },
    { label: `Rebase ${curLabel} onto ${x}`, icon: "rebase", disabled: isCurrent, onSelect: () => void actions.rebase([repoId], x) },
    { separator: true },
    { label: "Push…", icon: "push", onSelect: () => void actions.push(repoId, { branch: x }) },
    { label: `Pull ${x}`, icon: "pull", disabled: !isCurrent, tooltip: isCurrent ? undefined : "Pull works on the current branch", onSelect: () => void actions.pull(repoId) },
    { separator: true },
    { label: "Rename…", icon: "rename", shortcut: "F2", onSelect: () => void actions.renameBranch(repoId, x) },
    {
      label: "Delete…",
      icon: "delete",
      shortcut: "Delete",
      danger: true,
      disabled: isCurrent,
      tooltip: isCurrent ? "The checked-out branch cannot be deleted" : undefined,
      onSelect: () => void actions.deleteBranch([repoId], x),
    },
    ...inAllRepos(x),
  ];
}

function remoteBranchMenu(n: Node<"remoteBranch">): MenuItem[] {
  const { repoId, remote } = n;
  const cur = currentOf(repoId) ?? "HEAD";
  return [
    { label: `Checkout ${remote.fullName}…`, icon: "checkout", onSelect: () => void actions.checkoutRemote(repoId, remote.fullName) },
    { label: `New branch from ${remote.fullName}…`, icon: "newBranch", onSelect: () => void actions.createBranch([repoId], remote.fullName, { startLabel: remote.fullName }) },
    { separator: true },
    { label: `Merge ${remote.fullName} into ${cur}`, icon: "merge", onSelect: () => void actions.merge([repoId], remote.fullName) },
    { label: `Rebase ${cur} onto ${remote.fullName}`, icon: "rebase", onSelect: () => void actions.rebase([repoId], remote.fullName) },
    { separator: true },
    {
      label: `Delete ${remote.fullName} on the remote…`,
      icon: "delete",
      danger: true,
      disabled: remote.remote !== "origin",
      tooltip: remote.remote !== "origin" ? "Only branches of origin can be deleted from here" : undefined,
      onSelect: () => void actions.deleteRemoteBranch(repoId, remote.remote, remote.name),
    },
    { separator: true },
    { label: "Copy name", icon: "copy", onSelect: () => void copyText(remote.fullName) },
    ...inAllRepos(remote.name),
  ];
}

function tagMenu(n: Node<"tag">): MenuItem[] {
  const { repoId, tag } = n;
  return [
    { label: `Checkout ${tag.name}`, icon: "checkout", onSelect: () => void actions.checkout(repoId, tag.name) },
    { label: `New branch from ${tag.name}…`, icon: "newBranch", onSelect: () => void actions.createBranch([repoId], tag.name, { startLabel: tag.name }) },
    { separator: true },
    { label: "Push tags", icon: "push", onSelect: () => void actions.push(repoId, { ask: false, tags: true }) },
    { label: `Delete ${tag.name}`, icon: "delete", danger: true, onSelect: () => void actions.tagDelete([repoId], tag.name) },
    { separator: true },
    { label: "Copy name", icon: "copy", onSelect: () => void copyText(tag.name) },
  ];
}

function stashMenu(n: Node<"stash">): MenuItem[] {
  const { repoId, stash } = n;
  const ref = `stash@{${stash.index}}`;
  return [
    { label: `Apply ${ref}`, icon: "stashPop", onSelect: () => void actions.stashApply(repoId, stash.index, stash.oid) },
    { label: `Pop ${ref}`, icon: "stashPop", onSelect: () => void actions.stashPop(repoId, stash.index, stash.oid) },
    { separator: true },
    { label: `Drop ${ref}…`, icon: "delete", danger: true, onSelect: () => void actions.stashDrop(repoId, stash.index, stash.oid) },
  ];
}

/** Menu for a tree node, or an empty list when the node has none. */
export function nodeMenu(n: SidebarNode): MenuItem[] {
  switch (n.kind) {
    case "repo": return repoMenu(n);
    case "branch": return localBranchMenu(n);
    case "remoteBranch": return remoteBranchMenu(n);
    case "tag": return tagMenu(n);
    case "stash": return stashMenu(n);
    case "submodule": return [{ label: "Copy path", icon: "copy", onSelect: () => void copyText(n.sub.path) }];
    default: return [];
  }
}
