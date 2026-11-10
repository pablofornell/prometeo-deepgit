# Feature contract

Each folder in `src/features/` is one feature with **one root component** (names are fixed, the shell imports them):

| Folder | Root | Notes |
|---|---|---|
| `titlebar/` | `TitleBar()` | 40 px bar. Keep `{...dragRegion}` on empty areas and `<WindowControls />` at the right. |
| `sidebar/` | `Sidebar()` | Island content (header + tree). |
| `log/` | `LogView()` | Log tab content: filter bar, banners, rows. Put header buttons in `<HeaderSlot name="main">`. |
| `changes/` | `ChangesView()` | "Local changes" tab content. |
| `details/` | `CommitDetails()` | "Changed files" tab of the right column. Reads `selectedCommit()`. Puts its header buttons in `<HeaderSlot name="details">`. |
| `diff/` | `DiffViewer(props)`, `DiffPanel()` | `DiffPanel` is the "File changes" tab of the right column; `DiffViewer` props are the contract (see file). |
| `palette/` | `SearchEverywhere()` | Mounted once by `App`; registers its own keys (`Shift Shift`, `Ctrl+K`). |
| `console/` | `GitConsole()` | Bottom tool window. |
| `matrix/` | `BranchMatrix()` | Bottom tool window. |
| `statusbar/` | `StatusBar()` | 28 px bar. |
| `welcome/` | `Welcome()` | Shown when the workspace has no project. Keep the drag bar + `WindowControls`. |
| `settings/` | `SettingsDialog`, `registerSettings()`, `SettingsHost` | Settings window and zoom keys. Sections are plain files, see "Settings sections" below. |
| `dialogs/` | `registerAllDialogs()` | Add `registerDialog(name, Component)` lines. |
| `shell/` | `Shell()` | Window layout (the right column tabs live here). Owned by the foundation, not by feature agents. |

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
- **Sizes follow the user's font size** (Settings > Appearance, 10 to 20 px). Never write a font size or a text-line height in px.
  Use the `--dg-font-size-*` tokens. For any other size that depends on text (row, control, icon, pill, badge height), use a token
  that already exists, or write `calc(N * var(--dg-u))` (`--dg-u` is 1 px at the default 13 px font). When JavaScript needs the number
  (virtual list row height, canvas/SVG maths), read it with `cssPx("--dg-...", fallback)` from `state/metrics.ts` inside a memo or
  effect: it re-runs when the font size changes, and the token must be `round(calc(N * var(--dg-u)), 1px)`. Never keep a row height as a
  px constant in TypeScript. Icon sizes (`<Icon size={14}>`) are px at the default font and scale on their own.
- Repo and project colour: `repoColor(repo)` gives the fill (palette `var(--dg-repo-N)` or the custom `#RRGGBB`), `repoVars(repo)` gives the
  inline style (`--rc`, `--rc-fg`, `--rc-tint`) for tints and chips (both from `state/workspace`, defined in `state/colors.ts`). Add the class
  `dg-tint` (rows), `dg-tint-strong` (headers) or `dg-tint-soft` (children) to tint an element; use `background-color` (not the `background`
  shorthand) for your own base and hover rules on it, so the tint stays. `isMultiRepo()` says when to tint. Lane colour:
  `laneColorVar(i)` (`i % 10` is done for you). Never use them for anything else.
- No transitions on hover/selection (DESIGN.md section 7). Respect `prefers-reduced-motion` by using the `--dg-dur-*` tokens.

## State (`src/state/`)

