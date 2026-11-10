/**
 * Filter bar of the log (DESIGN.md 5.5): text box, then chips with popups for repos, branch, author, date and path.
 * An active chip looks pressed; "Clear" resets everything.
 */
import { For, type JSX, Show, createMemo, createSignal, onMount } from "solid-js";
import { Avatar, Checkbox, Icon, Popup, RepoSquare, SearchField, plural } from "../../components/ui";
import type { IconName } from "../../components/ui";
import { repoRefs } from "../../state/refs";
import { isRepoFilterActive, projectRepos, repoColor, selectAllRepos, selectOnlyRepo, selectedRepoIds, selectedRepos, summary, toggleRepo } from "../../state/workspace";
import { knownAuthors } from "./authors";
import {
  activeFilters, author, clearAllFilters, commitText, datePreset, path, refs, setAuthor, setDateRange, setPath, setRefs, since, textInput, typeText, until,
} from "./filters";
import { DATE_PRESETS, type DatePreset, branchChipLabel, dateChipLabel, parseDay, presetSince } from "./query";

const RECENT_PATHS = 8;
/** The popup rows handle the click; the checkbox is only a display. */
const noop = (): void => undefined;
const [recentPaths, setRecentPaths] = createSignal<string[]>([]);

interface ChipProps {
  label: string;
  icon?: IconName;
  leading?: JSX.Element;
  active: boolean;
  open: boolean;
  title?: string;
  onToggle: () => void;
  onClear?: () => void;
  ref?: (el: HTMLButtonElement) => void;
}

function Chip(props: ChipProps): JSX.Element {
  return (
    <button
      type="button"
      ref={(el) => props.ref?.(el)}
      class="dg-log-chip"
      classList={{ "is-on": props.active, "is-open": props.open }}
      aria-haspopup="dialog"
      aria-expanded={props.open}
      title={props.title}
      onClick={() => props.onToggle()}
    >
      {props.leading}
      <Show when={props.icon}>{(i) => <Icon name={i()} size={14} class="dg-log-chip-icon" />}</Show>
      <span class="dg-log-chip-label">{props.label}</span>
      <Icon name="chevronDown" size={14} class="dg-log-chip-chev" />
      <Show when={props.active && props.onClear}>
        <span
          class="dg-log-chip-clear"
          role="button"
          aria-label={`Clear ${props.label}`}
          title="Clear"
          onClick={(e) => {
            e.stopPropagation();
            props.onClear?.();
          }}
        >
          <Icon name="close" size={12} />
        </span>
      </Show>
    </button>
  );
}

