/**
 * Dialog registry. Actions (`state/actions.ts`) ask for user input with `showDialog(name, props)`;
 * the dialogs agent implements the components and registers them in `features/dialogs/index.ts`:
 *
 *   registerDialog("newBranch", NewBranchDialog);          // Component<NewBranchProps & DialogComponentProps<NewBranchResult>>
 *   const r = await showDialog("newBranch", { repoIds, startPoint: "main" });   // undefined = cancelled
 *
 * Only "confirm" is implemented here (`ConfirmDialog`). Until a name is registered, `showDialog` falls back
 * to `window.prompt` / `window.confirm` so every flow still works. To add a dialog: add an entry to
 * `DialogRegistry`, then register a component for it.
 */
import type { Component } from "solid-js";
import type { ResetMode } from "../api/types";
import { ConfirmDialog, type ConfirmProps, type ConfirmResult, type DialogComponentProps, openDialog } from "../components/ui";

export type { ConfirmProps, ConfirmResult } from "../components/ui";

export interface NewBranchProps {
  /** Repos the branch can be created in (the dialog shows a checklist when more than one). */
  repoIds: string[];
  /** Commit, branch or tag the new branch starts at (read-only in the dialog). */
  startPoint: string;
  /** Text to show instead of the raw start point ("main", "api-gateway @ 9f3c2a1"). */
  startLabel?: string;
  suggestedName?: string;
}
export interface NewBranchResult {
  name: string;
  checkout: boolean;
  /** Repos selected in the checklist. */
  repoIds: string[];
}

export interface RenameBranchProps {
  repoId: string;
  oldName: string;
  /** True when the branch has a remote counterpart (shows "Also rename on <remote>"). */
  hasRemote?: boolean;
  /** Full name of that counterpart ("origin/feature"): the upstream when it has the same branch name, else `origin/<oldName>`. */
  remoteName?: string;
}
export interface RenameBranchResult {
  newName: string;
  renameRemote: boolean;
}

export interface MergeProps {
  repoIds: string[];
  /** Branch (or commit) to merge in. */
  source: string;
  /** Current branch; read-only in the dialog. */
  target: string;
}
export interface MergeResult {
  noFf: boolean;
  squash: boolean;
  /** Commit message when a merge commit is created. */
  message?: string;
}

export interface RebaseProps {
  repoIds: string[];
  /** Branch being rebased (the current one). */
  branch: string;
  /** Suggested base. */
  onto: string;
}
export interface RebaseResult {
  onto: string;
}

export interface ResetProps {
  repoIds: string[];
  /** Commit or ref to reset to. */
  target: string;
  targetLabel?: string;
  /** Number of files with uncommitted changes (shown in the hard-reset warning). */
  dirtyFiles?: number;
}
export interface ResetResult {
  mode: ResetMode;
}

export interface PushProps {
  repoIds: string[];
  /** Branch to push; default is each repo's current branch. */
  branch?: string;
}
export interface PushResult {
  remote: string | null;
  branch: string | null;
  /** `--force-with-lease`. */
  force: boolean;
  setUpstream: boolean;
  tags: boolean;
}

export interface StashProps {
  repoIds: string[];
}
export interface StashResult {
  message: string | null;
  includeUntracked: boolean;
  keepIndex: boolean;
}

export interface TagProps {
  repoIds: string[];
  /** Commit or ref to tag. */
  target: string;
  targetLabel?: string;
}
export interface TagResult {
  name: string;
  /** Non-null makes an annotated tag. */
  message: string | null;
}

export interface CheckoutRemoteProps {
  repoId: string;
  /** Remote branch, e.g. "origin/feature/x". */
  remoteBranch: string;
}
export interface CheckoutRemoteResult {
  /** Name of the local tracking branch to create. */
  localName: string;
}

/** Props and result of every dialog name. */
export interface DialogRegistry {
  newBranch: { props: NewBranchProps; result: NewBranchResult };
  renameBranch: { props: RenameBranchProps; result: RenameBranchResult };
  merge: { props: MergeProps; result: MergeResult };
  rebase: { props: RebaseProps; result: RebaseResult };
  reset: { props: ResetProps; result: ResetResult };
  confirm: { props: ConfirmProps; result: ConfirmResult };
  push: { props: PushProps; result: PushResult };
  stash: { props: StashProps; result: StashResult };
  tag: { props: TagProps; result: TagResult };
  checkoutRemote: { props: CheckoutRemoteProps; result: CheckoutRemoteResult };
}