| Module | Use |
|---|---|
| `workspace.ts` | `workspace` (store), `activeProject()`, `projectRepos()`, `repoById(id)`, `repoColor(repo)`, `selectedRepoIds()` / `selectedRepos()` (the repo filter), `setSelectedRepoIds`, `toggleRepo`, `selectOnlyRepo`, `selectAllRepos`, `isRepoFilterActive()`, `focusedRepo()` / `setFocusedRepoId` (target of single-repo commands), `summary(repoId)` (reactive `RepoSummary`), `projectTotals()` (ahead/behind/changes/operations), `refreshSummaries(ids?)`, `addProject`, `setActiveProject`, `removeProject`, `rescanProject`. Summaries refresh themselves on `repo-changed` (throttled). |
| `refs.ts` | `repoRefs(repoId)` -> accessor of `Refs` (first read loads it), `refreshRefs`, `ensureRefs(ids)`, `cachedRefs`, `hasLocalBranch`, `hasRemoteBranch`. Auto-refresh on `repo-changed`. |
| `selection.ts` | `selectedCommit()` / `setSelectedCommit({repoId, oid})`, `selectedFile()` / `selectFile({repoId, spec, path, oldPath?}, { reveal? })`, `detailsTab()` / `setDetailsTab("files" \| "diff")`, `mainTab()` / `setMainTab("log" \| "changes")`, `changesRepoId()` / `setChangesRepoId`, `clearSelection()`. |
| `settings.ts` | `settings` store (`theme`, `dateFormat`, `diffMode`, `showGraph`, `laneColors`, `comfortableRows`, `showBackgroundCommands`, `fontSize`, `editorFontSize`, `uiScale`), `setSetting(key, value)` (validated, persisted as `deepgit.ui.<key>`), `resetSettings(keys?)`, `SETTING_DEFAULTS`, `zoomUi(+1 \| -1)`, `toggleTheme()`, `resolvedTheme()`. Add a key: extend `Settings`, `SETTING_DEFAULTS` and `SANITIZERS`. |
| `appearance.ts` | Pure maths of font size / editor size / UI scale: limits, `sanitize*`, `appearanceVars()` (the CSS variables). `index.html` repeats it before first paint; `prepaint.test.ts` checks both agree. |
| `metrics.ts` | `cssPx(token, fallback)` (resolved px of a CSS token, reactive to font-size changes), `appearanceRev()`. |
| `layout.ts` | `sidebarVisible()`, `bottomTool()` ("console" \| "matrix" \| null), `toggleSidebar`, `openBottomTool(tool)`, `toggleBottomTool(tool)`. (The diff island and `diffVisible` / `toggleDiff` are gone.) |
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
`confirm` (done), `push`, `stash`, `tag`, `checkoutRemote`, `settings` (`features/settings`, props `{ section? }`). Until a name is registered `showDialog` falls back to
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

## Right column: Changed files / File changes

The right column of the centre row is one island with two tabs, owned by `shell/Shell.tsx`. `detailsTab()` in `state/selection.ts` holds the active one.

| Tab | Content | Mounted |
|---|---|---|
| `"files"` Changed files | `CommitDetails` (commit block + file tree / list) | always, hidden with `hidden` when inactive |
| `"diff"` File changes | `DiffPanel` (the `DiffViewer` of `selectedFile()`, or the hint "Select a file in Changed files") | always, hidden with `hidden` when inactive |

Both stay mounted so the diff keeps its scroll position and the tree keeps its folders and selection. `DiffViewer` ignores the 0 px size of a hidden tab and puts the scroll offset back when it is shown again.

Rules (keep them simple; change them here and in `DESIGN.md` 2.3 together):

