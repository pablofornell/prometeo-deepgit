/**
 * Branch popup of the title bar (DESIGN.md 5.20 rule 5, 11.2): synchronous branch control. Lists the branches of the
 * whole project with the repos that have each one; Enter checks the branch out in every repo that has it, `→` expands the
 * per-repo list, right click opens the branch menu. Sections: Recent, Local, Remote, Tags.
 */
import { For, type JSX, Show, createEffect, createMemo, createSignal, on, onMount } from "solid-js";
import { AheadBehind, Icon, Popup, RepoIcon, SearchField, openContextMenu, plural, type MenuItem } from "../../components/ui";
import * as actions from "../../state/actions";
import { branchTable, setMatrixBranch, type BranchColumn } from "../../state/branchTable";
import { showDialog } from "../../state/dialogs";
import { openBottomTool } from "../../state/layout";
import { loadPersisted, savePersisted } from "../../state/persist";
import { cachedRefs, repoRefs } from "../../state/refs";
import { jumpToCommit } from "../../state/selection";
import { activeProject, focusedRepo, projectRepos, repoById } from "../../state/workspace";

type Section = "recent" | "local" | "remote" | "tags";

type Row =
  | { kind: "heading"; id: string; label: string; count: number }
  | { kind: "branch"; id: string; col: BranchColumn; section: Section }
  | { kind: "repo"; id: string; col: BranchColumn; repoId: string }
  | { kind: "tag"; id: string; name: string; repoIds: string[] }
  | { kind: "more"; id: string; section: Section; hidden: number }
  | { kind: "create"; id: string; name: string }
  | { kind: "rev"; id: string; name: string };

const LIMIT: Record<Section, number> = { recent: 5, local: 12, remote: 8, tags: 8 };
const LIMIT_SEARCH = 50;
const MAX_DOTS = 8;

const selectable = (r: Row) => r.kind !== "heading";

function Highlight(props: { text: string; query: string }): JSX.Element {
  const parts = () => {
    const q = props.query.trim().toLowerCase();
    const i = q ? props.text.toLowerCase().indexOf(q) : -1;
    return i < 0 ? null : ([props.text.slice(0, i), props.text.slice(i, i + q.length), props.text.slice(i + q.length)] as const);
  };
  return (
    <Show when={parts()} fallback={props.text}>
      {(p) => (
        <>
          {p()[0]}
          <mark class="dg-titlebar-match">{p()[1]}</mark>
          {p()[2]}
        </>
      )}
    </Show>
  );
}

const cellLabel = { current: "checked out", local: "local", remote: "only on origin", missing: "missing" } as const;

/** Menu of one branch name over the repos that have it (DESIGN.md 5.11). */
function branchMenu(col: BranchColumn, close: () => void): MenuItem[] {
  const repos = projectRepos();
  const multi = repos.length > 1;
  const present = repos.filter((r) => col.cells[r.id]?.state !== "missing").map((r) => r.id);
  const local = repos.filter((r) => col.cells[r.id]?.state === "local").map((r) => r.id);
  const localAny = repos.filter((r) => col.cells[r.id]?.state === "local" || col.cells[r.id]?.state === "current").map((r) => r.id);
  const allCurrent = col.current === present.length;
  const items: MenuItem[] = [
    {
      label: multi ? `Checkout ${col.name} in ${plural(present.length, "repo")}` : `Checkout ${col.name}`,
      icon: "checkout",
      disabled: allCurrent,
      tooltip: allCurrent ? "Already checked out" : undefined,
      onSelect: () => {
        close();
        void actions.checkout(present, col.name, { branchOnly: true });
      },
    },
  ];
  if (multi) {
    items.push({
      label: "Checkout in…",
      icon: "checkout",
      submenu: repos
        .filter((r) => col.cells[r.id]?.state !== "missing")
        .map((r) => ({
          label: r.name,
          shortcut: cellLabel[col.cells[r.id].state],
          disabled: col.cells[r.id].state === "current",
          onSelect: () => {
            close();
            void actions.checkout(r.id, col.name, { branchOnly: true });
          },
        })),
    });
  }
  items.push(
    { label: `New branch from ${col.name}…`, icon: "newBranch", onSelect: () => { close(); void actions.createBranch(present, col.name, { startLabel: col.name }); } },
    { separator: true },
    { label: `Merge ${col.name} into the current branch`, icon: "merge", disabled: local.length === 0, onSelect: () => { close(); void actions.merge(local, col.name); } },
    { label: `Rebase the current branch onto ${col.name}`, icon: "rebase", disabled: local.length === 0, onSelect: () => { close(); void actions.rebase(local, col.name); } },
    { separator: true },
    { label: "Push…", icon: "push", disabled: localAny.length === 0, onSelect: () => { close(); void actions.push(localAny, { branch: col.name }); } },
    { label: multi ? `Delete in ${plural(local.length, "repo")}…` : "Delete…", icon: "delete", danger: true, disabled: local.length === 0, tooltip: local.length === 0 ? "A checked-out branch cannot be deleted" : undefined, onSelect: () => { close(); void actions.deleteBranch(local, col.name); } },
  );
  return items;
}

