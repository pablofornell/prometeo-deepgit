/**
 * Branch matrix (DESIGN.md 5.14, 11.2): repositories x branches. Select a column to run one branch operation over many
 * repos: checkout, create in the repos that miss it, pull, push, merge, delete.
 */
import { For, type JSX, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import {
  AheadBehind, Button, Checkbox, EmptyState, Icon, IconButton, RepoIcon, SearchField, openDialog, openMenu, plural,
  type MenuItem,
} from "../../components/ui";
import * as actions from "../../state/actions";
import { MISSING_CELL, branchTable, matrixBranch, setMatrixBranch, type BranchCell, type BranchColumn } from "../../state/branchTable";
import { confirmAction } from "../../state/dialogs";
import { notifyRepoChanged } from "../../state/events";
import { cachedRefs, refreshRefs } from "../../state/refs";
import { focusedRepoIdSignal, projectRepos, refreshSummaries, setFocusedRepoId, summary } from "../../state/workspace";
import { UpstreamPushDialog } from "./UpstreamPushDialog";
import { columnLacksUpstream, lacksUpstream } from "./upstreamPush";
import "./matrix.css";

/** Columns drawn at most; the filter narrows the rest. */
const MAX_COLUMNS = 150;
const DEFAULT_BRANCHES = ["main", "master", "develop", "trunk"];

const stateWord: Record<BranchCell["state"], string> = { current: "checked out", local: "local", remote: "only on origin", missing: "missing" };

export function BranchMatrix(): JSX.Element {
  const [filter, setFilter] = createSignal("");
  const [onlyShared, setOnlyShared] = createSignal(true);
  const [onlyNoUpstream, setOnlyNoUpstream] = createSignal(false);
  const [running, setRunning] = createSignal<string | null>(null);
  const [failed, setFailed] = createSignal<Record<string, string>>({});
  let scroller: HTMLDivElement | undefined;

  const repos = projectRepos;
  const multi = () => repos().length > 1;
  const shared = () => multi() && onlyShared();
  const busy = (repoId: string) => (summary(repoId)?.state ?? "clean") !== "clean";

  const columns = createMemo<BranchColumn[]>(() => {
    const q = filter().trim().toLowerCase();
    const sel = matrixBranch();
    return branchTable().filter(
      (c) => c.name === sel || ((!shared() || c.present >= 2) && (!onlyNoUpstream() || columnLacksUpstream(c)) && (!q || c.name.toLowerCase().includes(q))),
    );
  });
  const shown = createMemo(() => columns().slice(0, MAX_COLUMNS));
  const selected = createMemo(() => branchTable().find((c) => c.name === matrixBranch()));

  // keep the selected column in view
  createEffect(
    on(matrixBranch, (name) => {
      if (!name) return;
      queueMicrotask(() => scroller?.querySelector<HTMLElement>(`[data-col="${CSS.escape(name)}"]`)?.scrollIntoView({ block: "nearest", inline: "center" }));
    }),
  );

  const select = (name: string | null) => {
    if (name !== matrixBranch()) setFailed({});
    setMatrixBranch(name);
  };

  // ---------------------------------------------------------------- batch plumbing

  /** Runs a batch on one column: the sweep line moves while it runs and failed cells keep a red ring. */
  const run = async (name: string, job: () => Promise<actions.BatchResult[]>) => {
    setRunning(name);
    setFailed({});
    try {
      const results = await job();
      const bad: Record<string, string> = {};
      for (const r of results) {
        for (const f of r.failed) bad[f.repoId] = f.error.message;
        for (const id of r.conflicts) bad[id] = "Stopped with conflicts";
      }
      setFailed(bad);
    } finally {
      setRunning(null);
    }
  };

  const idsWhere = (col: BranchColumn, pred: (cell: BranchCell) => boolean): string[] =>
    repos().filter((r) => !busy(r.id) && pred(col.cells[r.id] ?? MISSING_CELL)).map((r) => r.id);

  const name = (id: string) => repos().find((r) => r.id === id)?.name ?? id;

  const defaultBranch = (repoId: string): string => {
    const names = cachedRefs(repoId)?.local.map((b) => b.name) ?? [];
    return DEFAULT_BRANCHES.find((n) => names.includes(n)) ?? summary(repoId)?.branch ?? "HEAD";
  };

  const dirtyCount = (ids: string[]) => ids.filter((id) => (summary(id)?.staged ?? 0) + (summary(id)?.unstaged ?? 0) > 0).length;

  // ---------------------------------------------------------------- operations

  const checkoutIn = async (col: BranchColumn, ids: string[]) => {
    if (ids.length > 1) {
      const dirty = dirtyCount(ids);
      const ok = await confirmAction({
        title: `Checkout ${col.name}`,
        message: [
          `Check out ${col.name} in ${plural(ids.length, "repo")}. Repos where it exists only on origin get a tracking branch.`,
          ...(dirty > 0 ? [`${plural(dirty, "repo")} ha${dirty === 1 ? "s" : "ve"} uncommitted changes. Git keeps them unless they conflict with the branch.`] : []),
        ],
        confirmLabel: `Checkout in ${plural(ids.length, "repo")}`,
        command: ids.map((id) => (col.cells[id].state === "remote" ? `git -C ${name(id)} checkout -b ${col.name} --track origin/${col.name}` : `git -C ${name(id)} checkout ${col.name}`)),
      });
      if (!ok) return;
    }
    await run(col.name, async () => [await actions.checkout(ids, col.name, { branchOnly: true })]);
  };

  const createIn = async (col: BranchColumn, ids: string[], base: string | null) => {
    const baseOf = (id: string) => (base && branchTable().find((c) => c.name === base)?.cells[id]?.state !== "missing" ? base : defaultBranch(id));
    const groups = new Map<string, string[]>();
    for (const id of ids) groups.set(baseOf(id), [...(groups.get(baseOf(id)) ?? []), id]);
    const ok = await confirmAction({
      title: `Create ${col.name}`,
      message: `Create ${col.name} in ${plural(ids.length, "repo")} that ${ids.length === 1 ? "does" : "do"} not have it. The branches are created but not checked out.`,
      confirmLabel: `Create in ${plural(ids.length, "repo")}`,
      command: ids.map((id) => `git -C ${name(id)} branch ${col.name} ${baseOf(id)}`),
    });
    if (!ok) return;
    await run(col.name, async () => {
      const out: actions.BatchResult[] = [];
      for (const [startPoint, group] of groups) out.push(await actions.createBranch(group, startPoint, { name: col.name, checkout: false, startLabel: startPoint }));
      return out;
    });
  };

  const createMenu = (anchor: HTMLElement, col: BranchColumn, ids: string[]) => {
    const others = branchTable().filter((c) => c.name !== col.name && c.present >= 2).slice(0, 8);
    const items: MenuItem[] = [
      { label: "Create from", heading: true },
      { label: "Default branch of each repository", icon: "branch", onSelect: () => void createIn(col, ids, null) },
      ...(others.length > 0 ? ([{ separator: true }, ...others.map((o): MenuItem => ({ label: o.name, icon: "branch", shortcut: `${o.present}/${repos().length}`, onSelect: () => void createIn(col, ids, o.name) }))] as MenuItem[]) : []),
    ];
    openMenu(anchor, items);
  };

  /** Opens the dialog; it runs the pushes and reports to the matrix (sweep line on the column, red rings on failures). */
  const pushSetUpstream = async (col: BranchColumn, ids: string[]) => {
    await openDialog(UpstreamPushDialog, {
      branch: col.name,
      repoIds: ids,
      onStart: () => {
        setRunning(col.name);
        setFailed({});
      },
      onRepoDone: (repoId: string, error: string | null) => {
        if (error) setFailed((f) => ({ ...f, [repoId]: error }));
      },
      onEnd: () => setRunning(null),
    });
  };

  const refresh = async () => {
    await Promise.all(repos().map((r) => refreshRefs(r.id)));
    for (const r of repos()) notifyRepoChanged(r.id);
    void refreshSummaries();
  };

  // ---------------------------------------------------------------- keyboard

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const list = shown();
    const i = list.findIndex((c) => c.name === matrixBranch());
    if (e.key === "ArrowRight" && list.length > 0) {
      e.preventDefault();
      select(list[Math.min(list.length - 1, i + 1)].name);
    } else if (e.key === "ArrowLeft" && list.length > 0) {
      e.preventDefault();
      select(list[Math.max(0, i - 1)].name);
    } else if (e.key === "Escape" && i >= 0) {
      e.preventDefault();
      e.stopPropagation();
      select(null);
    }
  };

  // ---------------------------------------------------------------- render

  const glyph = (cell: BranchCell, repoId: string, rowBusy: boolean): JSX.Element => (
    <i class="dg-matrix-glyph" classList={{ [`is-${rowBusy && cell.state !== "missing" ? "busy" : cell.state}`]: true, "is-failed": repoId in failed() }} />
  );

  const cellTip = (repoId: string, col: BranchColumn, cell: BranchCell): string => {
    const base = `${name(repoId)}: ${col.name} is ${stateWord[cell.state]}`;
    const extra: string[] = [];
    if (cell.gone) extra.push("its upstream was deleted");
    if (cell.ahead > 0) extra.push(`${plural(cell.ahead, "commit")} to push`);
    if (cell.behind > 0) extra.push(`${plural(cell.behind, "commit")} to pull`);
    if (busy(repoId) && cell.state !== "missing") extra.push(`${summary(repoId)?.state} in progress, batch operations skip this repository`);
    const err = failed()[repoId];
    return [base + (extra.length ? ". " + extra.join(", ") : ""), lacksUpstream(cell) ? "No upstream. Push it to set one." : "", err ? `Failed: ${err}` : ""].filter(Boolean).join("\n");
  };

  const ActionBar = (props: { col: BranchColumn }): JSX.Element => {
    const col = () => props.col;
    const checkoutIds = () => idsWhere(col(), (c) => c.state !== "missing");
    const createIds = () => idsWhere(col(), (c) => c.state === "missing");
    const pullIds = () => idsWhere(col(), (c) => c.state === "current");
    const pushIds = () => idsWhere(col(), (c) => (c.state === "current" || c.state === "local") && c.ahead > 0);
    const upstreamIds = () => idsWhere(col(), lacksUpstream);
    const mergeIds = () => idsWhere(col(), (c) => c.state === "local");
    const deleteIds = () => idsWhere(col(), (c) => c.state === "local");
    const skipped = () => repos().filter((r) => busy(r.id) && col().cells[r.id]?.state !== "missing").length;
    const working = () => running() !== null;
    let createBtn: HTMLButtonElement | undefined;
    return (
      <div class="dg-matrix-bar" role="toolbar" aria-label={`Operations on ${col().name}`}>
        <span class="dg-matrix-bar-title" title={col().name}>{col().name}</span>
        <span class="dg-matrix-bar-sum">
          {col().current} current · {col().remoteOnly} on origin · {col().missing} missing
          <Show when={skipped() > 0}> · {skipped()} skipped (operation in progress)</Show>
        </span>
        <Button variant="primary" icon="checkout" disabled={working() || checkoutIds().length === 0} title={checkoutIds().length === 0 ? "No repository has this branch" : "Includes repositories where the branch exists only on origin: they get a tracking branch"} onClick={() => void checkoutIn(col(), checkoutIds())}>
          Checkout in {plural(checkoutIds().length, "repo")}
        </Button>
        <button
          type="button"
          ref={createBtn}
          class="dg-btn dg-btn-default"
          disabled={working() || createIds().length === 0}
          data-tip={createIds().length === 0 ? "Every repository already has this branch" : undefined}
          onClick={() => createBtn && createMenu(createBtn, col(), createIds())}
        >
          <Icon name="newBranch" size={14} />
          Create in {createIds().length} missing {createIds().length === 1 ? "repo" : "repos"} from…
        </button>
        <Button icon="pull" disabled={working() || pullIds().length === 0} title={pullIds().length === 0 ? "Pull works on the checked-out branch" : undefined} onClick={() => void run(col().name, async () => [await actions.pull(pullIds())])}>
          Pull in {plural(pullIds().length, "repo")}
        </Button>
        <Button icon="push" disabled={working() || pushIds().length === 0} title={pushIds().length === 0 ? "No commits to push" : undefined} onClick={() => void run(col().name, async () => [await actions.push(pushIds(), { branch: col().name })])}>
          Push in {plural(pushIds().length, "repo")}
        </Button>
        <Show when={upstreamIds().length > 0}>
          <Button icon="push" disabled={working()} onClick={() => void pushSetUpstream(col(), upstreamIds())}>
            Push and set upstream in {plural(upstreamIds().length, "repo")}
          </Button>
        </Show>
        <Button icon="merge" disabled={working() || mergeIds().length === 0} title={mergeIds().length === 0 ? "Needs a local branch that is not checked out" : `Merge ${col().name} into the checked-out branch of each repository`} onClick={() => void run(col().name, async () => [await actions.merge(mergeIds(), col().name)])}>
          Merge into current
        </Button>
        <Button variant="danger" icon="delete" disabled={working() || deleteIds().length === 0} title={deleteIds().length === 0 ? "A checked-out branch cannot be deleted" : undefined} onClick={() => void run(col().name, async () => [await actions.deleteBranch(deleteIds(), col().name)])}>
          Delete in {plural(deleteIds().length, "repo")}…
        </Button>
      </div>
    );
  };

  const colIndex = (n: string) => shown().findIndex((c) => c.name === n);

  return (
    <div class="dg-matrix" onKeyDown={onKeyDown}>
      <div class="dg-matrix-toolbar">
        <SearchField size="filter" class="dg-matrix-filter" value={filter()} onInput={setFilter} placeholder="Filter branches" aria-label="Filter branches" />
        <Show when={multi()}>
          <Checkbox checked={onlyShared()} onChange={setOnlyShared} label="Only branches in 2+ repos" />
        </Show>
        <Checkbox checked={onlyNoUpstream()} onChange={setOnlyNoUpstream} label="Only branches without upstream" />
        <span class="dg-matrix-count">
          {plural(columns().length, "branch", "branches")} · {plural(repos().length, "repo")}
          <Show when={columns().length > MAX_COLUMNS}> · showing {MAX_COLUMNS}</Show>
        </span>
        <span class="dg-grow" />
        <span class="dg-matrix-legend">
          <span><i class="dg-matrix-glyph is-current" />checked out</span>
          <span><i class="dg-matrix-glyph is-local" />local</span>
          <span><i class="dg-matrix-glyph is-remote" />only on origin</span>
          <span><i class="dg-matrix-glyph is-missing" />missing</span>
        </span>
        <IconButton icon="refresh" label="Reload branches" onClick={() => void refresh()} />
      </div>

      <Show
        when={shown().length > 0 && repos().length > 0}
        fallback={
          <EmptyState
            icon="matrix"
            title={filter() || !shared() || onlyNoUpstream() ? "No matching branches" : "No branch is shared yet"}
            actions={shared() ? <Button size="small" onClick={() => setOnlyShared(false)}>Show every branch</Button> : undefined}
          >
            {filter()
              ? "No branch name contains the filter text."
              : onlyNoUpstream()
                ? "No local branch without an upstream."
                : "Branches that exist in two or more repositories appear here."}
          </EmptyState>
        }
      >
        <div class="dg-matrix-scroll" ref={scroller} tabindex={0} role="grid" aria-label="Branch matrix">
          <div class="dg-matrix-grid" style={{ "grid-template-columns": `var(--dg-matrix-repo-col-width) repeat(${shown().length}, var(--dg-matrix-col-width))` }}>
            <div class="dg-matrix-corner" role="columnheader">Repository</div>
            <For each={shown()}>
              {(c) => (
                <button
                  type="button"
                  role="columnheader"
                  class="dg-matrix-colhead"
                  classList={{ "is-selected": c.name === matrixBranch() }}
                  data-col={c.name}
                  aria-selected={c.name === matrixBranch()}
                  data-tip={c.name}
                  onClick={() => select(c.name === matrixBranch() ? null : c.name)}
                >
                  <span class="dg-matrix-colname">{c.name}</span>
                  <span class="dg-matrix-colcount">{c.present}/{repos().length}</span>
                </button>
              )}
            </For>

            <For each={repos()}>
              {(r) => {
                const rowBusy = () => busy(r.id);
                return (
                  <>
                    <button
                      type="button"
                      role="rowheader"
                      class="dg-matrix-rowhead"
                      classList={{ "is-focused": r.id === focusedRepoIdSignal() }}
                      onClick={() => setFocusedRepoId(r.id)}
                    >
                      <RepoIcon />
                      <span class="dg-matrix-rname" data-tip={`${r.name}\n${r.path}`}>{r.name}</span>
                      <span class="dg-matrix-rbranch" data-tip={summary(r.id)?.branch ?? undefined}>{summary(r.id)?.branch ?? ""}</span>
                    </button>
                    <For each={shown()}>
                      {(c) => {
                        const cell = () => c.cells[r.id] ?? MISSING_CELL;
                        return (
                          <button
                            type="button"
                            role="gridcell"
                            class="dg-matrix-cell"
                            classList={{ "is-selected": c.name === matrixBranch() }}
                            data-tip={cellTip(r.id, c, cell())}
                            onClick={() => {
                              setFocusedRepoId(r.id);
                              select(c.name);
                            }}
                            onDblClick={() => {
                              if (cell().state !== "missing" && cell().state !== "current" && !rowBusy()) void run(c.name, async () => [await actions.checkout(r.id, c.name, { branchOnly: true })]);
                            }}
                          >
                            {glyph(cell(), r.id, rowBusy())}
                            <Show when={cell().state !== "missing" && cell().state !== "remote"}>
                              <AheadBehind ahead={cell().ahead} behind={cell().behind} />
                            </Show>
                          </button>
                        );
                      }}
                    </For>
                  </>
                );
              }}
            </For>
            <Show when={running() && colIndex(running()!) >= 0}>
              <span
                class="dg-matrix-sweep"
                style={{ "--rows": repos().length, "--col": colIndex(running()!) }}
                aria-hidden="true"
              />
            </Show>
          </div>
        </div>
      </Show>

      <Show when={selected()}>{(c) => <ActionBar col={c()} />}</Show>
    </div>
  );
}
