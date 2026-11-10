/**
 * Row renderers of the Local changes list (DESIGN.md 5.9, 5.12): repo row, section header, directory row and
 * file row. All rows are `--dg-file-row-height` high so the list can be virtualised. They hold no state:
 * everything goes through the `RowCtl` the view passes in.
 */
import { type JSX, Show } from "solid-js";
import type { FileChange, WorkingTree } from "../../api/types";
import { Badge, Icon, IconButton, RepoSquare, StatusLetter, fileIconFor, plural, splitPath, statusColorVar, tip } from "../../components/ui";
import { repoById, repoColor, repoVars, summary } from "../../state/workspace";
import { SECTION_TITLE, type Row, type Section } from "./model";

type Of<K extends Row["kind"]> = Extract<Row, { kind: K }>;
export type RepoRow = Of<"repo">;
export type SectionRow = Of<"section">;
export type DirRow = Of<"dir">;
export type FileRow = Of<"file">;

/** What a row can do; `view` is the one place that knows about selection and git actions. */
export interface RowCtl {
  isSelected: (key: string) => boolean;
  isCursor: (key: string) => boolean;
  /** Click on the row body (selection, or collapse for headers). */
  click: (row: Row, e: MouseEvent) => void;
  doubleClick: (row: Row) => void;
  context: (row: Row, e: MouseEvent) => void;
  /** Toggles the open state of a repo / section / directory row. */
  toggle: (row: Row) => void;
  /** Checkbox: stage when unstaged, unstage when staged (acts on the selection when the row is part of it). */
  tick: (row: FileRow | DirRow) => void;
  /** Hover buttons and section actions. */
  stage: (row: FileRow | DirRow) => void;
  unstage: (row: FileRow | DirRow) => void;
  discard: (row: FileRow | DirRow) => void;
  sectionStage: (row: SectionRow) => void;
  sectionUnstage: (row: SectionRow) => void;
  sectionDiscard: (row: SectionRow) => void;
  /** Working tree of a repo (counts in the repo row). */
  tree: (repoId: string) => WorkingTree | undefined;
  /** Repos have a colour spine when the project has more than one repo. */
  spine: boolean;
}

const keep = (e: MouseEvent) => e.preventDefault();

function Chevron(props: { open: boolean }): JSX.Element {
  return (
    <span class="dg-changes-chev" classList={{ "is-open": props.open }} aria-hidden="true">
      <Icon name="chevronRight" size={14} />
    </span>
  );
}

/** 16 px stage toggle that looks like a checkbox but is not a tab stop (the list owns the keyboard). */
function Tick(props: { checked: boolean; label: string; onToggle: () => void }): JSX.Element {
  return (
    <span
      class="dg-check-box dg-changes-tick"
      classList={{ "is-checked": props.checked }}
      role="checkbox"
      aria-checked={props.checked}
      aria-label={props.label}
      {...tip(props.label)}
      onClick={(e) => {
        e.stopPropagation();
        props.onToggle();
      }}
      onDblClick={(e) => e.stopPropagation()}
      onMouseDown={keep}
    >
      <Show when={props.checked}>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="m4 8.4 2.6 2.6L12 5.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </Show>
    </span>
  );
}

function Action(props: { icon: "plus" | "minus" | "undo" | "check"; label: string; shortcut?: string; danger?: boolean; onClick: () => void }): JSX.Element {
  return (
    <IconButton
      icon={props.icon}
      label={props.label}
      shortcut={props.shortcut}
      class={props.danger ? "dg-changes-action-danger" : undefined}
      tabIndex={-1}
      onMouseDown={keep}
      onClick={(e) => {
        e.stopPropagation();
        props.onClick();
      }}
    />
  );
}

function Counts(props: { file: FileChange }): JSX.Element {
  return (
    <span class="dg-changes-counts">
      <Show when={props.file.binary}>
        <span class="dg-changes-bin">binary</span>
      </Show>
      <Show when={(props.file.additions ?? 0) > 0}>
        <span class="dg-changes-add">+{props.file.additions}</span>
      </Show>
      <Show when={(props.file.deletions ?? 0) > 0}>
        <span class="dg-changes-del">{"−"}{props.file.deletions}</span>
      </Show>
    </span>
  );
}

