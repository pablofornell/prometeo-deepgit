# Feature contract

Each folder in `src/features/` is one feature with **one root component** (names are fixed, the shell imports them):

| Folder | Root | Notes |
|---|---|---|
| `titlebar/` | `TitleBar()` | 40 px bar. Keep `{...dragRegion}` on empty areas and `<WindowControls />` at the right. |
| `sidebar/` | `Sidebar()` | Island content (header + tree). |
| `log/` | `LogView()` | Log tab content: filter bar, banners, rows. Put header buttons in `<HeaderSlot name="main">`. |
| `changes/` | `ChangesView()` | "Local changes" tab content. |
| `details/` | `CommitDetails()` | Reads `selectedCommit()`. |
| `diff/` | `DiffViewer(props)`, `DiffPanel()` | `DiffPanel` is done; `DiffViewer` props are the contract (see file). |
| `palette/` | `SearchEverywhere()` | Mounted once by `App`; registers its own keys (`Shift Shift`, `Ctrl+K`). |
| `console/` | `GitConsole()` | Bottom tool window. |
| `matrix/` | `BranchMatrix()` | Bottom tool window. |
| `statusbar/` | `StatusBar()` | 28 px bar. |
| `welcome/` | `Welcome()` | Shown when the workspace has no project. Keep the drag bar + `WindowControls`. |
| `dialogs/` | `registerAllDialogs()` | Add `registerDialog(name, Component)` lines. |
| `shell/` | `Shell()` | Window layout. Owned by the foundation, not by feature agents. |

Files in `titlebar/ ... welcome/` currently hold **stubs**. Replace the stub, keep the export name and props.
`Sidebar` and `LogView` stubs already show the wiring (`Tree`, `VirtualList`, log sessions); throw them away freely.

## Import rules

A feature imports only from `src/api/`, `src/state/`, `src/components/ui/` and **its own folder**. Never from another
feature. Cross-feature communication goes through `state/` (selection, layout, actions, keymap, dialogs).

## CSS rules

- One CSS file per feature: `features/<name>/<name>.css`, imported by the feature's root component.
- Class prefix `dg-<name>-` (`dg-log-row`, `dg-sidebar-name`). Never style `.dg-btn`, `.dg-tree-row`... from a feature; add a
  modifier class of your own.
- Only `--dg-*` tokens (`src/theme/tokens.css`, spec in `docs/design/DESIGN.md`). **No hard-coded colours, sizes of
  chrome or durations.** Need a value that does not exist? Add it to `src/theme/extra.css` and say so in your report.
- Repo colour: `var(--dg-repo-N)` via `repoColor(repo)` (state/workspace) or `repoColorVar(index)`; lane colour:
  `laneColorVar(i)` (`i % 10` is done for you). Never use them for anything else.
- No transitions on hover/selection (DESIGN.md section 7). Respect `prefers-reduced-motion` by using the `--dg-dur-*` tokens.

## State (`src/state/`)

| Module | Use |
|---|---|
| `workspace.ts` | `workspace` (store), `activeProject()`, `projectRepos()`, `repoById(id)`, `repoColor(repo)`, `selectedRepoIds()` / `selectedRepos()` (the repo filter), `setSelectedRepoIds`, `toggleRepo`, `selectOnlyRepo`, `selectAllRepos`, `isRepoFilterActive()`, `focusedRepo()` / `setFocusedRepoId` (target of single-repo commands), `summary(repoId)` (reactive `RepoSummary`), `projectTotals()` (ahead/behind/changes/operations), `refreshSummaries(ids?)`, `addProject`, `setActiveProject`, `removeProject`, `rescanProject`. Summaries refresh themselves on `repo-changed` (throttled). |
| `refs.ts` | `repoRefs(repoId)` -> accessor of `Refs` (first read loads it), `refreshRefs`, `ensureRefs(ids)`, `cachedRefs`, `hasLocalBranch`, `hasRemoteBranch`. Auto-refresh on `repo-changed`. |
| `selection.ts` | `selectedCommit()` / `setSelectedCommit({repoId, oid})`, `selectedFile()` / `selectFile({repoId, spec, path, oldPath?})`, `mainTab()` / `setMainTab("log" \| "changes")`, `changesRepoId()` / `setChangesRepoId`, `clearSelection()`. |
| `settings.ts` | `settings` store (`theme`, `dateFormat`, `diffMode`, `showGraph`, `laneColors`, `comfortableRows`, `showBackgroundCommands`), `setSetting(key, value)` (persisted as `deepgit.ui.<key>`), `toggleTheme()`, `resolvedTheme()`. |
| `layout.ts` | `sidebarVisible()`, `diffVisible()`, `bottomTool()` ("console" \| "matrix" \| null), `toggleSidebar`, `toggleDiff`, `openBottomTool(tool)`, `toggleBottomTool(tool)`. |
| `console.ts` | `consoleEntries()` (ring of 500 `ConsoleEntry`), `lastUserEntry()` (ticker), `lastConsoleEntry()`, `isBackgroundEntry(e)`, `clearConsole()`, `formatCommand(e)`. |
| `events.ts` | `repoVersion(repoId)` / `anyRepoVersion()` (reactive counters bumped on every change), `subscribeRepoChanged(cb)`, `notifyRepoChanged(id)`. Never call `onRepoChanged` / `onGitConsole` yourself. |
| `activity.ts` | `activities()` (running operations for the progress widget), `beginActivity(label, total)`. |
| `keymap.ts` | See below. |
| `actions.ts` | See below. |
| `dialogs.ts` | See below. |