export type DialogName = keyof DialogRegistry;
export type DialogProps<K extends DialogName> = DialogRegistry[K]["props"];
export type DialogResult<K extends DialogName> = DialogRegistry[K]["result"];

const registry = new Map<DialogName, Component<never>>();

/** Registers the component that implements dialog `name` (call from `registerAllDialogs`). */
export function registerDialog<K extends DialogName>(name: K, component: Component<DialogProps<K> & DialogComponentProps<DialogResult<K>>>): void {
  registry.set(name, component as unknown as Component<never>);
}

/** True when a real component is registered for `name`. */
export const isDialogRegistered = (name: DialogName): boolean => registry.has(name);

/** Opens dialog `name`. Resolves to its result, or `undefined` when the user cancels. */
export function showDialog<K extends DialogName>(name: K, props: DialogProps<K>): Promise<DialogResult<K> | undefined> {
  const component = registry.get(name);
  if (component) return openDialog(component as unknown as Component<DialogProps<K> & DialogComponentProps<DialogResult<K>>>, props);
  return Promise.resolve(fallback(name, props));
}

/** Shorthand for the confirm dialog: resolves to the checkbox states, or undefined when cancelled. */
export function confirmAction(props: ConfirmProps): Promise<ConfirmResult | undefined> {
  return showDialog("confirm", props);
}

registerDialog("confirm", ConfirmDialog);

// ---------------------------------------------------------------- window.prompt fallbacks

function fallback<K extends DialogName>(name: K, props: DialogProps<K>): DialogResult<K> | undefined {
  const p = props as unknown;
  const out = ((): unknown => {
    switch (name) {
      case "newBranch": {
        const q = p as NewBranchProps;
        const n = window.prompt(`New branch from ${q.startLabel ?? q.startPoint}`, q.suggestedName ?? "");
        return n?.trim() ? ({ name: n.trim(), checkout: true, repoIds: q.repoIds } satisfies NewBranchResult) : undefined;
      }
      case "renameBranch": {
        const q = p as RenameBranchProps;
        const n = window.prompt(`Rename branch ${q.oldName} to`, q.oldName);
        return n?.trim() && n.trim() !== q.oldName ? ({ newName: n.trim(), renameRemote: false } satisfies RenameBranchResult) : undefined;
      }
      case "merge": {
        const q = p as MergeProps;
        return window.confirm(`Merge ${q.source} into ${q.target}?`) ? ({ noFf: false, squash: false } satisfies MergeResult) : undefined;
      }
      case "rebase": {
        const q = p as RebaseProps;
        const onto = window.prompt(`Rebase ${q.branch} onto`, q.onto);
        return onto?.trim() ? ({ onto: onto.trim() } satisfies RebaseResult) : undefined;
      }
      case "reset": {
        const q = p as ResetProps;
        const m = window.prompt(`Reset to ${q.targetLabel ?? q.target}: soft, mixed, hard or keep?`, "mixed");
        return m && ["soft", "mixed", "hard", "keep"].includes(m.trim()) ? ({ mode: m.trim() as ResetMode } satisfies ResetResult) : undefined;
      }
      case "confirm": {
        const q = p as ConfirmProps;
        return window.confirm(`${q.title}\n\n${Array.isArray(q.message) ? q.message.join("\n") : q.message}`) ? ({ checked: {} } satisfies ConfirmResult) : undefined;
      }
      case "push":
        return { remote: null, branch: (p as PushProps).branch ?? null, force: false, setUpstream: false, tags: false } satisfies PushResult;
      case "stash": {
        const m = window.prompt("Stash message (optional)", "");
        return m === null ? undefined : ({ message: m.trim() || null, includeUntracked: false, keepIndex: false } satisfies StashResult);
      }
      case "tag": {
        const q = p as TagProps;
        const n = window.prompt(`Tag name for ${q.targetLabel ?? q.target}`, "");
        return n?.trim() ? ({ name: n.trim(), message: null } satisfies TagResult) : undefined;
      }
      case "checkoutRemote": {
        const q = p as CheckoutRemoteProps;
        const def = q.remoteBranch.slice(q.remoteBranch.indexOf("/") + 1);
        const n = window.prompt(`Local branch name for ${q.remoteBranch}`, def);
        return n?.trim() ? ({ localName: n.trim() } satisfies CheckoutRemoteResult) : undefined;
      }
    }
    return undefined;
  })();
  return out as DialogResult<K> | undefined;
}
