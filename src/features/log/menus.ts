/**
 * Context menus of the log (DESIGN.md 5.11): on a commit row and on a ref pill. Every item names the exact branches
 * it acts on; all git work goes through `state/actions.ts`.
 */
import type { CommitRow, RefLabel } from "../../api/types";
import { copyText, plural, shortOid, toast, type MenuItem } from "../../components/ui";
import * as actions from "../../state/actions";
import { cachedRefs } from "../../state/refs";
import { splitRemoteRefLoose } from "../../state/remoteRefs";
import { repoById, summary } from "../../state/workspace";

const nameOf = (repoId: string): string => repoById(repoId)?.name ?? repoId;

export interface PickedCommit {
  repoId: string;
  oid: string;
  /** Commit index in the log (higher = older). */
  ci: number;
}

async function copy(text: string, what: string): Promise<void> {
  if (await copyText(text)) toast({ kind: "info", title: `${what} copied`, timeout: 2500 });
}

/** The branches of a commit row, local first. */
function branchRefs(row: CommitRow): RefLabel[] {
  return row.refs.filter((r) => r.kind === "local" || r.kind === "remote").sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "local" ? -1 : 1));
}

/** Menu of one branch name on a row: checkout, merge, rebase. */
function branchSubmenu(repoId: string, ref: RefLabel): MenuItem[] {
  const current = summary(repoId)?.branch ?? "HEAD";
  const isCurrent = ref.kind === "local" && ref.isCurrent;
  return [
    {
      label: `Checkout ${ref.name}`,
      icon: "checkout",
      disabled: isCurrent,
      onSelect: () => void (ref.kind === "remote" ? actions.checkoutRemote(repoId, ref.name) : actions.checkout(repoId, ref.name)),
    },
    { label: `Merge ${ref.name} into ${current}`, icon: "merge", disabled: isCurrent, onSelect: () => void actions.merge([repoId], ref.name) },
    { label: `Rebase ${current} onto ${ref.name}`, icon: "rebase", disabled: isCurrent, onSelect: () => void actions.rebase([repoId], ref.name) },
  ];
}

export interface CommitMenuOptions {
  /** More than one repo is shown: offer "show only this repository". */
  multiRepo: boolean;
  onlyRepo: (repoId: string) => void;
}

/** Context menu of a commit row. `picked` is the whole selection (it contains the row). */
export function commitMenu(row: CommitRow, picked: PickedCommit[], opts: CommitMenuOptions): MenuItem[] {
  if (picked.length > 1) return multiMenu(row.repoId, picked);
  const repo = nameOf(row.repoId);
  const short = shortOid(row.oid);
  const label = `${repo} @ ${short}`;
  const s = summary(row.repoId);
  const atHead = !!s?.headOid && s.headOid === row.oid;
  const current = s?.branch ?? "HEAD";
  const items: MenuItem[] = [
    { label: "Copy hash", icon: "copy", shortcut: "Ctrl+Shift+C", onSelect: () => void copy(row.oid, "Hash") },
    { label: "Copy subject", onSelect: () => void copy(row.subject, "Subject") },
    { separator: true },
    { label: "Checkout revision", icon: "checkout", disabled: atHead, tooltip: atHead ? "HEAD is already here" : "Detached HEAD at this commit", onSelect: () => void actions.checkout(row.repoId, row.oid) },
    { label: "New branch here…", icon: "newBranch", shortcut: "Ctrl+Alt+N", onSelect: () => void actions.createBranch([row.repoId], row.oid, { startLabel: label }) },
    { label: "New tag here…", icon: "tag", onSelect: () => void actions.tagCreate([row.repoId], row.oid, label) },
  ];
  const branches = branchRefs(row);
  if (branches.length > 0) {
    items.push({ separator: true });
    for (const b of branches.slice(0, 4)) items.push({ label: `Branch ${b.name}`, icon: b.kind === "remote" ? "remote" : "branch", submenu: branchSubmenu(row.repoId, b) });
  }
  items.push(
    { separator: true },
    { label: `Cherry-pick onto ${current}`, icon: "cherryPick", disabled: atHead, tooltip: atHead ? "HEAD is already here" : undefined, onSelect: () => void actions.cherryPick(row.repoId, [row.oid]) },
    { label: `Revert commit ${short}`, icon: "revert", onSelect: () => void actions.revert(row.repoId, row.oid) },
    { label: `Reset ${current} to here…`, icon: "reset", disabled: atHead, tooltip: atHead ? "HEAD is already here" : undefined, onSelect: () => void actions.reset([row.repoId], row.oid, label) },
    { label: "Interactive rebase from here…", icon: "rebase", disabled: true, tooltip: "Coming in 1.1" },
  );
  if (opts.multiRepo) {
    items.push({ separator: true }, { label: `Show only ${repo} in the log`, icon: "log", onSelect: () => opts.onlyRepo(row.repoId) });
  }
  return items;
}