### Reading data

Use `src/api/tauri.ts` (`import * as api from "../../api/tauri"`) for reads: `api.logOpen`, `api.logRows`, `api.commitDetails`,
`api.workingTree`, `api.fileDiff`, ... All wrappers reject with `ApiError {message, detail?}`. In a browser they run
against `src/api/mock.ts`.

Reload when something changes: `createEffect(() => { repoVersion(repoId); reload(); })`, or use `createResource` with
`anyRepoVersion()` in the source. Log sessions: open one per query, page rows in blocks of 200 (`logRows`), `logClose` on
cleanup (the stub in `log/LogView.tsx` is a working example).

### Writing (git actions)

**Always go through `state/actions.ts`**, never call write wrappers from a feature (you would lose the toasts, conflict
handling, skip rules and multi-repo fan-out):

```ts
import * as actions from "../../state/actions";
await actions.checkout(repoId, "main");                              // one repo
await actions.checkout(selectedRepoIds(), "feature/x", { branchOnly: true }); // many; repos without it are skipped
await actions.createBranch([repoId], oid, { startLabel: "api-gateway @ 9f3c2a1" }); // asks the name via the "newBranch" dialog
await actions.merge([repoId], "origin/main");   // dialog "merge"
await actions.rebase(ids, "main"); actions.reset(ids, oid); actions.cherryPick(repoId, [oid]); actions.revert(repoId, oid);
await actions.fetch(ids); actions.fetchAll(); actions.pull(ids); actions.push(ids);   // push opens the "push" dialog
actions.stashSave(ids); actions.stashApply(repoId, 0); actions.stashPop(repoId, 0); actions.stashDrop(repoId, 0);
actions.tagCreate(ids, oid); actions.tagDelete(ids, "v1.0");
actions.deleteBranch(ids, name); actions.renameBranch(repoId, name); actions.checkoutRemote(repoId, "origin/x");
actions.opContinue(ids); actions.opAbort(ids); actions.opSkip(ids);
actions.stage(repoId, paths); actions.unstage(repoId, paths); actions.discard(repoId, paths); actions.commit(ids, message, { amend });
actions.stageHunk(repoId, path, index, reverse); actions.discardHunk(repoId, path, index);
```

Every action resolves to a `BatchResult { ok, skipped, failed, conflicts, cancelled, results }` and never rejects. Toasts, the
"Show in console" action on errors, the conflict warning with "Open Local changes", progress (2+ repos, max 4 parallel) and
summary refresh are done for you. To add a new action, add it to `actions.ts` with `runBatch({ verb, past, what, repoIds, skip, run })`.

### Dialogs (`state/dialogs.ts`)

`registerDialog(name, Component)` and `showDialog(name, props) -> Promise<result | undefined>` (undefined = cancelled).
Names and their `props` / `result` types are in `DialogRegistry`: `newBranch`, `renameBranch`, `merge`, `rebase`, `reset`,
`confirm` (done), `push`, `stash`, `tag`, `checkoutRemote`. Until a name is registered `showDialog` falls back to
`window.prompt` / `confirm`. A dialog component receives its props plus `close(result?)`:

