/** Sidebar island (DESIGN.md 5.3): project header and card, repository tree with branches, tags, stashes and submodules. */
import { type JSX, Show, createEffect, createMemo, createSignal, on, untrack } from "solid-js";
import {
  AheadBehind, EmptyState, Icon, IconButton, RepoIcon, Tree, createExpanded, initials, openContextMenu, openMenu, plural,
  type IconName, type MenuItem, type TreeRowInfo,
} from "../../components/ui";
import * as actions from "../../state/actions";
import { formatDate, fullDate } from "../../state/dates";
import { setSidebarVisible } from "../../state/layout";
import { loadPersisted, savePersisted } from "../../state/persist";
import { repoRefs } from "../../state/refs";
import { changesRepoForNode } from "../../state/changesScope";
import { selectFile, selectedFile, setChangesRepoId, setDetailsTab, setSelectedCommit } from "../../state/selection";
import {
  repoById, activeProject, addProject, focusedRepoIdSignal, isRepoFilterActive, projectRepos, rescanProject, selectAllRepos, selectOnlyRepo, selectedRepoIds,
  setFocusedRepoId, summary, toggleRepo,
} from "../../state/workspace";
import { allHidden, toggleFolder, showOnly } from "./folders";
import { nodeMenu } from "./menus";
import { ProjectNameEditor } from "./ProjectNameEditor";
import { renamingAfterSwitch } from "./rename";
import { buildTree, expandableIds, filterTree, folderIds, ids, repoDot, stateLabel, worstDot, type SidebarNode } from "./nodes";
import { cssPx } from "../../state/metrics";
import "./sidebar.css";


function Hl(props: { text: string; query: string }): JSX.Element {
  const parts = () => {
    const i = props.query ? props.text.toLowerCase().indexOf(props.query) : -1;
    return i < 0 ? null : ([props.text.slice(0, i), props.text.slice(i, i + props.query.length), props.text.slice(i + props.query.length)] as const);
  };
  return (
    <Show when={parts()} fallback={props.text}>
      {(p) => (
        <>
          {p()[0]}
          <mark class="dg-sidebar-match">{p()[1]}</mark>
          {p()[2]}
        </>
      )}
    </Show>
  );
}

const groupIcon: Record<string, IconName> = { local: "branch", tags: "tag", stashes: "stash", submodules: "submodule" };

/** Branch text of a repo row: operation in progress, detached hash, or the branch name. */
function RepoBranch(props: { repoId: string; query: string }): JSX.Element {
  const s = () => summary(props.repoId);
  const op = () => (s() ? stateLabel(s()!.state) : null);
  return (
    <span
      class="dg-sidebar-branch"
      classList={{ "is-error": !!op(), "is-mono": !op() && !!s() && !s()!.branch }}
      data-tip={op() ? `${op()} in progress` : s()?.branch ? `On branch ${s()!.branch}` : s() ? `Detached HEAD at ${(s()!.headOid ?? "").slice(0, 7)}` : undefined}
    >
      <Show when={op()} fallback={s()?.branch ? <Hl text={s()!.branch!} query={props.query} /> : (s()?.headOid ?? "").slice(0, 7)}>
        {op()}
      </Show>
    </span>
  );
}