const rowAttrs = (ctl: RowCtl, row: Row) => ({
  "data-key": row.key,
  "style": { "--d": row.depth, ...(ctl.spine ? { "--spine": repoColor(repoById(row.repoId)), ...repoVars(repoById(row.repoId)) } : {}) } as JSX.CSSProperties,
});

// ---------------------------------------------------------------- repo

export function RepoRowView(props: { row: RepoRow; ctl: RowCtl; open: boolean }): JSX.Element {
  const repo = () => repoById(props.row.repoId);
  const wt = () => props.ctl.tree(props.row.repoId);
  return (
    <div
      class="dg-changes-row dg-changes-repo"
      classList={{ "is-cursor": props.ctl.isCursor(props.row.key), "dg-tint-strong": props.ctl.spine }}
      role="treeitem"
      aria-level={1}
      aria-expanded={props.open}
      {...rowAttrs(props.ctl, props.row)}
      onClick={(e) => props.ctl.click(props.row, e)}
      onContextMenu={(e) => props.ctl.context(props.row, e)}
    >
      <Chevron open={props.open} />
      <RepoSquare repo={repo()} />
      <span class="dg-changes-repo-name">{repo()?.name ?? props.row.repoId}</span>
      <Show when={summary(props.row.repoId)?.branch ?? "detached HEAD"}>
        {(b) => (
          <span class="dg-changes-repo-branch" title={`Current branch: ${b()}`}>
            <Icon name="branch" size={12} />
            {b()}
          </span>
        )}
      </Show>
      <span class="dg-grow" />
      <span class="dg-changes-repo-counts">
        <Show when={(wt()?.conflicted.length ?? 0) > 0}>
          <span class="dg-changes-count-conflict" title="Conflicted files">{plural(wt()?.conflicted.length ?? 0, "conflict")}</span>
        </Show>
        <Show when={(wt()?.staged.length ?? 0) > 0}>
          <span title="Staged files">{wt()?.staged.length} staged</span>
        </Show>
        <Show when={(wt()?.unstaged.length ?? 0) > 0}>
          <span title="Unstaged and untracked files">{wt()?.unstaged.length} unstaged</span>
        </Show>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- section

const SECTION_HINT: Record<Section, string> = {
  conflicts: "Files with merge conflicts",
  staged: "Changes that go into the next commit",
  unstaged: "Modified and untracked files",
};

export function SectionRowView(props: { row: SectionRow; ctl: RowCtl }): JSX.Element {
  return (
    <div
      class="dg-changes-row dg-changes-section"
      classList={{ "is-cursor": props.ctl.isCursor(props.row.key), "is-conflicts": props.row.section === "conflicts", "dg-tint": props.ctl.spine }}
      role="treeitem"
      aria-level={props.row.depth + 1}
      aria-expanded={props.row.open}
      {...rowAttrs(props.ctl, props.row)}
      onClick={(e) => props.ctl.click(props.row, e)}
      onContextMenu={(e) => props.ctl.context(props.row, e)}
    >
      <Chevron open={props.row.open} />
      <span class="dg-changes-section-title" title={SECTION_HINT[props.row.section]}>{SECTION_TITLE[props.row.section]}</span>
      <Badge tone={props.row.section === "conflicts" ? "warning" : "neutral"}>{props.row.count}</Badge>
      <span class="dg-grow" />
      <span class="dg-changes-actions is-header">
        <Show when={props.row.section === "conflicts"}>
          <Action icon="check" label="Mark all resolved" onClick={() => props.ctl.sectionStage(props.row)} />
        </Show>
        <Show when={props.row.section === "staged"}>
          <Action icon="minus" label="Unstage all" onClick={() => props.ctl.sectionUnstage(props.row)} />
        </Show>
        <Show when={props.row.section === "unstaged"}>
          <Action icon="plus" label="Stage all" shortcut="Ctrl+Alt+A" onClick={() => props.ctl.sectionStage(props.row)} />
          <Action icon="undo" label="Discard all" danger onClick={() => props.ctl.sectionDiscard(props.row)} />
        </Show>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- directory

export function DirRowView(props: { row: DirRow; ctl: RowCtl }): JSX.Element {
  const staged = () => props.row.section === "staged";
  return (
    <div
      class="dg-changes-row dg-changes-dir"
      classList={{ "is-selected": props.ctl.isSelected(props.row.key), "is-cursor": props.ctl.isCursor(props.row.key), "dg-tint": props.ctl.spine }}
      role="treeitem"
      aria-level={props.row.depth + 1}
      aria-expanded={props.row.open}
      aria-selected={props.ctl.isSelected(props.row.key)}
      {...rowAttrs(props.ctl, props.row)}
      onClick={(e) => props.ctl.click(props.row, e)}
      onDblClick={() => props.ctl.doubleClick(props.row)}
      onContextMenu={(e) => props.ctl.context(props.row, e)}
    >
      <span
        class="dg-changes-chev-hit"
        onClick={(e) => {
          e.stopPropagation();
          props.ctl.toggle(props.row);
        }}
      >
        <Chevron open={props.row.open} />
      </span>
      <Tick checked={staged()} label={staged() ? `Unstage ${props.row.name}` : `Stage ${props.row.name}`} onToggle={() => props.ctl.tick(props.row)} />
      <Icon name={props.row.open ? "folderOpen" : "folder"} size={16} class="dg-changes-icon" />
      <span class="dg-changes-dirname">{props.row.name}</span>
      <span class="dg-changes-dircount">{props.row.files.length}</span>
      <span class="dg-grow" />
      <span class="dg-changes-actions">
        <Show when={staged()} fallback={<Action icon="plus" label={`Stage ${plural(props.row.files.length, "file")}`} onClick={() => props.ctl.stage(props.row)} />}>
          <Action icon="minus" label={`Unstage ${plural(props.row.files.length, "file")}`} onClick={() => props.ctl.unstage(props.row)} />
        </Show>
        <Show when={props.row.section === "unstaged"}>
          <Action icon="undo" label={`Discard ${plural(props.row.files.length, "file")}`} danger onClick={() => props.ctl.discard(props.row)} />
        </Show>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- file

export function FileRowView(props: { row: FileRow; ctl: RowCtl }): JSX.Element {
  const file = () => props.row.file;
  const staged = () => props.row.section === "staged";
  const split = () => splitPath(file().path);
  const resolvingLabel = () => (props.row.section === "conflicts" ? `Mark ${split().name} resolved` : `Stage ${split().name}`);
  return (
    <div
      class="dg-changes-row dg-changes-file"
      classList={{ "is-selected": props.ctl.isSelected(props.row.key), "is-cursor": props.ctl.isCursor(props.row.key), "dg-tint": props.ctl.spine }}
      role="treeitem"
      aria-level={props.row.depth + 1}
      aria-selected={props.ctl.isSelected(props.row.key)}
      title={`${file().path}${file().oldPath ? ` (renamed from ${file().oldPath})` : ""}`}
      {...rowAttrs(props.ctl, props.row)}
      onClick={(e) => props.ctl.click(props.row, e)}
      onDblClick={() => props.ctl.doubleClick(props.row)}
      onContextMenu={(e) => props.ctl.context(props.row, e)}
    >
      <Show when={props.row.tree}>
        <span class="dg-changes-spacer" />
      </Show>
      <Tick checked={staged()} label={staged() ? `Unstage ${split().name}` : resolvingLabel()} onToggle={() => props.ctl.tick(props.row)} />
      <StatusLetter status={file().status} />
      <Icon name={fileIconFor(file().path)} size={16} class="dg-changes-icon" />
      <span
        class="dg-changes-name"
        classList={{ "is-deleted": file().status === "deleted" }}
        style={{ "--st": statusColorVar(file().status) }}
      >
        {split().name}
      </span>
      <Show when={!props.row.tree && split().dir}>
        <span class="dg-changes-dir-dim">{split().dir}</span>
      </Show>
      <Show when={file().oldPath}>
        {(old) => <span class="dg-changes-from">from {splitPath(old()).name}</span>}
      </Show>
      <span class="dg-grow" />
      <Counts file={file()} />
      <span class="dg-changes-actions">
        <Show
          when={staged()}
          fallback={<Action icon={props.row.section === "conflicts" ? "check" : "plus"} label={resolvingLabel()} shortcut="Space" onClick={() => props.ctl.stage(props.row)} />}
        >
          <Action icon="minus" label={`Unstage ${split().name}`} shortcut="Space" onClick={() => props.ctl.unstage(props.row)} />
        </Show>
        <Show when={props.row.section === "unstaged"}>
          <Action icon="undo" label={`Discard changes in ${split().name}`} shortcut="Delete" danger onClick={() => props.ctl.discard(props.row)} />
        </Show>
      </span>
    </div>
  );
}
