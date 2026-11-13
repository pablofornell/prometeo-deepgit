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
import type { AuthPrompt, IgnoreTarget, MergeOpts, ResetMode } from "../api/types";
import type { AuthDialogResult } from "./authQueue";
import { ConfirmDialog, type ConfirmProps, type ConfirmResult, type DialogComponentProps, openDialog } from "../components/ui";

export type { ConfirmProps, ConfirmResult } from "../components/ui";
export type { AuthDialogResult } from "./authQueue";

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

export interface RenameProjectProps {
  projectId: string;
}
export interface RenameProjectResult {
  /** The new name, trimmed and valid. */
  name: string;
}

export interface MergeProps {
  repoIds: string[];
  /** Branch (or commit) to merge in. */
  source: string;
  /** Current branch; read-only in the dialog. */
  target: string;
  /** What `source` is, for git's default message ("Merge remote-tracking branch 'origin/x' into main"). Default "branch". */
  sourceKind?: "branch" | "remote" | "tag" | "commit";
}
/**
 * The options to merge with (see `api/mergeRules.ts` for the rules). `message` is null unless the user changed git's
 * default message, so repos on different branches keep their own default.
 */
export type MergeResult = MergeOpts;

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

export interface SettingsProps {
  /** Id of the section to show (`appearance`, `log`, ...); default the first one. */
  section?: string;
}
export interface CloneProps {
  /** URL to start with (for example from the clipboard). */
  url?: string;
}
/** What a finished clone leaves: the dialog does the work (`actions.startClone`) and closes with this. */
export interface CloneDialogResult {
  /** Absolute path of the new repository. */
  path: string;
  projectId: string;
}
export interface AuthProps {
  /** The question of a running fetch, pull or push (docs/PLAN.md section 5.6). `state/auth.ts` opens this dialog. */
  prompt: AuthPrompt;
}

export interface ConflictsProps {
  /** Repos whose conflicted files are listed (grouped by repo); the first one is focused. */
  repoIds: string[];
}
export interface ConflictsResult {
  /** Always true: the dialog has no result, it only closes. */
  closed: true;
}

export interface MergeFileProps {
  repoId: string;
  /** Path of the conflicted file, relative to the repo. */
  path: string;
}
export interface MergeFileResult {
  /** The file was resolved (staged, or its deleted / kept side accepted). False: saved with conflict markers. */
  resolved: boolean;
}

export interface IgnoreProps {
  repoId: string;
  /** The files and folders to ignore. `path` is relative to the repo. */
  items: { path: string; isDir: boolean }[];
}
export interface IgnoreResult {
  /** The file that got the lines. */
  target: IgnoreTarget;
  /** The lines that were added (a line that the file held already is not here). */
  added: string[];
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
  settings: { props: SettingsProps; result: void };
  clone: { props: CloneProps; result: CloneDialogResult };
  auth: { props: AuthProps; result: AuthDialogResult };
  conflicts: { props: ConflictsProps; result: ConflictsResult };
  mergeFile: { props: MergeFileProps; result: MergeFileResult };
  renameProject: { props: RenameProjectProps; result: RenameProjectResult };
  ignore: { props: IgnoreProps; result: IgnoreResult };
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
        return window.confirm(`Merge ${q.source} into ${q.target}?`) ? ({ mode: "ff", message: null, noCommit: false, allowUnrelatedHistories: false } satisfies MergeResult) : undefined;
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
      case "auth": {
        const q = p as AuthProps;
        const a = window.prompt(q.prompt.prompt);
        return a === null ? undefined : ({ answer: a, remember: false } satisfies AuthDialogResult);
      }
    }
    return undefined;
  })();
  return out as DialogResult<K> | undefined;
}