1. `selectFile(file)` selects the file **and** shows File changes. `selectFile(file, { reveal: false })` only selects (used for arrow keys in the tree and for re-pointing). `selectFile(null)` does not change the tab.
2. In Changed files a click or `Enter` / double-click on a file opens File changes; arrow keys only move the selection. In the Local changes list every file selection opens File changes (the list stays focused).
3. When the selected commit changes (Log tab only), `CommitDetails` asks `followFile()` (`state/fileFollow.ts`): if the new commit changes the same path in the same repo, the open file is re-pointed to the new commit and the tab does not change; otherwise the file is dropped (commit files only; a Local changes file stays selected) and the column returns to Changed files. Selecting no commit, or a commit that fails to load, does the same.
4. Keys (`state/shortcuts.ts`): `Ctrl+D` = File changes; `Esc` while the focus is inside File changes = back to Changed files, focus on the tree (id `diff.back`; the log's own `Esc` ignores the File changes tab); the palette actions "Show file changes (the diff)", "Show changed files (Esc in the diff)" and "Maximize or restore the file changes" do the same without keys.
5. Width: persisted `deepgit.ui.split.details` (px, set by dragging the splitter). Without a value the column takes 42 % of the row. It is clamped on every use (min 320 px, the log keeps 480 px). **Maximize** (button next to the tabs, double-click on the File changes tab) shows the column at row width minus a strip of at least 200 px for the log; it is not persisted and ends when the user leaves File changes or drags the splitter. See `shell/widths.ts`.
6. Diff layout: the user's choice of this session (`explicitDiffMode` in `diff/diffPrefs.ts`, set by the header switch and `Ctrl+Alt+D`) wins; otherwise a diff pane narrower than 720 px (`NARROW_DIFF_PX`) uses unified; otherwise the saved `diffMode` setting. Hunk buttons and `F7` work in both layouts.
7. Old localStorage values are ignored: `diffVisible` is never read, `shell.ratios` keeps only `bottom` (`sanitizeRatios`).

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
`Badge`, `Pill`, `Kbd`, `Spinner`, `ProgressBar`, `EmptyState`, `Avatar` (`name`, `email`, `size`), `HeaderSlot name="main" | "details"`.
Git-specific: `RepoChip`, `RepoSquare`, `RefPill` / `RefPills` (split HEAD pill, synced pill, +N), `AheadBehind`, `StatusLetter`.
Helpers: `formatLogDate`, `formatRelative`, `formatDateTime`, `shortOid`, `initials`, `fnv1a`, `splitPath`, `statusLetter`,
`statusColorVar`, `fileIconFor(path)`, `copyText`, `plural`, `joinNames`.

## Settings sections (`features/settings/`)

The Settings window (`Ctrl+,`, gear menu, Search Everywhere) lists **sections**. A section is **one new file** in
`src/features/settings/sections/`. The dialog loads every `*.tsx` of that folder (`import.meta.glob`), so you change nothing else.

```tsx
// src/features/settings/sections/Git.tsx
import { Checkbox } from "../../../components/ui";
import { resetSettings, setSetting, settings } from "../../../state/settings";
import { registerSettingsSection } from "../registry";
import { Row, Section, SizeControl } from "../widgets";

function GitSection() {
  return (
    <Section title="Fetch">
      <Row label="Fetch automatically" hint="Every few minutes.">
        <Checkbox checked={settings.autoFetch} ariaLabel="Fetch automatically" onChange={(v) => setSetting("autoFetch", v)} />
      </Row>
    </Section>
  );
}

registerSettingsSection({ id: "git", title: "Git", order: 40, icon: "fetch", keywords: ["fetch", "pull", "prune"], component: GitSection,
                          reset: () => resetSettings(["autoFetch"]) });
```

`registerSettingsSection({ id, title, order, keywords?, icon?, component, reset? })` (`features/settings/registry.ts`):

| Field | Meaning |
|---|---|
| `id` | Stable lower-case id. Same id again replaces the section. `showDialog("settings", { section: "git" })` opens it. |
| `title` | Entry in the left list and heading of the page. |
| `order` | Sort key, ascending. Shipped: Appearance 10, Log 20, Console 30. Use 40 for Git, 50 for Colors. |
| `keywords` | Extra words that the filter field matches (names of the controls). |
| `icon` | Optional `IconName`. |
| `component` | The page, no props. Use `Section`, `Row`, `NumberField`, `SizeControl` from `widgets.tsx` and the `components/ui` controls. |
| `reset` | Optional. Puts the page back to defaults. It adds the **Reset to defaults** button and runs on **Reset all**. |

Rules: apply changes **live** (write to the store in the handler; there is no OK or Save). Store values with `setSetting` (add the key to
`Settings`, `SETTING_DEFAULTS` and `SANITIZERS` in `state/settings.ts`; every stored value is validated) or in your own store that
validates what it reads. Do not import another feature from a section.

Zoom keys (`Ctrl+=`, `Ctrl++`, `Ctrl+-`, `Ctrl+0`) are registered in `features/settings/index.ts`; do not reuse them.

## Tests and verification

- `npm run build` (tsc strict + vite) and `npx vitest run` must pass. Put tests next to the code (`*.test.ts`).
  Start pure-logic test files with `// @vitest-environment node` (jsdom is not installed; component tests are not possible yet).
- `npm run dev` runs the whole UI in a browser on the mock backend (`src/api/mock.ts`: project "payments-platform" with 6 repos of
  ~1000-2500 commits, project "deepgit"). In dev, `window.__deepgit` exposes `{ actions, workspace, selection, settings, layout, api }`
  for Playwright scripts and the console. If you need data the mock does not have, extend the mock (`src/api/mock*.ts`) and say so.
- Conflict demos in the mock: merge or rebase a branch whose name contains `spike` or `conflict`.
