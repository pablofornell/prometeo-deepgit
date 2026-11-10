/**
 * What the palette searches and what it does with a pick. Items are plain JSON-able data so the last
 * ten picks can be persisted (`recent.ts`); everything live (shortcuts, repo names, ahead/behind) is looked
 * up again when a row is rendered or activated.
 */
import * as api from "../../api/tauri";
import type { DiffSpec, FileStatus } from "../../api/types";
import { type IconName, type MenuItem, openContextMenu, toast } from "../../components/ui";
import * as actions from "../../state/actions";
import { projectColorMenu, repoColorMenu } from "../../state/colorActions";
import { bindings, runBinding } from "../../state/keymap";
import { repoRefs } from "../../state/refs";
import { selectFile, selectedCommit, setChangesRepoId, setMainTab, setSelectedCommit } from "../../state/selection";
import { settings, setSetting } from "../../state/settings";
import {
  activeProject, addProject, focusedRepo, projectRepos, rescanProject, selectAllRepos, selectOnlyRepo,
  selectedRepoIds, setFocusedRepoId, toggleRepo,
} from "../../state/workspace";

export type ItemKind = "action" | "branch" | "commit" | "file" | "repo";

export interface ActionItem { kind: "action"; key: string; title: string; icon: IconName; group: string }
export interface BranchItem { kind: "branch"; key: string; name: string; remote: boolean; repoIds: string[]; isCurrent: boolean; ahead: number; behind: number }
export interface CommitItem { kind: "commit"; key: string; repoId: string; oid: string; subject: string; authorName: string }
export interface FileItem { kind: "file"; key: string; repoId: string; path: string; oldPath?: string; status: FileStatus; spec: DiffSpec }
export interface RepoItem { kind: "repo"; key: string; repoId: string }
export type PaletteItem = ActionItem | BranchItem | CommitItem | FileItem | RepoItem;

// ---------------------------------------------------------------- actions

interface ExtraAction { key: string; title: string; icon: IconName; group: string; run: () => void }

/** Palette-only actions: things without a keyboard binding. Keys start with "x.". */
/** Opens the colour swatches of `menu` (a "Set Color" item) in the upper middle of the window, after the palette has closed. */
function showColorMenu(title: string, menu: MenuItem): void {
  const items: MenuItem[] = [{ label: title, heading: true }, ...(menu.submenu ?? [])];
  window.setTimeout(() => openContextMenu({ x: Math.round(window.innerWidth / 2) - 100, y: Math.round(window.innerHeight / 4) }, items), 0);
}

const EXTRAS: ExtraAction[] = [
  { key: "x.repoColor", title: "Set repository color…", icon: "palette", group: "Project", run: () => { const r = focusedRepo(); if (r) showColorMenu(`Color of ${r.name}`, repoColorMenu(r)); } },
  { key: "x.projectColor", title: "Set project color…", icon: "palette", group: "Project", run: () => { const p = activeProject(); if (p) showColorMenu(`Color of ${p.name}`, projectColorMenu(p)); } },
  { key: "x.addProject", title: "Add project…", icon: "plus", group: "Project", run: () => void addProject() },
  { key: "x.clone", title: "Clone repository…", icon: "repo", group: "Project", run: () => void actions.cloneRepository() },
  { key: "x.rescan", title: "Rescan project for repositories", icon: "refresh", group: "Project", run: () => { const p = activeProject(); if (p) void rescanProject(p.id); } },
  { key: "x.showLog", title: "Show log", icon: "log", group: "View", run: () => setMainTab("log") },
  { key: "x.allRepos", title: "Show all repositories in the log", icon: "repo", group: "View", run: selectAllRepos },
  { key: "x.toggleGraph", title: "Toggle commit graph", icon: "log", group: "View", run: () => setSetting("showGraph", !settings.showGraph) },
  { key: "x.fetchFocused", title: "Fetch the focused repository", icon: "fetch", group: "Git", run: () => { const r = focusedRepo(); if (r) void actions.fetch(r.id); } },
  { key: "x.pushAll", title: "Push all repositories…", icon: "push", group: "Git", run: () => void actions.push(projectRepos().map((r) => r.id)) },
  { key: "x.stashAll", title: "Stash changes in all repositories…", icon: "stashPush", group: "Git", run: () => void actions.stashSave(projectRepos().map((r) => r.id)) },
  { key: "x.tagHead", title: "New tag on HEAD…", icon: "tag", group: "Git", run: () => { const r = focusedRepo(); if (r) void actions.tagCreate([r.id], "HEAD", "HEAD"); } },
];

const ICON_BY_BINDING: Record<string, IconName> = {
  "git.fetchAll": "fetch", "git.pull": "pull", "git.pullAll": "pull", "git.push": "push", "git.newBranch": "newBranch",
  "git.stash": "stashPush", "view.refresh": "refresh", "view.toggleTheme": "palette", "tool.sidebar": "project",
  "tool.changes": "changes", "tool.matrix": "matrix", "tool.console": "console", "tool.diff": "sideBySide", "tool.closeBottom": "close",
};
const ICON_BY_GROUP: Record<string, IconName> = { Log: "log", Diff: "sideBySide", "Tool windows": "console", Global: "arrowRight" };

/** Every action: the titled keyboard bindings (with their shortcut) plus the palette-only ones. Reactive. */
export function actionItems(): ActionItem[] {
  const out: ActionItem[] = [];
  for (const b of bindings()) {
    if (!b.title || b.id.startsWith("palette.")) continue;
    out.push({ kind: "action", key: b.id, title: b.title, group: b.group ?? "Actions", icon: ICON_BY_BINDING[b.id] ?? ICON_BY_GROUP[b.group ?? ""] ?? "arrowRight" });
  }
  for (const x of EXTRAS) out.push({ kind: "action", key: x.key, title: x.title, group: x.group, icon: x.icon });
  return out;
}

