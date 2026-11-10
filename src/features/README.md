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
| `merge/` | `registerMergeDialogs()` | No tab of its own: dialogs `conflicts` (`ConflictsDialog`) and `mergeFile` (`MergeFileDialog`), registered from `App`, opened with `actions.openConflicts` / `actions.openMerge`. It also reads `features/diff/syntax.ts` and `wordDiff.ts` (allowed here: they are pure helpers). See "Merge conflicts" below. |
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
- Repositories and projects have no colour of their own. Show a repository with `<RepoChip name={repo.name} />` (neutral badge) or
  `<RepoIcon />` plus the name. Lane colour: `laneColorVar(i)` (`i % 10` is done for you); use it for graph lanes only.
- Colours that mean something come from the colour system (`src/theme/colors.css`, DESIGN.md 4.4): a family token
  (`--dg-<accent|success|warning|danger|info|special|neutral>` solid, `-fill`, `-fg`, `-wash-soft`, `-wash`, `-wash-strong`,
  `-border`) or one of its aliases (`--dg-selection-bg`, `--dg-status-*`, `--dg-ref-*`...). A selected row in a focused list gets
  `--dg-selection-bg` and a 2 px `--dg-selection-edge` bar at the left. `npx vitest run src/theme` checks the contrast and fails on
  a hex colour in feature CSS.
- No transitions on hover/selection (DESIGN.md section 7). Respect `prefers-reduced-motion` by using the `--dg-dur-*` tokens.

## State (`src/state/`)