function PopupBody(props: { onClose: () => void }): JSX.Element {
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(0);
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
  const [opened, setOpened] = createSignal<ReadonlySet<Section>>(new Set());
  const [revMode, setRevMode] = createSignal(false);
  let input: HTMLInputElement | undefined;
  let list: HTMLDivElement | undefined;

  const multi = () => projectRepos().length > 1;
  const recentKey = () => "recentBranches." + (activeProject()?.id ?? "none");
  const q = () => query().trim();
  const matches = (n: string) => !q() || n.toLowerCase().includes(q().toLowerCase());

  const tagTable = createMemo(() => {
    const m = new Map<string, string[]>();
    for (const r of projectRepos()) {
      for (const t of repoRefs(r.id)()?.tags ?? []) m.set(t.name, [...(m.get(t.name) ?? []), r.id]);
    }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  });

  const limit = (s: Section) => (opened().has(s) ? Infinity : q() ? LIMIT_SEARCH : LIMIT[s]);

  const rows = createMemo<Row[]>(() => {
    const out: Row[] = [];
    const cols = branchTable();
    const section = (s: Section, label: string, items: Row[]) => {
      if (items.length === 0) return;
      out.push({ kind: "heading", id: `h:${s}`, label, count: items.length });
      const max = limit(s);
      out.push(...items.slice(0, max));
      if (items.length > max) out.push({ kind: "more", id: `more:${s}`, section: s, hidden: items.length - max });
    };
    const branchRows = (list: BranchColumn[], s: Section): Row[] => list.map((col) => ({ kind: "branch", id: `${s}:${col.name}`, col, section: s }));
    const tagRows = (): Row[] => tagTable().filter(([n]) => matches(n)).map(([name, repoIds]) => ({ kind: "tag", id: `tag:${name}`, name, repoIds }));

    if (revMode()) {
      section("tags", "Tags", tagRows());
      if (q()) out.push({ kind: "rev", id: "rev", name: q() });
      return out;
    }
    if (q() && !cols.some((c) => c.name === q())) out.push({ kind: "create", id: "create", name: q() });
    if (!q()) {
      const recent = loadPersisted<string[]>(recentKey(), []).map((n) => cols.find((c) => c.name === n)).filter((c): c is BranchColumn => !!c);
      section("recent", "Recent", branchRows(recent, "recent"));
    }
    const hasLocal = (c: BranchColumn) => c.current + c.local > 0;
    section("local", "Local", branchRows(cols.filter((c) => hasLocal(c) && matches(c.name)), "local"));
    section("remote", "Remote", branchRows(cols.filter((c) => !hasLocal(c) && matches(c.name)), "remote"));
    if (q()) section("tags", "Tags", tagRows());
    return out;
  });

  // expanded per-repo rows are spliced in after their branch row
  const visible = createMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const r of rows()) {
      out.push(r);
      if (r.kind === "branch" && expanded().has(r.id)) {
        for (const repo of projectRepos()) if (r.col.cells[repo.id]?.state !== "missing") out.push({ kind: "repo", id: `${r.id}:${repo.id}`, col: r.col, repoId: repo.id });
      }
    }
    return out;
  });

  const firstSelectable = (from: number, dir: 1 | -1): number => {
    const list = visible();
    for (let i = from; i >= 0 && i < list.length; i += dir) if (selectable(list[i])) return i;
    return -1;
  };

  createEffect(
    on([query, revMode], () => {
      // the "New branch" row comes first, but Enter should pick the best match when there is one
      const start = visible()[0]?.kind === "create" ? firstSelectable(1, 1) : -1;
      setActive(Math.max(0, start >= 0 ? start : firstSelectable(0, 1)));
    }),
  );

  const scrollActive = () =>
    queueMicrotask(() => list?.querySelector<HTMLElement>(".is-active")?.scrollIntoView({ block: "nearest" }));

  const move = (dir: 1 | -1) => {
    const i = firstSelectable(active() + dir, dir);
    if (i >= 0) {
      setActive(i);
      scrollActive();
    }
  };

  const remember = (name: string) => {
    const next = [name, ...loadPersisted<string[]>(recentKey(), []).filter((n) => n !== name)].slice(0, LIMIT.recent);
    savePersisted(recentKey(), next);
  };

  /** Selects the tip of a branch or tag in the log (and pulses its node): the focused repo when it has it, else the first one. */
  const jumpToTip = (repoIds: string[], name: string) => {
    const tip = (id: string): string | undefined => {
      const refs = cachedRefs(id);
      return refs?.local.find((b) => b.name === name)?.oid ?? refs?.remote.find((b) => b.fullName === name || b.name === name)?.oid ?? refs?.tags.find((t) => t.name === name)?.oid;
    };
    const focused = focusedRepo()?.id;
    const ordered = focused && repoIds.includes(focused) ? [focused, ...repoIds.filter((id) => id !== focused)] : repoIds;
    for (const id of ordered) {
      const oid = tip(id);
      if (oid) return jumpToCommit({ repoId: id, oid });
    }
  };

  const checkoutBranch = (col: BranchColumn) => {
    const ids = projectRepos().filter((r) => col.cells[r.id]?.state !== "missing").map((r) => r.id);
    jumpToTip(ids, col.name);
    remember(col.name);
    props.onClose();
    void actions.checkout(ids, col.name, { branchOnly: true });
  };

  const newBranch = async (suggestedName?: string) => {
    const ids = projectRepos().map((r) => r.id);
    props.onClose();
    const r = await showDialog("newBranch", { repoIds: ids, startPoint: "HEAD", startLabel: "HEAD", suggestedName });
    if (r) await actions.createBranch(r.repoIds.length > 0 ? r.repoIds : ids, "HEAD", { name: r.name, checkout: r.checkout });
  };

  const activate = (row: Row | undefined) => {
    if (!row) return;
    switch (row.kind) {
      case "branch":
        checkoutBranch(row.col);
        break;
      case "repo":
        jumpToTip([row.repoId], row.col.name);
        remember(row.col.name);
        props.onClose();
        void actions.checkout(row.repoId, row.col.name, { branchOnly: true });
        break;
      case "tag":
        jumpToTip(row.repoIds, row.name);
        props.onClose();
        void actions.checkout(row.repoIds, row.name);
        break;
      case "rev": {
        const r = focusedRepo();
        props.onClose();
        if (r) void actions.checkout(r.id, row.name);
        break;
      }
      case "create":
        void newBranch(row.name);
        break;
      case "more":
        setOpened(new Set([...opened(), row.section]));
        break;
    }
  };

  const toggleExpand = (id: string, on?: boolean) => {
    const next = new Set(expanded());
    const open = on ?? !next.has(id);
    if (open) next.add(id);
    else next.delete(id);
    setExpanded(next);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const row = visible()[active()];
    const el = e.currentTarget as HTMLInputElement;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        break;
      case "Enter":
        e.preventDefault();
        activate(row);
        break;
      case "ArrowRight":
        if (row?.kind === "branch" && multi() && el.selectionStart === el.value.length) {
          e.preventDefault();
          toggleExpand(row.id, true);
        }
        break;
      case "ArrowLeft":
        if (row?.kind === "repo" && el.selectionStart === 0) {
          e.preventDefault();
          const parent = visible().findIndex((r) => r.kind === "branch" && row.id.startsWith(r.id + ":"));
          if (parent >= 0) {
            toggleExpand(visible()[parent].id, false);
            setActive(parent);
          }
        } else if (row?.kind === "branch" && expanded().has(row.id) && el.selectionStart === 0) {
          e.preventDefault();
          toggleExpand(row.id, false);
        }
        break;
    }
  };

  onMount(() => queueMicrotask(() => input?.focus()));

  const dots = (col: BranchColumn) => projectRepos().filter((r) => col.cells[r.id]?.state !== "missing");

  const renderRow = (row: Row, i: () => number): JSX.Element => {
    const isActive = () => i() === active();
    const common = { onMouseMove: () => active() !== i() && setActive(i()) };
    switch (row.kind) {
      case "heading":
        return (
          <div class="dg-titlebar-pop-head">
            {row.label} <span class="dg-titlebar-pop-count">{row.count}</span>
          </div>
        );
      case "branch": {
        const col = row.col;
        const total = projectRepos().length;
        const first = () => (!multi() ? Object.values(col.cells)[0] : undefined);
        return (
          <div
            class="dg-titlebar-brow"
            classList={{ "is-active": isActive(), "is-current": col.current > 0 }}
            role="option"
            aria-selected={isActive()}
            onClick={() => activate(row)}
            onContextMenu={(e) => openContextMenu(e, branchMenu(col, props.onClose))}
            {...common}
          >
            <Icon name={col.current > 0 ? "branchCurrent" : row.section === "remote" ? "remote" : "branch"} class="dg-titlebar-brow-ic" />
            <span class="dg-titlebar-brow-name">
              <Highlight text={col.name} query={query()} />
            </span>
            <Show
              when={multi()}
              fallback={
                <>
                  <Show when={first()?.gone}>
                    <span class="dg-titlebar-gone">gone</span>
                  </Show>
                  <AheadBehind ahead={first()?.ahead ?? 0} behind={first()?.behind ?? 0} />
                </>
              }
            >
              <span class="dg-titlebar-dots" title={dots(col).map((r) => `${r.name}: ${cellLabel[col.cells[r.id].state]}`).join("\n")}>
                <For each={dots(col).slice(0, MAX_DOTS)}>
                  {(r) => <i class={`dg-titlebar-rdot is-${col.cells[r.id].state}`} />}
                </For>
                <Show when={dots(col).length > MAX_DOTS}>
                  <span class="dg-titlebar-pop-count">+{dots(col).length - MAX_DOTS}</span>
                </Show>
              </span>
              <span class="dg-titlebar-pop-count dg-titlebar-brow-n">
                {col.present}/{total}
              </span>
              <button
                type="button"
                class="dg-titlebar-brow-exp"
                classList={{ "is-open": expanded().has(row.id) }}
                aria-label="Show repositories"
                tabindex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleExpand(row.id);
                }}
              >
                <Icon name="chevronRight" size={14} />
              </button>
            </Show>
          </div>
        );
      }
      case "repo": {
        const repo = () => repoById(row.repoId);
        const cell = () => row.col.cells[row.repoId];
        return (
          <div
            class="dg-titlebar-brow dg-titlebar-brow-sub"
            classList={{ "is-active": isActive() }}
            role="option"
            aria-selected={isActive()}
            onClick={() => activate(row)}
            {...common}
          >
            <RepoIcon />
            <span class="dg-titlebar-brow-name">{repo()?.name}</span>
            <span class="dg-titlebar-pop-count">{cellLabel[cell().state]}</span>
            <AheadBehind ahead={cell().ahead} behind={cell().behind} />
          </div>
        );
      }
      case "tag":
        return (
          <div class="dg-titlebar-brow" classList={{ "is-active": isActive() }} role="option" aria-selected={isActive()} onClick={() => activate(row)} {...common}>
            <Icon name="tag" class="dg-titlebar-brow-ic" />
            <span class="dg-titlebar-brow-name">
              <Highlight text={row.name} query={query()} />
            </span>
            <Show when={multi()}>
              <span class="dg-titlebar-pop-count dg-titlebar-brow-n">
                {row.repoIds.length}/{projectRepos().length}
              </span>
            </Show>
          </div>
        );
      case "more":
        return (
          <div class="dg-titlebar-brow dg-titlebar-brow-more" classList={{ "is-active": isActive() }} onClick={() => activate(row)} {...common}>
            {row.hidden} more…
          </div>
        );
      case "create":
        return (
          <div class="dg-titlebar-brow" classList={{ "is-active": isActive() }} role="option" aria-selected={isActive()} onClick={() => activate(row)} {...common}>
            <Icon name="newBranch" class="dg-titlebar-brow-ic" />
            <span class="dg-titlebar-brow-name">
              New branch <b>{row.name}</b>…
            </span>
          </div>
        );
      case "rev":
        return (
          <div class="dg-titlebar-brow" classList={{ "is-active": isActive() }} role="option" aria-selected={isActive()} onClick={() => activate(row)} {...common}>
            <Icon name="commit" class="dg-titlebar-brow-ic" />
            <span class="dg-titlebar-brow-name">
              Checkout <b>{row.name}</b> in {focusedRepo()?.name}
            </span>
          </div>
        );
    }
  };

  return (
    <div class="dg-titlebar-pop">
      <div class="dg-titlebar-pop-search">
        <SearchField
          size="filter"
          value={query()}
          onInput={setQuery}
          placeholder={revMode() ? "Tag, commit hash or any revision" : multi() ? "Search branches in all repositories" : "Search branches"}
          inputRef={(el) => (input = el)}
          onKeyDown={onKeyDown}
          aria-label="Search branches"
        />
      </div>
      <div class="dg-titlebar-pop-list" ref={list} role="listbox">
        <For each={visible()}>{(row, i) => renderRow(row, i)}</For>
        <Show when={visible().length === 0}>
          <div class="dg-titlebar-pop-empty">{branchTable().length === 0 ? "Loading branches…" : "No matching branches."}</div>
        </Show>
      </div>
      <div class="dg-titlebar-pop-foot">
        <button type="button" class="dg-titlebar-pop-action" onClick={() => void newBranch(q() || undefined)}>
          <Icon name="newBranch" />
          New branch…
          <Show when={multi()}>
            <span class="dg-titlebar-pop-count">in {plural(projectRepos().length, "repo")}</span>
          </Show>
        </button>
        <button
          type="button"
          class="dg-titlebar-pop-action"
          onClick={() => {
            setRevMode(!revMode());
            setQuery("");
            input?.focus();
          }}
        >
          <Icon name="tag" />
          {revMode() ? "Back to branches" : "Checkout tag or revision…"}
        </button>
        <button
          type="button"
          class="dg-titlebar-pop-action"
          onClick={() => {
            props.onClose();
            setMatrixBranch(null);
            openBottomTool("matrix");
          }}
        >
          <Icon name="matrix" />
          Open branch matrix
          <span class="dg-titlebar-pop-count">Alt+2</span>
        </button>
      </div>
    </div>
  );
}

export function BranchPopup(props: { open: boolean; anchor: () => HTMLElement | undefined; onClose: () => void }): JSX.Element {
  return (
    <Popup open={props.open} anchor={props.anchor} onClose={props.onClose} class="dg-titlebar-branchpop" label="Branches">
      <PopupBody onClose={props.onClose} />
    </Popup>
  );
}