/** Menu when several commits of one repo are selected. */
function multiMenu(repoId: string, picked: PickedCommit[]): MenuItem[] {
  // Oldest first: that is the order git applies them in.
  const oids = [...picked].sort((a, b) => b.ci - a.ci).map((p) => p.oid);
  const current = summary(repoId)?.branch ?? "HEAD";
  return [
    { label: `Cherry-pick ${plural(oids.length, "commit")} onto ${current}`, icon: "cherryPick", onSelect: () => void actions.cherryPick(repoId, oids) },
    { separator: true },
    { label: `Copy ${plural(oids.length, "hash", "hashes")}`, icon: "copy", onSelect: () => void copy(oids.join("\n"), oids.length === 1 ? "Hash" : "Hashes") },
  ];
}

/** Context menu of a ref pill. */
export function refMenu(repoId: string, ref: RefLabel): MenuItem[] {
  const s = summary(repoId);
  const current = s?.branch ?? "HEAD";
  const name = ref.name;
  const copyName: MenuItem = { label: "Copy name", icon: "copy", onSelect: () => void copy(name, "Name") };
  if (ref.kind === "tag") {
    return [
      { label: `Checkout tag ${name}`, icon: "checkout", onSelect: () => void actions.checkout(repoId, name) },
      { label: `New branch from ${name}…`, icon: "newBranch", onSelect: () => void actions.createBranch([repoId], name, { startLabel: name }) },
      { separator: true },
      { label: `Delete tag ${name}`, icon: "delete", danger: true, onSelect: () => void actions.tagDelete([repoId], name) },
      { separator: true },
      copyName,
    ];
  }
  if (ref.kind === "remote") {
    const split = splitRemoteRefLoose(name, cachedRefs(repoId));
    const remote = split?.remote ?? "origin";
    const short = split?.branch ?? name;
    return [
      { label: `Checkout ${name}`, icon: "checkout", onSelect: () => void actions.checkoutRemote(repoId, name) },
      { label: `New branch from ${name}…`, icon: "newBranch", onSelect: () => void actions.createBranch([repoId], name, { startLabel: name }) },
      { separator: true },
      { label: `Merge ${name} into ${current}`, icon: "merge", onSelect: () => void actions.merge([repoId], name) },
      { label: `Rebase ${current} onto ${name}`, icon: "rebase", onSelect: () => void actions.rebase([repoId], name) },
      { separator: true },
      { label: `Delete ${name} on the remote…`, icon: "delete", danger: true, onSelect: () => void actions.deleteRemoteBranch(repoId, remote, short) },
      { separator: true },
      copyName,
    ];
  }
  const isCurrent = ref.isCurrent;
  return [
    { label: `Checkout ${name}`, icon: "checkout", disabled: isCurrent, tooltip: isCurrent ? "Already checked out" : undefined, onSelect: () => void actions.checkout(repoId, name) },
    { label: `New branch from ${name}…`, icon: "newBranch", onSelect: () => void actions.createBranch([repoId], name, { startLabel: name }) },
    { separator: true },
    { label: `Merge ${name} into ${current}`, icon: "merge", disabled: isCurrent, onSelect: () => void actions.merge([repoId], name) },
    { label: `Rebase ${current} onto ${name}`, icon: "rebase", disabled: isCurrent, onSelect: () => void actions.rebase([repoId], name) },
    { separator: true },
    { label: "Push…", icon: "push", onSelect: () => void actions.push([repoId], { branch: name }) },
    { label: "Rename…", icon: "rename", shortcut: "F2", onSelect: () => void actions.renameBranch(repoId, name) },
    { label: `Delete ${name}`, icon: "delete", danger: true, shortcut: "Delete", disabled: isCurrent, tooltip: isCurrent ? "The current branch cannot be deleted" : undefined, onSelect: () => void actions.deleteBranch([repoId], name) },
    { separator: true },
    copyName,
  ];
}

/**
 * Which ref pill was hit by a pointer event inside a row's ref cell. The pills come from the shared `RefPills`
 * component, so the pill is found by its text. Returns null for the "+N" pill and for clicks between pills.
 */
export function refAtTarget(target: EventTarget | null, row: CommitRow): RefLabel | null {
  const pill = (target as HTMLElement | null)?.closest?.(".dg-ref");
  if (!pill) return null;
  const textEl = pill.querySelector(".dg-ref-text");
  if (!textEl) return null;
  const text = textEl.textContent ?? "";
  return row.refs.find((r) => r.kind !== "head" && r.name === text) ?? null;
}