// ---------------------------------------------------------------- branches

/** Branches of the project's repos, one item per name with every repo that has it. Reactive (loads refs on first read). */
export function branchItems(): BranchItem[] {
  const local = new Map<string, BranchItem>();
  const remote = new Map<string, BranchItem>();
  for (const repo of projectRepos()) {
    const refs = repoRefs(repo.id)();
    if (!refs) continue;
    for (const b of refs.local) {
      const it = local.get(b.name) ?? { kind: "branch", key: "l:" + b.name, name: b.name, remote: false, repoIds: [], isCurrent: false, ahead: 0, behind: 0 };
      it.repoIds.push(repo.id);
      it.isCurrent ||= b.isHead;
      it.ahead += b.ahead;
      it.behind += b.behind;
      local.set(b.name, it);
    }
    for (const b of refs.remote) {
      if (b.name === "HEAD") continue;
      const it = remote.get(b.fullName) ?? { kind: "branch", key: "r:" + b.fullName, name: b.fullName, remote: true, repoIds: [], isCurrent: false, ahead: 0, behind: 0 };
      it.repoIds.push(repo.id);
      remote.set(b.fullName, it);
    }
  }
  const byName = (a: BranchItem, b: BranchItem) => Number(b.isCurrent) - Number(a.isCurrent) || a.name.localeCompare(b.name);
  return [...[...local.values()].sort(byName), ...[...remote.values()].sort(byName)];
}

// ---------------------------------------------------------------- repos

export function repoItems(): RepoItem[] {
  return projectRepos().map((r) => ({ kind: "repo", key: r.id, repoId: r.id }));
}

// ---------------------------------------------------------------- commits and files (async)

/** Top `limit` commits matching `text` (message or hash) or, with `author`, written by `text`, in the given repos. */
export async function searchCommits(text: string, author: boolean, repoIds: string[], limit = 30): Promise<CommitItem[]> {
  if (repoIds.length === 0) return [];
  const info = await api.logOpen({ repoIds, refs: [], text: author ? null : text || null, author: author ? text : null, maxCount: limit });
  try {
    const rows = await api.logRows(info.sessionId, 0, limit);
    return rows.map((r) => ({ kind: "commit", key: `${r.repoId}:${r.oid}`, repoId: r.repoId, oid: r.oid, subject: r.subject, authorName: r.authorName }));
  } finally {
    void api.logClose(info.sessionId).catch(() => undefined);
  }
}

/** Changed files: the working tree of every repo plus the files of the selected commit. */
export async function loadFiles(): Promise<FileItem[]> {
  const out: FileItem[] = [];
  const trees = await Promise.all(
    projectRepos().map((r) => api.workingTree(r.id).catch(() => null)),
  );
  for (const wt of trees) {
    if (!wt) continue;
    const seen = new Set<string>();
    const add = (list: typeof wt.staged, spec: DiffSpec) => {
      for (const f of list) {
        if (seen.has(f.path)) continue;
        seen.add(f.path);
        out.push({ kind: "file", key: `${wt.repoId}:w:${f.path}`, repoId: wt.repoId, path: f.path, oldPath: f.oldPath ?? undefined, status: f.status, spec });
      }
    };
    add(wt.conflicted, { kind: "unstaged" });
    add(wt.unstaged, { kind: "unstaged" });
    add(wt.staged, { kind: "staged" });
  }
  const sel = selectedCommit();
  if (sel) {
    const d = await api.commitDetails(sel.repoId, sel.oid).catch(() => null);
    for (const f of d?.files ?? []) {
      out.push({ kind: "file", key: `${sel.repoId}:${sel.oid}:${f.path}`, repoId: sel.repoId, path: f.path, oldPath: f.oldPath ?? undefined, status: f.status, spec: { kind: "commit", oid: sel.oid } });
    }
  }
  return out;
}

// ---------------------------------------------------------------- activation

/** Does what a pick means. The caller has already closed the palette. */
export function activate(item: PaletteItem): void {
  switch (item.kind) {
    case "action": {
      const extra = EXTRAS.find((x) => x.key === item.key);
      if (extra) extra.run();
      else if (!runBinding(item.key)) toast({ kind: "info", title: `${item.title} is not available here` });
      return;
    }
    case "branch": {
      const repos = projectRepos().filter((r) => item.repoIds.includes(r.id));
      if (repos.length === 0) return;
      if (item.remote) {
        const target = repos.find((r) => r.id === focusedRepo()?.id) ?? repos[0];
        void actions.checkoutRemote(target.id, item.name);
      } else {
        void actions.checkout(repos.map((r) => r.id), item.name, { branchOnly: true });
      }
      return;
    }
    case "commit":
      if (!selectedRepoIds().includes(item.repoId)) toggleRepo(item.repoId);
      setSelectedCommit({ repoId: item.repoId, oid: item.oid });
      setMainTab("log");
      return;
    case "file":
      if (item.spec.kind === "commit") {
        setSelectedCommit({ repoId: item.repoId, oid: item.spec.oid });
        setMainTab("log");
      } else {
        setChangesRepoId(item.repoId);
        setMainTab("changes");
      }
      selectFile({ repoId: item.repoId, spec: item.spec, path: item.path, oldPath: item.oldPath });
      return;
    case "repo":
      selectOnlyRepo(item.repoId);
      setFocusedRepoId(item.repoId);
      return;
  }
}