```tsx
export function RenameBranchDialog(props: RenameBranchProps & DialogComponentProps<RenameBranchResult>) {
  return <Dialog title="Rename branch" onClose={() => props.close()} command={`git branch -m ...`}
           primary={{ label: "Rename", onClick: () => props.close({ newName, renameRemote }) }}>…</Dialog>;
}
// features/dialogs/index.ts
registerDialog("renameBranch", RenameBranchDialog);
```

Every operation dialog shows the git command (`command` prop, DESIGN.md 11.7). `confirmAction({ title, message, confirmLabel, danger, checkboxes, command })`
is the generic confirmation (primary button names the action; never "OK").

### Keyboard (`state/keymap.ts`)

```ts
const off = register("log.focusFilter", "Ctrl+F", () => input.focus(), { title: "Focus the text filter", group: "Log", when: () => mainTab() === "log" });
register("palette.open", ["Shift Shift", "Ctrl+K"], open);       // double tap + chord
onCleanup(off);
```

Keys: `Ctrl+Shift+A`, `Alt+9`, `Ctrl+Shift+\``, `F7`, `Space`, `Delete`... (`Ctrl` = Cmd on macOS). A handler returning `false` lets the event
through. Plain keys do not fire inside inputs (set `allowInInput`). `bindings()` lists everything for the palette,
`runBinding(id)` executes one, `shortcutLabel(id)` / `formatKeys` give display text for tooltips. Global shortcuts (tool windows,
fetch/pull/push, refresh) are already registered in `state/shortcuts.ts`; do not register them again.

## UI components (`src/components/ui`, `import { ... } from "../../components/ui"`)

Open `http://localhost:1420/#gallery` for a live catalogue of everything below.

`Icon` (81 icons, `name`, `size`), `Button` (variants `default|primary|danger|ghost`, `size="small"`, `icon`, `title`+`shortcut` tooltip),
`IconButton` (`icon`, `label`, `shortcut`, `active`), `TextField` / `SearchField` (`value`, `onInput(value)`, `size="filter"`, `error`),
`Checkbox` (`checked`, `onChange`, `label`, `indeterminate`), `Select` (`options`, `value`, `onChange`), `SegmentedControl`,
`openContextMenu(event, items)` / `openMenu(buttonEl, items)` (`MenuItem`: `label icon shortcut disabled danger separator heading checked submenu tooltip onSelect`),
`Popup` (`open`, `anchor`, `onClose`, `placement`), `openDialog(Component, props)` + `Dialog` frame, `toast({ kind, title, body, actions })`,
`tip("text", "Ctrl+T")` / `use:tooltip` / native `title="Text  Shortcut"`, `Splitter` + `loadSplitSize(key, default)`,
`VirtualList` (`count`, `rowHeight`, `renderRow(i)`, `onRangeChange(start, end)`, `selectedIndex`, `onSelect(i)` for keyboard, `apiRef` -> `scrollToIndex`),
`Tree<T>` (`roots`, `getId`, `getChildren`, `renderNode`, `expanded` + `onExpandedChange` via `createExpanded()`, `selectedId`, `onSelect`, `onActivate`, `onContextMenu`),
`Badge`, `Pill`, `Kbd`, `Spinner`, `ProgressBar`, `EmptyState`, `Avatar` (`name`, `email`, `size`), `HeaderSlot name="main"`.
Git-specific: `RepoChip`, `RepoSquare`, `RefPill` / `RefPills` (split HEAD pill, synced pill, +N), `AheadBehind`, `StatusLetter`.
Helpers: `formatLogDate`, `formatRelative`, `formatDateTime`, `shortOid`, `initials`, `fnv1a`, `splitPath`, `statusLetter`,
`statusColorVar`, `fileIconFor(path)`, `copyText`, `plural`, `joinNames`.

## Tests and verification

- `npm run build` (tsc strict + vite) and `npx vitest run` must pass. Put tests next to the code (`*.test.ts`).
  Start pure-logic test files with `// @vitest-environment node` (jsdom is not installed; component tests are not possible yet).
- `npm run dev` runs the whole UI in a browser on the mock backend (`src/api/mock.ts`: project "payments-platform" with 6 repos of
  ~1000-2500 commits, project "deepgit"). In dev, `window.__deepgit` exposes `{ actions, workspace, selection, settings, layout, api }`
  for Playwright scripts and the console. If you need data the mock does not have, extend the mock (`src/api/mock*.ts`) and say so.
- Conflict demos in the mock: merge or rebase a branch whose name contains `spike` or `conflict`.
