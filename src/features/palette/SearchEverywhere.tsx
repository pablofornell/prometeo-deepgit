/**
 * Search Everywhere (DESIGN.md 5.15): one popup to jump to actions, branches, files, commits and repos.
 * Opens on Shift Shift and Ctrl+K (Ctrl+Shift+A opens the Actions tab). Mounted once by `App`.
 */
import { type JSX, For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js";
import {
  AheadBehind, Icon, Kbd, RepoChip, RepoSquare, Spinner, fileIconFor, hasOpenDialog, shortOid, splitPath, StatusLetter,
} from "../../components/ui";
import { keysFor, register, unregister } from "../../state/keymap";
import { anyRepoVersion } from "../../state/events";
import { summary, projectRepos, repoById, repoColor, selectedRepoIds } from "../../state/workspace";
import { segments } from "./fuzzy";
import { TABS, type Scope, cycleTab, parseQuery, placeholderFor } from "./query";
import { loadRecent, saveRecent, withRecent } from "./recent";
import { type Hit, type Row, buildRows } from "./results";
import {
  type BranchItem, type CommitItem, type FileItem, type PaletteItem, type RepoItem, actionItems, activate, branchItems, loadFiles,
  repoItems, searchCommits,
} from "./sources";
import "./palette.css";

const [open, setOpen] = createSignal(false);
const [tab, setTab] = createSignal<Scope>("all");
const [raw, setRaw] = createSignal("");

const COMMIT_DEBOUNCE_MS = 150;
const PAGE_STEP = 6;

let restoreFocus: HTMLElement | null = null;

function close(): void {
  if (!open()) return;
  setOpen(false);
  unregister("palette.close");
  restoreFocus?.focus?.();
  restoreFocus = null;
}

/** Opens the palette from anywhere (title bar search field, menus). `scope` picks the starting tab. */
export function openSearchEverywhere(scope: Scope = "all"): void {
  if (!open()) restoreFocus = document.activeElement as HTMLElement | null;
  setRaw("");
  setTab(scope);
  setOpen(true);
  // re-registered on every open so it sits last in the keymap and wins over other Esc bindings
  register("palette.close", "Esc", () => (open() ? (close(), true) : false), { allowInInput: true });
}

const hasProject = (): boolean => projectRepos().length > 0;

/** Label the fuzzy matcher runs against, per kind. */
function labelOf(i: PaletteItem): string {
  switch (i.kind) {
    case "action": return i.title;
    case "branch": return i.name;
    case "commit": return i.subject;
    case "file": return i.path;
    case "repo": return repoById(i.repoId)?.name ?? "";
  }
}

export function SearchEverywhere(): JSX.Element {
  const offs = [
    register("palette.open", ["Shift Shift", "Ctrl+K"], (e) => {
      if (hasOpenDialog()) return false;
      if (open()) {
        if (e?.key === "Shift") return false; // the second tap of a double Shift while open: ignore
        close();
        return true;
      }
      openSearchEverywhere();
      return true;
    }, { title: "Search everywhere", group: "Global", allowInInput: true }),
    register("palette.goToCommit", "Ctrl+G", () => {
      if (hasOpenDialog()) return false;
      openSearchEverywhere("commits");
      return true;
    }, { title: "Go to commit / hash…", group: "Log", when: hasProject, allowInInput: true }),
    register("palette.actions", "Ctrl+Shift+A", () => {
      if (hasOpenDialog()) return false;
      openSearchEverywhere("actions");
      return true;
    }, { title: "Find action", group: "Global", allowInInput: true }),
  ];
  onCleanup(() => {
    offs.forEach((off) => off());
    unregister("palette.close");
  });
  return <Show when={open()}><Palette /></Show>;
}

function Palette(): JSX.Element {
  let input!: HTMLInputElement;
  let list: HTMLDivElement | undefined;
  const parsed = createMemo(() => parseQuery(raw(), tab()));
  const [recent, setRecent] = createSignal<PaletteItem[]>(loadRecent());
  const [selKey, setSelKey] = createSignal<string | null>(null);

  // sources that are cheap and synchronous
  const actions = createMemo(() => actionItems());
  const branches = createMemo(() => branchItems());
  const repos = createMemo(() => repoItems());

  // files: working trees + selected commit, loaded once per opening (and when a repo changes)
  const [files, setFiles] = createSignal<FileItem[]>([]);
  const [filesLoading, setFilesLoading] = createSignal(true);
  let filesToken = 0;
  createEffect(() => {
    anyRepoVersion();
    const token = ++filesToken;
    setFilesLoading(true);
    void loadFiles().then((f) => {
      if (token !== filesToken) return;
      setFiles(f);
      setFilesLoading(false);
    });
  });
  onCleanup(() => void filesToken++);

  // commits: debounced backend search on the repos of the log filter
  const [commits, setCommits] = createSignal<CommitItem[]>([]);
  const [commitsLoading, setCommitsLoading] = createSignal(false);
  const wantsCommits = createMemo(() => {
    const p = parsed();
    return p.scope === "commits" || (p.scope === "all" && p.text.length > 0 && !p.prefix);
  });
  let commitTimer: ReturnType<typeof setTimeout> | undefined;
  let commitToken = 0;
  createEffect(on([wantsCommits, () => parsed().text, () => parsed().author, selectedRepoIds, anyRepoVersion], ([want, text, author, ids]) => {
    clearTimeout(commitTimer);
    const token = ++commitToken;
    if (!want) {
      setCommits([]);
      setCommitsLoading(false);
      return;
    }
    setCommitsLoading(true);
    commitTimer = setTimeout(() => {
      searchCommits(text, author, ids)
        .then((c) => token === commitToken && setCommits(c))
        .catch(() => token === commitToken && setCommits([]))
        .finally(() => token === commitToken && setCommitsLoading(false));
    }, untrack(() => (commits().length === 0 && text === "" ? 0 : COMMIT_DEBOUNCE_MS)));
  }));
  onCleanup(() => {
    clearTimeout(commitTimer);
    commitToken++;
  });

  const rows = createMemo<Row[]>(() =>
    buildRows(
      parsed().scope,
      parsed().text,
      { actions: actions(), branches: branches(), repos: repos(), files: files(), commits: commits(), recent: recent() },
      labelOf,
      parsed().author,
    ),
  );
  const selectable = createMemo(() => rows().filter((r): r is Exclude<Row, { t: "group" }> => r.t !== "group"));
  const activeIndex = createMemo(() => {
    const i = selectable().findIndex((r) => r.id === selKey());
    return i >= 0 ? i : 0;
  });
  const activeId = () => selectable()[activeIndex()]?.id ?? null;

  const loading = () => {
    const scope = parsed().scope;
    return ((scope === "commits" || scope === "all") && commitsLoading()) || (scope === "files" && filesLoading());
  };

  // a new query or tab restarts the selection at the top
  createEffect(on([raw, tab], () => {
    setSelKey(null);
    if (list) list.scrollTop = 0;
  }, { defer: true }));

  createEffect(() => {
    const id = activeId();
    if (!id || !list) return;
    const el = list.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`);
    if (activeIndex() === 0) list.scrollTop = 0;
    else el?.scrollIntoView({ block: "nearest" });
  });

  const move = (delta: number) => {
    const n = selectable().length;
    if (n === 0) return;
    const i = Math.abs(delta) > 1 ? Math.min(n - 1, Math.max(0, activeIndex() + delta)) : (activeIndex() + delta + n) % n;
    setSelKey(selectable()[i].id);
  };

  const switchTab = (scope: Scope) => {
    if (parsed().prefix) setRaw(parsed().text);
    setTab(scope);
    input.focus();
  };

  const pick = (row: Exclude<Row, { t: "group" }>) => {
    if (row.t === "more") {
      switchTab(row.scope);
      return;
    }
    const item = row.hit.item;
    const next = withRecent(recent(), item);
    saveRecent(next);
    setRecent(next);
    close();
    // let the focus go back before a dialog takes it
    setTimeout(() => activate(item), 0);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); move(1); break;
      case "ArrowUp": e.preventDefault(); move(-1); break;
      case "PageDown": e.preventDefault(); move(PAGE_STEP); break;
      case "PageUp": e.preventDefault(); move(-PAGE_STEP); break;
      case "Tab": {
        e.preventDefault();
        switchTab(cycleTab(parsed().scope, e.shiftKey ? -1 : 1));
        break;
      }
      case "Enter": {
        e.preventDefault();
        const row = selectable()[activeIndex()];
        if (row) pick(row);
        break;
      }
      case "Escape":
        e.preventDefault();
        close();
        break;
    }
  };

  onCleanup(() => {
    clearTimeout(commitTimer);
  });
  queueMicrotask(() => input?.focus());

  const renderRows = () => {
    return (
      <For each={rows()}>
        {(r) => (
          <Switch>
            <Match when={r.t === "group" && r}>{(g) => <div class="dg-palette-group">{g().label}</div>}</Match>
            <Match when={r.t === "hit" && r}>
              {(h) => (
                <div
                  class="dg-palette-row"
                  classList={{ "is-active": activeId() === h().id }}
                  role="option"
                  aria-selected={activeId() === h().id}
                  data-row-id={h().id}
                  onMouseMove={() => activeId() !== h().id && setSelKey(h().id)}
                  onClick={() => pick(h() as Exclude<Row, { t: "group" }>)}
                >
                  <ResultRow hit={(h() as { hit: Hit }).hit} />
                </div>
              )}
            </Match>
            <Match when={r.t === "more" && r}>
              {(m) => (
                <div
                  class="dg-palette-row dg-palette-more"
                  classList={{ "is-active": activeId() === m().id }}
                  role="option"
                  data-row-id={m().id}
                  onMouseMove={() => activeId() !== m().id && setSelKey(m().id)}
                  onClick={() => pick(m() as Exclude<Row, { t: "group" }>)}
                >
                  <span>{(m() as { count: number }).count} more</span>
                  <Icon name="chevronRight" size={12} />
                </div>
              )}
            </Match>
          </Switch>
        )}
      </For>
    );
  };

  return (
    <div class="dg-palette-scrim" onMouseDown={() => close()}>
      <div
        class="dg-palette"
        role="dialog"
        aria-label="Search everywhere"
        onMouseDown={(e) => {
          e.stopPropagation();
          if (!(e.target instanceof HTMLInputElement)) e.preventDefault(); // keep the focus in the input
        }}
        onKeyDown={onKeyDown}
      >
        <div class="dg-palette-tabs" role="tablist">
          <For each={TABS}>
            {(t) => (
              <button type="button" class="dg-palette-tab" classList={{ "is-on": parsed().scope === t.scope }} role="tab" tabindex={-1} aria-selected={parsed().scope === t.scope} onClick={() => switchTab(t.scope)}>
                {t.label}
              </button>
            )}
          </For>
        </div>
        <div class="dg-palette-input">
          <Icon name="search" size={16} class="dg-palette-input-icon" />
          <Show when={parsed().prefix}>{(p) => <span class="dg-palette-prefix">{p()}</span>}</Show>
          <input
            ref={input}
            class="dg-palette-field"
            type="text"
            spellcheck={false}
            autocomplete="off"
            role="combobox"
            aria-expanded="true"
            aria-controls="dg-palette-list"
            aria-activedescendant={activeId() ?? undefined}
            placeholder={placeholderFor(parsed().scope)}
            value={parsed().prefix ? raw().slice(1) : raw()}
            onInput={(e) => setRaw((parsed().prefix ?? "") + e.currentTarget.value)}
            onKeyDown={(e) => {
              // Backspace in an empty field drops the prefix
              if (e.key === "Backspace" && parsed().prefix && e.currentTarget.value === "") {
                e.preventDefault();
                setRaw("");
              }
            }}
          />
          <Show when={loading()}>
            <Spinner size={14} />
          </Show>
        </div>
        <div class="dg-palette-results" id="dg-palette-list" role="listbox" ref={list}>
          {renderRows()}
          <Show when={rows().length === 0 && !loading()}>
            <div class="dg-palette-empty">
              <Show when={hasProject()} fallback="Add a project to search its branches, files and commits.">
                <Show when={parsed().text} fallback="Nothing to show here yet.">
                  No results for “{parsed().text}”
                </Show>
              </Show>
            </div>
          </Show>
        </div>
        <div class="dg-palette-footer">
          <span>↑↓ to move · Enter to open · Tab to switch tabs</span>
          <span class="dg-palette-footer-prefixes">&gt; actions · # commits · @ authors · / files · : repos</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- result rows

function Hl(props: { text: string; positions: number[] }): JSX.Element {
  return (
    <For each={segments(props.text, props.positions)}>
      {(s) => (s.match ? <span class="dg-palette-match">{s.text}</span> : <>{s.text}</>)}
    </For>
  );
}

function ResultRow(props: { hit: Hit }): JSX.Element {
  const item = () => props.hit.item;
  return (
    <Switch>
      <Match when={item().kind === "action" && (item() as Extract<PaletteItem, { kind: "action" }>)}>
        {(a) => (
          <>
            <Icon name={a().icon} class="dg-palette-icon" />
            <span class="dg-palette-text"><Hl text={a().title} positions={props.hit.positions} /></span>
            <span class="dg-palette-sub dg-palette-group-tag">{a().group}</span>
            <Show when={keysFor(a().key)[0]}>{(k) => <Kbd keys={k()} />}</Show>
          </>
        )}
      </Match>
      <Match when={item().kind === "branch" && (item() as BranchItem)}>{(b) => <BranchRow item={b()} positions={props.hit.positions} />}</Match>
      <Match when={item().kind === "commit" && (item() as CommitItem)}>{(c) => <CommitRow item={c()} positions={props.hit.positions} />}</Match>
      <Match when={item().kind === "file" && (item() as FileItem)}>{(f) => <FileRow item={f()} positions={props.hit.positions} />}</Match>
      <Match when={item().kind === "repo" && (item() as RepoItem)}>{(r) => <RepoRow item={r()} positions={props.hit.positions} />}</Match>
    </Switch>
  );
}

function RepoChips(props: { repoIds: string[] }): JSX.Element {
  const repos = () => props.repoIds.map((id) => repoById(id)).filter((r): r is NonNullable<typeof r> => !!r);
  return (
    <span class="dg-palette-chips">
      <For each={repos().slice(0, 2)}>{(r) => <RepoChip name={r.name} color={r.color} />}</For>
      <Show when={repos().length > 2}>
        <span class="dg-palette-sub" title={repos().slice(2).map((r) => r.name).join("\n")}>+{repos().length - 2}</span>
      </Show>
    </span>
  );
}

function BranchRow(props: { item: BranchItem; positions: number[] }): JSX.Element {
  return (
    <>
      <Icon name={props.item.remote ? "remote" : props.item.isCurrent ? "branchCurrent" : "branch"} class="dg-palette-icon" />
      <span class="dg-palette-text"><Hl text={props.item.name} positions={props.positions} /></span>
      <Show when={props.item.isCurrent}><span class="dg-palette-sub">current</span></Show>
      <AheadBehind ahead={props.item.ahead} behind={props.item.behind} />
      <RepoChips repoIds={props.item.repoIds} />
    </>
  );
}

function CommitRow(props: { item: CommitItem; positions: number[] }): JSX.Element {
  const repo = () => repoById(props.item.repoId);
  return (
    <>
      <span class="dg-palette-dot-cell"><span class="dg-palette-dot" style={{ background: repoColor(repo()) }} /></span>
      <span class="dg-palette-text"><Hl text={props.item.subject} positions={props.positions} /></span>
      <span class="dg-palette-sub dg-palette-author">{props.item.authorName}</span>
      <Show when={repo()}>{(r) => <RepoChip name={r().name} color={r().color} />}</Show>
      <span class="dg-palette-hash">{shortOid(props.item.oid)}</span>
    </>
  );
}

function FileRow(props: { item: FileItem; positions: number[] }): JSX.Element {
  const parts = () => splitPath(props.item.path);
  const dirLen = () => props.item.path.length - parts().name.length;
  const repo = () => repoById(props.item.repoId);
  return (
    <>
      <Icon name={fileIconFor(props.item.path)} class="dg-palette-icon" />
      <span class="dg-palette-text">
        <Hl text={parts().name} positions={props.positions.filter((p) => p >= dirLen()).map((p) => p - dirLen())} />
        <Show when={parts().dir}>
          <span class="dg-palette-sub dg-palette-dir"><Hl text={parts().dir} positions={props.positions.filter((p) => p < dirLen())} /></span>
        </Show>
      </span>
      <StatusLetter status={props.item.status} />
      <Show when={repo()}>{(r) => <RepoChip name={r().name} color={r().color} />}</Show>
    </>
  );
}

function RepoRow(props: { item: RepoItem; positions: number[] }): JSX.Element {
  const repo = () => repoById(props.item.repoId);
  const s = () => summary(props.item.repoId);
  const state = (): { cls: string; title: string } => {
    const v = s();
    if (!v) return { cls: "", title: "" };
    if (v.state !== "clean" || v.conflicted > 0) return { cls: "is-busy", title: v.conflicted > 0 ? `${v.conflicted} conflicted files` : `${v.state} in progress` };
    const dirty = v.staged + v.unstaged + v.untracked;
    return dirty > 0 ? { cls: "is-dirty", title: `${dirty} changed files` } : { cls: "is-clean", title: "Clean" };
  };
  return (
    <Show when={repo()}>
      {(r) => (
        <>
          <span class="dg-palette-square-cell"><RepoSquare color={r().color} /></span>
          <span class="dg-palette-text"><Hl text={r().name} positions={props.positions} /></span>
          <Show when={s()?.branch}>
            {(b) => <span class="dg-palette-sub dg-palette-branch"><Icon name="branch" size={12} />{b()}</span>}
          </Show>
          <Show when={s()}>{(v) => <AheadBehind ahead={v().ahead} behind={v().behind} upstream={v().upstream} />}</Show>
          <span class={`dg-palette-state ${state().cls}`} title={state().title} />
        </>
      )}
    </Show>
  );
}