export function Sidebar(): JSX.Element {
  const [expanded, ex] = createExpanded();
  const [moreOpen, setMoreOpen] = createSignal<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = createSignal<string | null>(null);
  const [query, setQuery] = createSignal("");
  /** Folders the user collapsed (ids). Every other folder is open, so a new folder starts open (ITERATION-3 1.4). */
  const [collapsed, setCollapsedSignal] = createSignal<ReadonlySet<string>>(new Set());
  const collapsedKey = () => `sidebar.collapsedFolders.${activeProject()?.id ?? "none"}`;
  const setCollapsed = (next: ReadonlySet<string>) => {
    setCollapsedSignal(next);
    savePersisted(collapsedKey(), [...next]);
  };

  const single = () => projectRepos().length === 1;
  const q = () => query().trim().toLowerCase();

  // Start with the focused repo open (Local and origin expanded), whenever the project changes.
  createEffect(
    on(
      () => activeProject()?.id,
      () => {
        const repos = projectRepos();
        const target = repos.length === 1 ? repos[0] : repos.find((r) => r.id === focusedRepoIdSignal()) ?? repos[0];
        const open = new Set<string>();
        if (target) {
          if (repos.length > 1) open.add(ids.repo(target.id));
          open.add(ids.group(target.id, "local"));
          open.add(ids.remote(target.id, "origin"));
        }
        ex.set(open);
        setMoreOpen(new Set<string>());
        setCollapsedSignal(new Set(loadPersisted<string[]>(collapsedKey(), [])));
        setQuery("");
        setSelected(target ? (repos.length > 1 ? ids.repo(target.id) : null) : null);
      },
    ),
  );

  // The focused repo (set from the log, the status bar...) is the selected row.
  createEffect(
    on(focusedRepoIdSignal, (id) => {
      if (!id || single()) return;
      const cur = selected();
      if (!cur || !cur.includes(id)) setSelected(ids.repo(id));
    }),
  );

  const rawTree = createMemo(() =>
    buildTree(projectRepos(), {
      refsOf: (id) => repoRefs(id)(),
      summaryOf: summary,
      expanded: expanded(),
      moreOpen: moreOpen(),
      query: q(),
    }),
  );
  const roots = createMemo(() => (q() ? filterTree(rawTree(), q()) : rawTree()));
  const allFolderIds = createMemo(() => folderIds(rawTree()));
  // a folder that is gone (repo removed, folders merged or split) loses its saved collapsed state
  createEffect(
    on(allFolderIds, (all) => {
      if (q() || all.length === 0) return;
      const cur = untrack(collapsed);
      const keep = [...cur].filter((id) => all.includes(id));
      if (keep.length !== cur.size) setCollapsed(new Set(keep));
    }),
  );
  /** The tree gets the open folders next to the open repos and groups. */
  const effectiveExpanded = createMemo(() => {
    if (q()) return expandableIds(roots());
    const open = new Set(expanded());
    for (const id of allFolderIds()) if (!collapsed().has(id)) open.add(id);
    return open;
  });

  /** Opens or closes the folders `fids`; the others keep their state. */
  const setFoldersOpen = (fids: readonly string[], open: boolean) => {
    const next = new Set(collapsed());
    for (const id of fids) {
      if (open) next.delete(id);
      else next.add(id);
    }
    setCollapsed(next);
  };

  const onExpandedChange = (next: Set<string>) => {
    if (q()) return;
    // folder ids go to the collapsed set
    const all = allFolderIds();
    const nextCollapsed = new Set([...collapsed()].filter((id) => all.includes(id)));
    for (const id of all) if (!next.has(id)) nextCollapsed.add(id);
    if (nextCollapsed.size !== collapsed().size || [...nextCollapsed].some((id) => !collapsed().has(id))) setCollapsed(nextCollapsed);
    for (const id of all) next.delete(id);
    const cur = expanded();
    for (const id of [...next]) {
      // opening a repo also opens its Local and origin groups
      if (!cur.has(id) && id.startsWith("repo:")) {
        const repoId = id.slice(5);
        next.add(ids.group(repoId, "local"));
        next.add(ids.remote(repoId, "origin"));
      }
    }
    ex.set(next);
  };

  const select = (n: SidebarNode) => {
    if (n.kind === "loading") return;
    setSelected(n.id);
    // a folder row only selects: the focused repo stays
    if (n.kind === "folder") return;
    setFocusedRepoId(n.repoId);
    // Local changes follows a repo row picked here (not its branches, tags or stashes)
    const only = changesRepoForNode(n.kind, n.repoId, projectRepos().length);
    if (only) setChangesRepoId(only);
    if (n.kind === "more") setMoreOpen(new Set([...moreOpen(), n.groupId]));
    if (n.kind === "stash") {
      // The stash shows its files in "Changed files". A commit file open before is dropped.
      setSelectedCommit({ repoId: n.repoId, oid: n.stash.oid, stash: { index: n.stash.index } });
      if (selectedFile()?.spec.kind === "commit") selectFile(null);
      setDetailsTab("files");
    }
  };

  const activate = (n: SidebarNode) => {
    switch (n.kind) {
      case "folder":
        if (!q()) setFoldersOpen([n.id], collapsed().has(n.id));
        break;
      case "repo":
        if (projectRepos().length > 1) selectOnlyRepo(n.repoId);
        break;
      case "branch":
        if (!n.branch.isHead) void actions.checkout(n.repoId, n.branch.name);
        break;
      case "remoteBranch":
        void actions.checkoutRemote(n.repoId, n.remote.fullName);
        break;
      case "tag":
        void actions.checkout(n.repoId, n.tag.name);
        break;
      case "stash":
        void actions.stashApply(n.repoId, n.stash.index, n.stash.oid);
        break;
      case "group":
      case "remote":
        if (!q()) ex.toggle(n.id);
        break;
      case "more":
        setMoreOpen(new Set([...moreOpen(), n.groupId]));
        break;
    }
  };

  const nodeById = (id: string | null): SidebarNode | undefined => {
    const find = (list: readonly SidebarNode[]): SidebarNode | undefined => {
      for (const n of list) {
        if (n.id === id) return n;
        const hit = n.children ? find(n.children) : undefined;
        if (hit) return hit;
      }
      return undefined;
    };
    return id ? find(roots()) : undefined;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const node = nodeById(selected());
    if (e.key === "Escape" && query()) {
      e.preventDefault();
      e.stopPropagation();
      setQuery("");
    } else if (e.key === "Backspace" && query()) {
      e.preventDefault();
      setQuery(query().slice(0, -1));
    } else if (e.key === "F2" && node?.kind === "branch") {
      e.preventDefault();
      void actions.renameBranch(node.repoId, node.branch.name);
    } else if (e.key === "Delete" && node) {
      e.preventDefault();
      if (node.kind === "branch" && !node.branch.isHead) void actions.deleteBranch([node.repoId], node.branch.name);
      else if (node.kind === "tag") void actions.tagDelete([node.repoId], node.tag.name);
      else if (node.kind === "stash") void actions.stashDrop(node.repoId, node.stash.index, node.stash.oid);
    } else if (e.key.length === 1 && (e.key !== " " || query())) {
      e.preventDefault();
      setQuery(query() + e.key);
    }
  };

  /**
   * The project whose name in the card is an input (double-click, F2, "Rename project…"), or null. When the card shows
   * another project the editor closes without saving (`rename.ts`).
   */
  const [renaming, setRenaming] = createSignal<string | null>(null);
  createEffect(on(() => activeProject()?.id, (id) => setRenaming((r) => renamingAfterSwitch(r, id))));
  let card: HTMLDivElement | undefined;
  const startRename = () => {
    setRenaming(activeProject()?.id ?? null);
  };
  const endRename = () => {
    setRenaming(null);
    card?.focus();
  };
  /** Right-click on the project card. */
  const cardMenu = (): MenuItem[] => {
    const p = activeProject();
    if (!p) return [];
    return [
      { label: "Rename project…", icon: "rename", shortcut: "F2", onSelect: startRename },
      { label: "Rescan project", icon: "refresh", onSelect: () => void rescanProject(p.id) },
    ];
  };

  const projectMenu = (anchor: HTMLElement) => {
    const p = activeProject();
    const items: MenuItem[] = [
      { label: "Rename project…", icon: "rename", shortcut: "F2", disabled: !p, onSelect: startRename },
      { label: "Collapse all", icon: "collapse", onSelect: () => { ex.clear(); setFoldersOpen(allFolderIds(), false); } },
      { label: "Show all repositories in the log", icon: "eye", disabled: !isRepoFilterActive(), onSelect: selectAllRepos },
      { separator: true },
      { label: "Rescan project", icon: "refresh", disabled: !p, onSelect: () => p && void rescanProject(p.id) },
      { separator: true },
      { label: "Hide sidebar", shortcut: "Alt+1", onSelect: () => setSidebarVisible(false) },
    ];
    openMenu(anchor, items);
  };

  const renderNode = (n: SidebarNode, info: TreeRowInfo): JSX.Element => {
    switch (n.kind) {
      case "folder": {
        const hidden = () => allHidden(n.repoIds);
        const dot = () => (info.expanded ? "clean" : worstDot(n.repoIds, summary));
        return (
          <span class="dg-sidebar-folder" classList={{ "is-filtered": hidden() }}>
            <button
              type="button"
              class="dg-sidebar-sqbtn"
              tabindex={-1}
              aria-label={hidden() ? `Show the repositories of ${n.label} in the log` : `Hide the repositories of ${n.label} from the log`}
              data-tip={hidden() ? "Show in the log (Alt+click: only these repositories)" : "Hide from the log (Alt+click: only these repositories)"}
              onClick={(e) => {
                e.stopPropagation();
                if (e.altKey) showOnly(n.repoIds);
                else toggleFolder(n.repoIds);
              }}
              onDblClick={(e) => e.stopPropagation()}
            >
              <Icon name={info.expanded ? "folderOpen" : "folder"} size={14} class="dg-sidebar-icon" />
            </button>
            <span class="dg-sidebar-fname" data-tip={n.path}><Hl text={n.label} query={q()} /></span>
            <span class="dg-sidebar-count">{n.repoIds.length}</span>
            <span class="dg-grow" />
            <Show when={dot() !== "clean"}>
              <span class={`dg-sidebar-dot is-${dot()}`} data-tip={dot() === "conflict" ? "A repository has conflicts or an operation in progress" : "A repository has uncommitted changes"} />
            </Show>
          </span>
        );
      }
      case "repo": {
        const s = () => summary(n.repoId);
        const hidden = () => !selectedRepoIds().includes(n.repoId);
        const dot = () => repoDot(s());
        const repo = () => repoById(n.repoId);
        return (
          <span class="dg-sidebar-repo" classList={{ "is-filtered": hidden() }}>
            <button
              type="button"
              class="dg-sidebar-sqbtn"
              tabindex={-1}
              aria-label={hidden() ? `Show ${n.label} in the log` : `Hide ${n.label} from the log`}
              data-tip={hidden() ? "Show in the log (Alt+click: only this repository)" : "Hide from the log (Alt+click: only this repository)"}
              onClick={(e) => {
                e.stopPropagation();
                if (e.altKey) selectOnlyRepo(n.repoId);
                else toggleRepo(n.repoId);
              }}
              onDblClick={(e) => e.stopPropagation()}
            >
              <RepoIcon />
            </button>
            <span class="dg-sidebar-name" data-tip={repo() ? `${repo()!.name}\n${repo()!.path}` : n.label}><Hl text={n.label} query={q()} /></span>
            <RepoBranch repoId={n.repoId} query={q()} />
            <AheadBehind ahead={s()?.ahead ?? 0} behind={s()?.behind ?? 0} upstream={s()?.upstream} />
            <span
              class={`dg-sidebar-dot is-${dot()}`}
              data-tip={dot() === "conflict" ? (stateLabel(s()?.state ?? "clean") ? `${stateLabel(s()!.state)} in progress` : "Conflicts") : dot() === "dirty" ? "Uncommitted changes" : "Clean"}
            />
          </span>
        );
      }
      case "group":
        return (
          <>
            <Icon name={groupIcon[n.group]} class="dg-sidebar-icon" />
            <span class="dg-sidebar-label">{n.label}</span>
            <span class="dg-sidebar-count">{n.count}</span>
          </>
        );
      case "remote":
        return (
          <>
            <Icon name="remote" class="dg-sidebar-icon" />
            <span class="dg-sidebar-label" data-tip={n.label}>{n.label}</span>
            <span class="dg-sidebar-count">{n.count}</span>
          </>
        );
      case "branch":
        return (
          <>
            <Icon name={n.branch.isHead ? "branchCurrent" : "branch"} class={n.branch.isHead ? "dg-sidebar-icon is-current" : "dg-sidebar-icon"} />
            <span class="dg-sidebar-bname" classList={{ "is-current": n.branch.isHead }} data-tip={n.branch.upstream ? `${n.label} tracks ${n.branch.upstream}` : n.label}>
              <Hl text={n.label} query={q()} />
            </span>
            <Show when={n.branch.gone}>
              <span class="dg-sidebar-gone" data-tip={`${n.branch.upstream ?? "The upstream branch"} no longer exists on the remote`}>gone</span>
            </Show>
            <AheadBehind ahead={n.branch.ahead} behind={n.branch.behind} upstream={n.branch.upstream} />
          </>
        );
      case "remoteBranch":
        return (
          <>
            <Icon name="branch" class="dg-sidebar-icon" />
            <span class="dg-sidebar-bname" data-tip={n.remote.fullName}><Hl text={n.label} query={q()} /></span>
          </>
        );
      case "tag":
        return (
          <>
            <Icon name="tag" class="dg-sidebar-icon" />
            <span class="dg-sidebar-bname" data-tip={n.tag.annotated ? `${n.label} (annotated)` : n.label}><Hl text={n.label} query={q()} /></span>
          </>
        );
      case "stash":
        return (
          <>
            <Icon name="stash" class="dg-sidebar-icon" />
            <span class="dg-sidebar-bname" data-tip={n.stash.message}><Hl text={n.label} query={q()} /></span>
            <span class="dg-sidebar-count" data-tip={fullDate(n.stash.time)}>{formatDate(n.stash.time)}</span>
          </>
        );
      case "submodule":
        return (
          <>
            <Icon name="submodule" class="dg-sidebar-icon" />
            <span class="dg-sidebar-bname" data-tip={n.label}><Hl text={n.label} query={q()} /></span>
            <span class="dg-sidebar-count">{n.sub.status.trim() || "ok"}</span>
          </>
        );
      case "more":
        return <span class="dg-sidebar-more">{n.label}</span>;
      case "loading":
        return <span class="dg-sidebar-loading">{n.label}</span>;
    }
  };

  const project = () => activeProject();

  return (
    <div class="dg-sidebar">
      <div class="dg-sidebar-head">
        <span class="dg-sidebar-title">Project</span>
        <span class="dg-grow" />
        <IconButton icon="fetch" label="Fetch all repositories" shortcut="Ctrl+T" onClick={() => void actions.fetchAll()} />
        <IconButton icon="plus" label="Add project folder" onClick={() => void addProject()} />
        <IconButton icon="more" label="More" onClick={(e) => projectMenu(e.currentTarget)} />
      </div>

      {/* keyed by the id: another project gets a new card, and an open name editor goes with the old one */}
      <Show when={project()?.id} keyed>
        {(id) => (
          <Show when={project()?.id === id ? project() : undefined}>
            {(p) => (
              <div
                ref={card}
                class="dg-sidebar-card"
                tabindex={0}
                aria-label={`Project ${p().name}. F2 to rename.`}
                onKeyDown={(e) => {
                  if (e.key === "F2" && e.target === e.currentTarget) {
                    e.preventDefault();
                    startRename();
                  }
                }}
                onContextMenu={(e) => {
                  if (renaming() !== null) return;
                  e.preventDefault();
                  openContextMenu(e, cardMenu());
                }}
              >
                <span class="dg-sidebar-badge" aria-hidden="true">{initials(p().name)}</span>
                <span class="dg-sidebar-card-text">
                  <Show
                    when={renaming() === id}
                    fallback={
                      <b data-tip={`${p().name}\nDouble-click or F2 to rename`} onDblClick={startRename}>
                        {p().name}
                      </b>
                    }
                  >
                    <ProjectNameEditor projectId={id} name={p().name} onDone={endRename} />
                  </Show>
                  <span data-tip={p().path}>{p().path} · {plural(p().repos.length, "repository", "repositories")}</span>
                </span>
              </div>
            )}
          </Show>
        )}
      </Show>

      <Show when={!single()}>
        <div class="dg-sidebar-section">
          <span>Repositories</span>
          <Show when={isRepoFilterActive()}>
            <button type="button" class="dg-sidebar-hint" data-tip="Show all repositories in the log" onClick={selectAllRepos}>
              {selectedRepoIds().length} of {projectRepos().length} shown in log
            </button>
          </Show>
        </div>
      </Show>

      <div class="dg-sidebar-body" onKeyDown={onKeyDown}>
        <Show when={query()}>
          <div class="dg-sidebar-speed" role="status">
            <Icon name="search" size={14} />
            <span class="dg-sidebar-speed-text">{query()}</span>
            <button type="button" class="dg-sidebar-speed-clear" aria-label="Clear search" tabindex={-1} onClick={() => setQuery("")}>
              <Icon name="close" size={12} />
            </button>
          </div>
        </Show>
        <Tree
          roots={roots()}
          rowHeight={cssPx("--dg-sidebar-row-height", 26)}
          getId={(n) => n.id}
          getChildren={(n) => n.children}
          expanded={effectiveExpanded()}
          onExpandedChange={onExpandedChange}
          selectedId={selected()}
          onSelect={select}
          onActivate={activate}
          onContextMenu={(n, e) => {
            const items = nodeMenu(n, { setAll: (f, open) => setFoldersOpen(folderIds([f]), open) });
            if (items.length === 0) return;
            select(n);
            openContextMenu(e, items);
          }}
          ariaLabel="Repositories and branches"
          renderNode={renderNode}
        />
        <Show when={projectRepos().length === 0}>
          <EmptyState icon="repo" title="No repositories">This project has no Git repositories. Rescan it from the menu above.</EmptyState>
        </Show>
        <Show when={q() && roots().length === 0 && projectRepos().length > 0}>
          <div class="dg-sidebar-nomatch">Nothing matches “{query()}”.</div>
        </Show>
      </div>
    </div>
  );
}