/** Popup list with a search field on top (focused when the popup opens). */
function Search(props: { value: string; onInput: (v: string) => void; placeholder: string; onEnter?: () => void }): JSX.Element {
  let input: HTMLInputElement | undefined;
  onMount(() => queueMicrotask(() => input?.focus()));
  return (
    <div class="dg-log-pop-search">
      <SearchField
        size="filter"
        value={props.value}
        placeholder={props.placeholder}
        inputRef={(el) => (input = el)}
        onInput={props.onInput}
        onKeyDown={(e) => {
          if (e.key === "Enter") props.onEnter?.();
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------- repos

function ReposChip(): JSX.Element {
  const [open, setOpen] = createSignal(false);
  let anchor: HTMLButtonElement | undefined;
  const repos = projectRepos;
  const dots = () => selectedRepos().slice(0, 3);
  return (
    <>
      <Chip
        ref={(el) => (anchor = el)}
        label={`Repos: ${selectedRepoIds().length} of ${repos().length}`}
        leading={
          <span class="dg-log-dots">
            <For each={dots()}>{(r) => <i style={{ background: repoColor(r) }} />}</For>
          </span>
        }
        active={isRepoFilterActive()}
        open={open()}
        title="Repositories shown in the log"
        onToggle={() => setOpen(!open())}
        onClear={selectAllRepos}
      />
      <Popup open={open()} anchor={() => anchor} onClose={() => setOpen(false)} label="Repositories" class="dg-log-pop">
        <div class="dg-log-pop-head">
          <span>Repositories</span>
          <button type="button" class="dg-log-pop-link" onClick={selectAllRepos} disabled={!isRepoFilterActive()}>All</button>
        </div>
        <div class="dg-log-pop-list">
          <For each={repos()}>
            {(r) => (
              <div class="dg-log-pop-item has-only" classList={{ "is-selected": selectedRepoIds().includes(r.id) }} onClick={() => toggleRepo(r.id)}>
                <Checkbox checked={selectedRepoIds().includes(r.id)} onChange={noop} ariaLabel={r.name} />
                <RepoSquare repo={r} />
                <span class="dg-log-pop-text">{r.name}</span>
                <span class="dg-log-pop-meta">{summary(r.id)?.branch ?? ""}</span>
                <button
                  type="button"
                  class="dg-log-pop-only"
                  onClick={(e) => {
                    e.stopPropagation();
                    selectOnlyRepo(r.id);
                    setOpen(false);
                  }}
                >
                  Only this
                </button>
              </div>
            )}
          </For>
        </div>
      </Popup>
    </>
  );
}

// ---------------------------------------------------------------- branch

function BranchChip(): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [q, setQ] = createSignal("");
  let anchor: HTMLButtonElement | undefined;

  const names = createMemo(() => {
    const local = new Set<string>();
    const remote = new Set<string>();
    for (const id of selectedRepoIds()) {
      const r = repoRefs(id)();
      if (!r) continue;
      for (const b of r.local) local.add(b.name);
      for (const b of r.remote) remote.add(b.fullName);
    }
    return { local: [...local].sort(), remote: [...remote].sort() };
  });
  const match = (n: string) => n.toLowerCase().includes(q().trim().toLowerCase());
  const toggle = (n: string) => setRefs(refs().includes(n) ? refs().filter((x) => x !== n) : [...refs(), n]);
  const row = (n: string, icon: IconName) => (
    <div class="dg-log-pop-item" classList={{ "is-selected": refs().includes(n) }} onClick={() => toggle(n)}>
      <Checkbox checked={refs().includes(n)} onChange={noop} ariaLabel={n} />
      <Icon name={icon} size={14} class="dg-log-pop-icon" />
      <span class="dg-log-pop-text">{n}</span>
    </div>
  );

  return (
    <>
      <Chip
        ref={(el) => (anchor = el)}
        label={branchChipLabel(refs())}
        icon="branch"
        active={refs().length > 0}
        open={open()}
        title="Branches shown in the log"
        onToggle={() => {
          setQ("");
          setOpen(!open());
        }}
        onClear={() => setRefs([])}
      />
      <Popup open={open()} anchor={() => anchor} onClose={() => setOpen(false)} label="Branches" class="dg-log-pop dg-log-pop-wide">
        <Search value={q()} onInput={setQ} placeholder="Search branches" />
        <div class="dg-log-pop-list">
          <Show when={!q().trim()}>
            <div class="dg-log-pop-item" classList={{ "is-selected": refs().length === 0 }} onClick={() => setRefs([])}>
              <Checkbox checked={refs().length === 0} onChange={noop} ariaLabel="All branches" />
              <span class="dg-log-pop-text">All branches</span>
            </div>
            {row("HEAD", "commit")}
          </Show>
          <Show when={names().local.some(match)}>
            <div class="dg-log-pop-group">Local</div>
          </Show>
          <For each={names().local.filter(match).slice(0, 300)}>{(n) => row(n, "branch")}</For>
          <Show when={names().remote.some(match)}>
            <div class="dg-log-pop-group">Remote</div>
          </Show>
          <For each={names().remote.filter(match).slice(0, 300)}>{(n) => row(n, "remote")}</For>
        </div>
        <Show when={selectedRepoIds().length > 1}>
          <div class="dg-log-pop-foot">A name matches in every repository that has it.</div>
        </Show>
      </Popup>
    </>
  );
}

// ---------------------------------------------------------------- author

function AuthorChip(): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [q, setQ] = createSignal("");
  let anchor: HTMLButtonElement | undefined;
  const list = createMemo(() => {
    const n = q().trim().toLowerCase();
    return knownAuthors().filter((a) => !n || a.name.toLowerCase().includes(n) || a.email.toLowerCase().includes(n)).slice(0, 200);
  });
  const label = () => {
    const a = author();
    if (!a) return "Author";
    return knownAuthors().find((x) => x.email === a)?.name ?? a;
  };
  const pick = (value: string) => {
    setAuthor(value);
    setOpen(false);
  };
  return (
    <>
      <Chip
        ref={(el) => (anchor = el)}
        label={label()}
        icon="user"
        active={!!author()}
        open={open()}
        title="Filter by author"
        onToggle={() => {
          setQ("");
          setOpen(!open());
        }}
        onClear={() => setAuthor("")}
      />
      <Popup open={open()} anchor={() => anchor} onClose={() => setOpen(false)} label="Authors" class="dg-log-pop dg-log-pop-wide">
        <Search value={q()} onInput={setQ} placeholder="Search authors" onEnter={() => q().trim() && pick(list()[0]?.email ?? q().trim())} />
        <div class="dg-log-pop-list">
          <div class="dg-log-pop-item" classList={{ "is-selected": !author() }} onClick={() => pick("")}>
            <span class="dg-log-pop-text">Any author</span>
          </div>
          <For each={list()}>
            {(a) => (
              <div class="dg-log-pop-item" classList={{ "is-selected": author() === a.email }} onClick={() => pick(a.email)}>
                <Avatar name={a.name} email={a.email} />
                <span class="dg-log-pop-text">{a.name}</span>
                <span class="dg-log-pop-meta">{a.count}</span>
              </div>
            )}
          </For>
          <Show when={q().trim() && list().length === 0}>
            <div class="dg-log-pop-item" onClick={() => pick(q().trim())}>
              <Icon name="search" size={14} class="dg-log-pop-icon" />
              <span class="dg-log-pop-text">Match "{q().trim()}"</span>
            </div>
          </Show>
        </div>
      </Popup>
    </>
  );
}

// ---------------------------------------------------------------- date

const dayString = (unix: number | null): string => {
  if (unix === null) return "";
  const d = new Date(unix * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function DateChip(): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [custom, setCustom] = createSignal(false);
  const [from, setFrom] = createSignal("");
  const [to, setTo] = createSignal("");
  let anchor: HTMLButtonElement | undefined;
  const active = () => since() !== null || until() !== null;
  const applyCustom = () => {
    const a = parseDay(from());
    const b = parseDay(to());
    setDateRange("custom", a, b === null ? null : b + 86400 - 1);
    setOpen(false);
  };
  return (
    <>
      <Chip
        ref={(el) => (anchor = el)}
        label={dateChipLabel(datePreset(), since(), until())}
        icon="calendar"
        active={active()}
        open={open()}
        title="Filter by date"
        onToggle={() => {
          setCustom(datePreset() === "custom");
          setFrom(dayString(since()));
          setTo(dayString(until()));
          setOpen(!open());
        }}
        onClear={() => setDateRange(null, null, null)}
      />
      <Popup open={open()} anchor={() => anchor} onClose={() => setOpen(false)} label="Date" class="dg-log-pop">
        <div class="dg-log-pop-list">
          <div class="dg-log-pop-item" classList={{ "is-selected": !active() }} onClick={() => { setDateRange(null, null, null); setOpen(false); }}>
            <span class="dg-log-pop-text">Any time</span>
          </div>
          <For each={DATE_PRESETS}>
            {(p) => (
              <div
                class="dg-log-pop-item"
                classList={{ "is-selected": datePreset() === p.id }}
                onClick={() => {
                  setDateRange(p.id, presetSince(p.id, Date.now()), null);
                  setOpen(false);
                }}
              >
                <span class="dg-log-pop-text">{p.label}</span>
              </div>
            )}
          </For>
          <div class="dg-log-pop-item" classList={{ "is-selected": datePreset() === "custom" }} onClick={() => setCustom(!custom())}>
            <span class="dg-log-pop-text">Custom range…</span>
          </div>
        </div>
        <Show when={custom()}>
          <div class="dg-log-pop-custom">
            <label>
              <span>From</span>
              <input type="date" class="dg-log-date-input" value={from()} onInput={(e) => setFrom(e.currentTarget.value)} />
            </label>
            <label>
              <span>To</span>
              <input type="date" class="dg-log-date-input" value={to()} onInput={(e) => setTo(e.currentTarget.value)} />
            </label>
            <button type="button" class="dg-log-pop-apply" disabled={!parseDay(from()) && !parseDay(to())} onClick={applyCustom}>Apply</button>
          </div>
        </Show>
      </Popup>
    </>
  );
}

// ---------------------------------------------------------------- path

function PathChip(): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [q, setQ] = createSignal("");
  let anchor: HTMLButtonElement | undefined;
  const apply = (value: string) => {
    const v = value.trim();
    setPath(v);
    if (v) setRecentPaths([v, ...recentPaths().filter((p) => p !== v)].slice(0, RECENT_PATHS));
    setOpen(false);
  };
  return (
    <>
      <Chip
        ref={(el) => (anchor = el)}
        label={path() ? `Path: ${path()}` : "Path"}
        icon="path"
        active={!!path()}
        open={open()}
        title="Only commits that touch a file or folder"
        onToggle={() => {
          setQ(path());
          setOpen(!open());
        }}
        onClear={() => setPath("")}
      />
      <Popup open={open()} anchor={() => anchor} onClose={() => setOpen(false)} label="Path" class="dg-log-pop dg-log-pop-wide">
        <Search value={q()} onInput={setQ} placeholder="File or folder, e.g. src/refunds" onEnter={() => apply(q())} />
        <div class="dg-log-pop-list">
          <div class="dg-log-pop-item" onClick={() => apply(q())}>
            <Icon name="path" size={14} class="dg-log-pop-icon" />
            <span class="dg-log-pop-text">{q().trim() ? `Commits that touch ${q().trim()}` : "Type a path and press Enter"}</span>
          </div>
          <Show when={recentPaths().length > 0}>
            <div class="dg-log-pop-group">Recent</div>
            <For each={recentPaths()}>
              {(p) => (
                <div class="dg-log-pop-item" classList={{ "is-selected": path() === p }} onClick={() => apply(p)}>
                  <Icon name="file" size={14} class="dg-log-pop-icon" />
                  <span class="dg-log-pop-text">{p}</span>
                </div>
              )}
            </For>
          </Show>
        </div>
      </Popup>
    </>
  );
}

// ---------------------------------------------------------------- bar

export function FilterBar(props: { inputRef: (el: HTMLInputElement) => void }): JSX.Element {
  return (
    <div class="dg-log-filters" role="toolbar" aria-label="Log filters">
      <SearchField
        size="filter"
        class="dg-log-search"
        value={textInput()}
        placeholder="Filter by text or hash"
        shortcut="Ctrl+F"
        aria-label="Filter by text or hash"
        inputRef={props.inputRef}
        onInput={typeText}
        onKeyDown={(e) => {
          if (e.key === "Enter") commitText();
          if (e.key === "Escape" && textInput()) typeText("");
        }}
      />
      <Show when={projectRepos().length > 1}>
        <ReposChip />
      </Show>
      <BranchChip />
      <AuthorChip />
      <DateChip />
      <PathChip />
      <Show when={activeFilters().length > 0}>
        <button type="button" class="dg-log-clear" onClick={clearAllFilters} title={`Clear ${plural(activeFilters().length, "filter")}  Ctrl+Shift+F`}>
          <Icon name="close" size={12} />
          Clear
        </button>
      </Show>
    </div>
  );
}

export type { DatePreset };