| Module | Use |
|---|---|
| `workspace.ts` | `workspace` (store), `activeProject()`, `projectRepos()`, `repoById(id)`, `selectedRepoIds()` / `selectedRepos()` (the repo filter), `setSelectedRepoIds`, `toggleRepo`, `selectOnlyRepo`, `selectAllRepos`, `isRepoFilterActive()`, `focusedRepo()` / `setFocusedRepoId` (target of single-repo commands), `summary(repoId)` (reactive `RepoSummary`), `projectTotals()` (ahead/behind/changes/operations), `refreshSummaries(ids?)`, `addProject`, `setActiveProject`, `removeProject`, `rescanProject`. Summaries refresh themselves on `repo-changed` (throttled). |
| `refs.ts` | `repoRefs(repoId)` -> accessor of `Refs` (first read loads it), `refreshRefs`, `ensureRefs(ids)`, `cachedRefs`, `hasLocalBranch`, `hasRemoteBranch`. Auto-refresh on `repo-changed`. |
| `selection.ts` | `selectedCommit()` / `setSelectedCommit({repoId, oid})`, `selectedFile()` / `selectFile({repoId, spec, path, oldPath?}, { reveal? })`, `detailsTab()` / `setDetailsTab("files" \| "diff")`, `mainTab()` / `setMainTab("log" \| "changes")`, `changesRepoId()` / `setChangesRepoId`, `clearSelection()`. |
| `settings.ts` | `settings` store (`theme`, `dateFormat`, `diffMode`, `showGraph`, `comfortableRows`, `showBackgroundCommands`, `useCredentialStore` (default true, synced to the backend with `setAuthPrefs`), `fontSize`, `editorFontSize`, `uiScale`, `autoFetchMinutes` (0 = off, 5, 15, 30, 60; default 15), `autoFetchPrune` (default true), `commitSignOff` (default false, remembered by the commit box)), `setSetting(key, value)` (validated, persisted as `deepgit.ui.<key>`), `resetSettings(keys?)`, `SETTING_DEFAULTS`, `zoomUi(+1 \| -1)`, `toggleTheme()`, `resolvedTheme()`. Add a key: extend `Settings`, `SETTING_DEFAULTS` and `SANITIZERS`. |
| `appearance.ts` | Pure maths of font size / editor size / UI scale: limits, `sanitize*`, `appearanceVars()` (the CSS variables). `index.html` repeats it before first paint; `prepaint.test.ts` checks both agree. |
| `dates.ts` | **Every date of the UI goes through here.** `formatDate(unixSec)` (the user's `dateFormat`: "3 h ago", "10 Nov 2026, 14:32" in the locale, or "2026-11-10 14:32"), `fullDate(unixSec)` (tooltips: always absolute, with seconds), `otherDate(unixSec)` (the other view, for places with room for both), `dateExample(format)`, `nowMs()` (clock signal, 30 s). Reactive: read them in JSX or a memo. The pure formats are in `dateFormat.ts` (`formatDateAs`, `formatFullDate`, `formatMonth`, `formatDay`, `dateWidthSample`, tested). Put a tooltip on a date with `data-tip`, not `title` (the tooltip host adopts `title` once, so a later change would not show). |
| `metrics.ts` | `cssPx(token, fallback)` (resolved px of a CSS token, reactive to font-size changes), `appearanceRev()`. |
| `layout.ts` | `sidebarVisible()`, `bottomTool()` ("console" \| "matrix" \| null), `toggleSidebar`, `openBottomTool(tool)`, `toggleBottomTool(tool)`. (The diff island and `diffVisible` / `toggleDiff` are gone.) |
| `console.ts` | `consoleEntries()` (ring of 500 `ConsoleEntry`), `lastUserEntry()` (ticker), `lastConsoleEntry()`, `isBackgroundEntry(e)`, `clearConsole()`, `formatCommand(e)`. |
| `events.ts` | `repoVersion(repoId)` / `anyRepoVersion()` (reactive counters bumped on every change), `subscribeRepoChanged(cb)`, `notifyRepoChanged(id)`. Never call `onRepoChanged` / `onGitConsole` yourself. |
| `auth.ts` | Credential prompts of fetch, pull and push (PLAN.md section 5.6). Started by `startEvents()`; shows the `auth` dialog one prompt at a time (`authQueue.ts`). `clearSavedCredentials()` forgets all saved logins and `credentialStoreUnavailable()` tells that the backend found no key store (both for the Settings page). Features never call it otherwise. |
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
await actions.merge([repoId], "origin/main");   // dialog "merge": mode, message, --no-commit, unrelated histories (rules in api/mergeRules.ts)
actions.cloneRepository(url?);                  // dialog "clone" (it runs actions.startClone itself and shows git's progress)
await actions.rebase(ids, "main"); actions.reset(ids, oid); actions.cherryPick(repoId, [oid]); actions.revert(repoId, oid);
await actions.fetch(ids); actions.fetchAll(); actions.pull(ids); actions.push(ids);   // push opens the "push" dialog
actions.stashSave(ids); actions.stashApply(repoId, 0); actions.stashPop(repoId, 0); actions.stashDrop(repoId, 0);
actions.tagCreate(ids, oid); actions.tagDelete(ids, "v1.0");
actions.deleteBranch(ids, name); actions.renameBranch(repoId, name); actions.checkoutRemote(repoId, "origin/x");
actions.opContinue(ids); actions.opAbort(ids); actions.opSkip(ids);
actions.stage(repoId, paths); actions.unstage(repoId, paths); actions.discard(repoId, paths); actions.commit(ids, message, { amend, signOff });
actions.stageHunk(repoId, path, index, reverse); actions.discardHunk(repoId, path, index);
actions.openConflicts(ids); actions.openMerge(repoId, path);                // conflicts dialog / merge window
actions.acceptSide(repoId, paths, "ours" | "theirs"); actions.saveResolution(repoId, path, content, expectedOids(versions), resolved);
```

Every action resolves to a `BatchResult { ok, skipped, failed, conflicts, cancelled, results }` and never rejects. Toasts, the
"Show in console" action on errors, the conflict warning with "Open Local changes", progress (2+ repos, max 4 parallel) and
summary refresh are done for you. To add a new action, add it to `actions.ts` with `runBatch({ verb, past, what, repoIds, skip, run })`.

### Dialogs (`state/dialogs.ts`)

`registerDialog(name, Component)` and `showDialog(name, props) -> Promise<result | undefined>` (undefined = cancelled).
Names and their `props` / `result` types are in `DialogRegistry`: `newBranch`, `renameBranch`, `merge`, `rebase`, `reset`,
`confirm` (done), `push`, `stash`, `tag`, `checkoutRemote`, `settings` (`features/settings`, props `{ section? }`), `clone`, `auth` (opened by `state/auth.ts`, not by features), `conflicts`, `mergeFile`. Until a name is registered `showDialog` falls back to
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

## Merge conflicts (`features/merge/`)

Behaviour is ported from IntelliJ (`MergeConflictModel`, `MergeModelBase`, `MergeRangeUtil`, `MergeResolveUtil`); the UI is the view.

| File | What |
|---|---|
| `seqDiff.ts` | Myers diff (`diffSeq`) and the three-way merge ranges (`mergeRanges`, a port of `ComparisonMergeUtil.buildSimple`). |
| `resolve.ts` | `tryResolveText(left, base, right)`: "magic resolve" at word level (tries exact, then ignoring whitespace). Returns `null` when the sides changed the same words differently. |
| `model.ts` | `MergeModel(base, left, right)` (left = Yours, right = Theirs): `chunks` with `type` (`inserted` / `deleted` / `modified` / `conflict`), `leftChange` / `rightChange`, `resolvable`, per-side resolved flags and the range in the Result; `applyChange`, `ignoreChange`, `applyNonConflicting("left" \| "right" \| "all")`, `magicResolve`, `magicResolveAll`, `resolveAutomatically`, `acceptAll`, `reset`, `counts()`, `nextUnresolved`, `documentEdits` (the Result was edited by hand), `snapshot` / `restore` (undo), `resultText()`, `resultWithMarkers(labels)`. `classify` is the classification table. Pure: tests are `*.test.ts` next to it. |
| `scrollSync.ts` | Anchors of the three panes and `mapLine` (scroll sync). |
| `editor.ts` | The CodeMirror 6 glue (no Solid): `createPane`, line marks for the chunks, syntax colours from `features/diff/syntax.ts`, the undo link (`modelState` effect + `invertedEffects`). |
| `ThreeWay.tsx` | The three panes, the bands and buttons in the gutters, toolbar, keys, save. |
| `SideChoice.tsx` | Delete/modify and binary files: keep one whole side. |
| `MergeFileDialog.tsx`, `ConflictsDialog.tsx` | The dialogs `mergeFile` and `conflicts`. |

Rules to keep:

- **Yours / Theirs** are the user's view. The backend already swaps the git stages during a rebase (`ConflictVersions.swapped`);
  the UI never maps stages. Left pane = `versions.ours`, right pane = `versions.theirs`.
- Text is edited with LF. `normalizeText(text, versions.eol)` turns CRLF into LF for CRLF files; `saveResolution` converts back.
- Only UTF-8 text without NUL bytes reaches the editor (`ConflictBlob.text` is `null` otherwise); such files only get Accept Yours / Theirs.
- Save: all conflicts resolved = `saveResolution(..., resolved = true)` (written and staged); conflicts left = the model's
  `resultWithMarkers` with `resolved = false` (written with `<<<<<<<` blocks, not staged). Pass the `oid` of all three blobs (`expectedOids(versions)`: Yours, Theirs and base; a stale one is refused).
- A hand edit inside a change resolves it (`byHand`); undoing the edit opens it again. Model actions are one undo step each.
- The mock backend mirrors the Rust rules (path checks, "no longer in conflict", stale blob, binary). Extend `mockConflicts.ts` for new demos.

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
Git-specific: `RepoChip`, `RepoIcon`, `RefPill` / `RefPills` (split HEAD pill, synced pill, +N), `AheadBehind`, `StatusLetter`.
Helpers: `formatRelative` (ages that are relative by nature, e.g. last fetch; other dates use `state/dates.ts`), `shortOid`, `initials`, `fnv1a`, `splitPath`, `statusLetter`,
`statusColorVar`, `fileIconFor(path)`, `copyText`, `plural`, `joinNames`.

## Settings sections (`features/settings/`)

The Settings window (`Ctrl+,`, gear menu, Search Everywhere) lists **sections**. A section is **one new file** in
`src/features/settings/sections/`. The dialog loads every `*.tsx` of that folder (`import.meta.glob`), so you change nothing else.

```tsx
// src/features/settings/sections/Editor.tsx   (example; Git.tsx is a real one to copy from)
import { Checkbox } from "../../../components/ui";
import { resetSettings, setSetting, settings } from "../../../state/settings";
import { registerSettingsSection } from "../registry";
import { Row, Section } from "../widgets";

function EditorSection() {
  return (
    <Section title="Whitespace">
      <Row label="Show whitespace" hint="In the diff.">
        <Checkbox checked={settings.showWhitespace} ariaLabel="Show whitespace" onChange={(v) => setSetting("showWhitespace", v)} />
      </Row>
    </Section>
  );
}

registerSettingsSection({ id: "editor", title: "Editor", order: 60, icon: "file", keywords: ["whitespace", "diff"], component: EditorSection,
                          reset: () => resetSettings(["showWhitespace"]) });
```

`registerSettingsSection({ id, title, order, keywords?, icon?, component, reset? })` (`features/settings/registry.ts`):

| Field | Meaning |
|---|---|
| `id` | Stable lower-case id. Same id again replaces the section. `showDialog("settings", { section: "git" })` opens it. |
| `title` | Entry in the left list and heading of the page. |
| `order` | Sort key, ascending. Shipped: Appearance 10, Log 20, Console 30, Git 40. Use 50 and up for new ones. |
| `keywords` | Extra words that the filter field matches (names of the controls). |
| `icon` | Optional `IconName`. |
| `component` | The page, no props. Use `Section`, `Row`, `NumberField`, `SizeControl` from `widgets.tsx` (`NumberField` and `SizeControl` take `zeroLabel`, for example "Off") and the `components/ui` controls. |
| `reset` | Optional. Puts the page back to defaults. It adds the **Reset to defaults** button and runs on **Reset all**. |

Rules: apply changes **live** (write to the store in the handler; there is no OK or Save). Store values with `setSetting` (add the key to
`Settings`, `SETTING_DEFAULTS` and `SANITIZERS` in `state/settings.ts`; every stored value is validated) or in your own store that
validates what it reads. Do not import another feature from a section.

**One user action, one change** (`widgets.tsx`, logic in `sizeControl.ts`). The slider of `SizeControl` only previews while it is dragged
(the number box shows the value) and calls `onChange` once, on release; arrow keys on it apply at once, one step per key press. A click
on `-` / `+` is one step and there is no press-and-hold repeat. A typed number applies on Enter or when the box loses focus. Never apply
a size while a pointer is down: the new size moves the control under the pointer and the pointer then reads another value (a loop).
Give a control whose value resizes the page `pin="layout"` (font sizes) or `pin="zoom"` (UI scale): after a change made with the pointer
the dialog moves (`moveDialogBy` of `components/ui`, kept inside the window) so that the control stays under the pointer.

Zoom keys (`Ctrl+=`, `Ctrl++`, `Ctrl+-`, `Ctrl+0`) are registered in `features/settings/index.ts`; do not reuse them.

## Tests and verification

- `npm run build` (tsc strict + vite) and `npx vitest run` must pass. Put tests next to the code (`*.test.ts`).
  Start pure-logic test files with `// @vitest-environment node` (jsdom is not installed; component tests are not possible yet).
- `npm run dev` runs the whole UI in a browser on the mock backend (`src/api/mock.ts`: project "payments-platform" with 6 repos of
  ~1000-2500 commits, project "deepgit"). In dev, `window.__deepgit` exposes `{ actions, workspace, selection, settings, layout, api }`
  for Playwright scripts and the console. If you need data the mock does not have, extend the mock (`src/api/mock*.ts`) and say so.
- Conflict demos in the mock: `docs-site` is merging with 4 conflicted files (a real conflict, a file that merges automatically,
  delete/modify, a binary file) and `ledger-service` is rebasing with 2 (Yours and Theirs swapped); merging or rebasing a branch whose
  name contains `spike` or `conflict` makes new ones (`mockConflicts.ts`).
- Login demos in the mock: fetch, pull or push of `docs-site`, or a clone of an https URL with "private" in it, opens the login dialog (`api/mockAuth.ts`). The auto-fetch never does (it runs with `background`).
