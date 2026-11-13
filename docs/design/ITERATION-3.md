# DeepGit iteration 3: design specification

Version 1.0 · 13-11-2026 · Owner: UX/UI lead · Source tasks: `TASKS.md`

This document uses ASD-STE100 Simplified Technical English.
Each instruction is one sentence. "Must" is a requirement. "Can" is an option.
It adds to `DESIGN.md`. When the two do not agree, this document is correct for the 13 items below.

Rules for implementers:

1. Use only tokens from `src/theme/tokens.css`, `src/theme/extra.css` and `src/theme/colors.css`.
2. Do not write a hex value in component CSS. New tokens go in the file that this spec names.
3. After you add a colour token, run `npx vitest run src/theme`. The contrast test must pass.
4. Use the existing components: `Dialog`, `ConfirmDialog`, `Menu`/`openMenu`, `Popup`, `Button`, `IconButton`, `TextField`, `Checkbox`, `Select`, `Tree`, `RadioGroup`, `Note`, `Field`, `ReadOnly`, `RepoChecklist`, `Spinner`, `toast`.
5. Do not add a git command preview (`command` prop) to a new dialog. `TASKS.md` 1 removes the command hints.
6. Write every date as `dd-mm-yyyy HH:mm` (24 h). Example: `13-11-2026 14:05`.
7. Use sentence case for every label. Write the labels exactly as this document gives them.

---

## 1. Sidebar: repositories grouped by folder

### 1.1 Tree rules

1. Build folder nodes from the repo paths relative to the project root folder.
2. A folder node shows only when it holds 2 or more repositories (directly or below it).
3. A folder that holds only 1 repository does not show. Its repository moves up to the parent level.
4. Compact single-child chains: yes. A folder whose only child is one folder merges with that child into one row. The label is `a/b/c`.
5. Do not compact a folder into a repository row. A repository row always shows only the repository name.
6. Sort order at each level: folders first, then repositories.
7. Sort each group by name, case-insensitive, with numbers in numeric order: `a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })`.
8. The graph lane groups (DESIGN 5.6 rule 4) follow this new order (depth-first, top to bottom).
9. Nested repositories (a repo inside another repo) keep the current rule: they are children of their parent repo, after Submodules. Folder grouping does not apply inside a repository.
10. A project with one repository has no folder rows (the current single-repo rule stays).
11. Folder node id: `dir:<relative path with "/">`. Example: `dir:IRIS/services`.

### 1.2 Mockup (sidebar 280 px)

```
Repositories                                   12
▾ 📁 HAB                          4
    ▸ ▣ hab-api        main      ↑2        ●
    ▸ ▣ hab-web        main                ○
    ▾ 📁 tools/scripts            2          <- compacted chain "tools/scripts"
        ▸ ▣ deploy     main                ○
        ▸ ▣ lint       develop   ↓3        ○
▸ 📁 IRIS                         3   ●      <- collapsed: count + worst state dot
▸ ▣ shared-lib         main                ○  <- repo at the project root
```

### 1.3 Folder row (26 px, `--dg-sidebar-row-height`)

| Part | Spec |
|---|---|
| Indent | 16 px per level (`--dg-tree-indent`). Repos inside a folder are one level deeper. |
| Chevron | The `Tree` chevron: 14 px, `--dg-icon-secondary`, rotates 90° in `--dg-dur-fast`. |
| Folder icon | `folder` (collapsed) or `folderOpen` (expanded), 14 px, `--dg-icon-secondary`. |
| Name | 13 px, weight 400, `--dg-text`, ellipsis at the end. Compacted label `tools/scripts` uses the same style. |
| Count | Number of repositories below the folder (all levels). 12 px `--dg-text-secondary`, tabular numbers, gap 6 px after the name. |
| Spacer | `flex: 1`. |
| State dot | Only when the folder is collapsed. Use the worst state of the repos below: conflict, then dirty. Same 8 px dot classes as the repo row (`dg-sidebar-dot is-conflict` / `is-dirty`). Show no dot for "clean". |

Folder rows do not show an ahead/behind capsule. A sum of commits from different repos has no clear meaning.

### 1.4 Folder row behaviour

1. Click the row: select it. Do not change the focused repository.
2. Double-click or `Enter`: expand or collapse.
3. Click the folder icon: show or hide all repositories below the folder in the log (same as the repo icon). `Alt+click`: show only these repositories.
4. When all repositories below are hidden from the log, the name and count are at 55 % opacity (same as `.is-filtered`).
5. Speed search matches folder labels too. A search expands every folder (current rule).
6. Default state: every folder is expanded.
7. Persist the collapsed folders per project. Key: `sidebar.collapsedFolders.<projectId>`. Value: array of folder ids. Use `savePersisted` / `loadPersisted`.
8. Store collapsed ids, not expanded ids. A new folder is then expanded by default.

### 1.5 Folder row context menu

| # | Label | Icon | Action |
|---|---|---|---|
| 1 | `Fetch N repositories` | `fetch` | Fetch every repo below. |
| 2 | `Show only these in the log` | `eye` | Same as `Alt+click` on the icon. |
| 3 | `Hide from the log` | — | Hide every repo below. |
| — | separator | | |
| 4 | `Expand all` | `expand` | Expand this folder and every folder below. |
| 5 | `Collapse all` | `collapse` | Collapse this folder and every folder below. |
| — | separator | | |
| 6 | `Copy path` | `copy` | Copies the absolute folder path. |

---

## 2. Commit graph row: ref labels without overlap

### 2.1 Root cause (for the implementer)

`.dg-log-refs .dg-ref:not(.dg-ref-more)` sets `min-width: 0` on the split pill `.dg-ref-split`.
The split pill has no `overflow: hidden`. Its `HEAD` segment is `flex: none`.
When the row is narrow, the split pill shrinks below its `HEAD` segment, and the segment paints outside the pill, under the `+N` chip.

### 2.2 Layout rules

1. Order, left to right: split pill (`HEAD` + current branch) or plain `HEAD` pill, local branches, remote branches, tags, stashes, `+N` chip.
2. `HEAD` is always first. The `+N` chip is always last.
3. Gap between pills: 4 px (`--dg-space-2`).
4. The pills sit right-aligned in the subject column (current rule). The subject text shrinks first and keeps at least 40 px.
5. Every pill must have `overflow: hidden`. Its text has `text-overflow: ellipsis`.
6. Minimum and maximum widths:

| Element | Min width | Max width | Shrinks |
|---|---|---|---|
| Plain `HEAD` pill (detached) | natural width | natural width | no (`flex: none`) |
| Split pill | `HEAD` segment + 48 px | 220 px | yes, only the branch segment |
| `HEAD` segment inside the split pill | natural width | natural width | no |
| Branch segment inside the split pill | 48 px | — | yes, ellipsis |
| Other pill | 40 px | 150 px | yes, ellipsis |
| `+N` chip | natural width (about 22 px) | — | no (`flex: none`) |

7. The pill budget (`pills.ts`) must use the minimum widths above. Show a pill only when its minimum width fits. Always keep room for the `+N` chip (`MORE = 26`, with the gap).
8. Always show the first pill (the `HEAD` pill when there is one). When the budget is smaller than the first pill's minimum width plus the chip, the subject gives up space down to its 40 px minimum.
9. `.dg-log-refs` keeps `overflow: hidden` as a last guard. Nothing may overlap inside it.
10. `+N` chip: height 16 px, padding `0 5px`, radius 4 px, `--dg-ref-overflow-bg`, `--dg-ref-overflow-fg`, 11 px weight 600, tabular numbers. Tooltip: one ref per line, in the order of rule 1.

### 2.3 Mockup

```
wide:    Fix refund rounding ……  [HEAD|⑂ feature/PAY-2318-refunds ☁] [⑂ develop] [🏷 v3.12.0]
narrow:  Fix refund roun…        [HEAD|⑂ feature/PA…] [+2]
tiny:    Fix refu…               [HEAD|⑂ fea…] [+2]
```

### 2.4 CSS changes

```css
.dg-ref { overflow: hidden; }
.dg-ref-split { min-width: calc(var(--dg-ref-head-w, 38px) + 48px); }
.dg-ref-split > .dg-ref-cur { min-width: 48px; flex: 1 1 auto; overflow: hidden; }
.dg-log-refs .dg-ref:not(.dg-ref-more):not(.dg-ref-split) { min-width: 40px; }
.dg-ref-more { flex: none; font-weight: var(--dg-weight-semibold); font-variant-numeric: tabular-nums; }
```

---

## 3. Target commit node: soft pulse

### 3.1 When it shows

1. The pulse shows on the commit node that a jump selects. A jump is: click or double-click a branch, tag or stash in the sidebar, the branch popup, Search Everywhere, `Ctrl+G`, or `H` (select HEAD).
2. Only one node pulses at a time.
3. The pulse runs 4 cycles (8 s). Then a static ring stays.
4. The static ring stays until the selection moves to another commit. Then the ring disappears.
5. A row selection by mouse click or arrow keys does not start the pulse.

### 3.2 Drawing

1. Add one extra circle to the row SVG, before the node circle: class `dg-log-node-target`.
2. Centre: the node centre. Radius: 7 px (the same as the HEAD ring). It replaces the HEAD ring on a HEAD node.
3. Stroke: the lane colour of the node (the same `stroke` attribute as the node). Stroke width 2 px. Fill none.
4. The row SVG must not clip the ring. The graph cell keeps `overflow: hidden`; a 7 px ring plus 35 % scale fits in the 24 px row.

### 3.3 CSS

Add to `log.css`. Add the two tokens to `tokens.css` section 1 (Motion).

```css
/* tokens.css, section 1 */
--dg-dur-pulse: 2000ms;          /* target node pulse, one cycle */
--dg-pulse-cycles: 4;

/* log.css */
.dg-log-node-target {
  fill: none;
  stroke-width: 2px;
  transform-box: fill-box;
  transform-origin: center;
  stroke-opacity: 0.55;
  transform: scale(1.15);
  animation: dg-log-target-pulse var(--dg-dur-pulse) var(--dg-ease-in-out) var(--dg-pulse-cycles) both;
}
@keyframes dg-log-target-pulse {
  0%   { stroke-opacity: 0.9;  transform: scale(1); }
  50%  { stroke-opacity: 0.2;  transform: scale(1.35); }
  100% { stroke-opacity: 0.9;  transform: scale(1); }
}
.dg-log-node-target.is-done { animation: none; stroke-opacity: 0.55; transform: scale(1.15); }

@media (prefers-reduced-motion: reduce) {
  .dg-log-node-target { animation: none; stroke-opacity: 0.55; transform: scale(1.15); }
}
```

5. Add `is-done` on `animationend`. A row that scrolls out and back in must show the static ring, not a new pulse. Keep the "done" flag in the log state, not in the row.
6. The pulse is the only moving element in the log (DESIGN 7 rule 3).

---

## 4. Folder is not a Git repository

### 4.1 When it shows

1. The user adds a project folder ("Add project folder…" or the sidebar "Add repository").
2. The scan finds no repository in the folder and in its subfolders.
3. Do not show an error toast. Show the dialog below.

### 4.2 Dialog (`Dialog`, width `normal` = 480 px)

```
┌ Initialize a Git repository? ────────────────────────────┐
│ The folder "IRIS-docs" has no Git repository.            │
│ DeepGit can create one in this folder.                   │
│                                                          │
│ Folder                                                   │
│ [📁 /home/pablo/work/IRIS-docs                        ]  │  <- ReadOnly, mono
│                                                          │
│ Initial branch                                           │
│ [main                                                 ]  │  <- TextField
│                                                          │
│ ⚠ This folder is inside the repository /home/pablo/work. │  <- Note, only when true
│   The new repository becomes a nested repository.        │
│                                                          │
│                          [Cancel] [Initialize repository]│
└──────────────────────────────────────────────────────────┘
```

| Element | Spec |
|---|---|
| Title | `Initialize a Git repository?` |
| Text | `The folder "<folder name>" has no Git repository.` then `DeepGit can create one in this folder.` |
| Folder | `Field` label `Folder`, `ReadOnly` with icon `folder`, mono, absolute path. |
| Initial branch | `Field` label `Initial branch`. `TextField`. Default: the value of `git config --global init.defaultBranch`. If it is not set: `main`. |
| Validation | Use `refname.ts`. Error text: `This is not a valid branch name.` The primary button is disabled while the name is not valid. |
| Nested note | `Note kind="warning"`. Show it only when a parent folder is a Git repository. |
| Buttons | Primary `Initialize repository`. Cancel `Cancel`. |

### 4.3 After the click

1. Run `git init -b <branch>` in the folder.
2. Add the folder as a project and make it the active project.
3. The log shows its empty state: title `No commits yet`, text `Make the first commit in Local changes.`, button `Open local changes` (`Alt+0`).
4. Show a success toast: title `Initialized a repository in <folder name>`, body `Branch <branch>.`
5. If `git init` fails, keep the dialog open. Show `Note kind="error"` with the first line of the git error.
6. `Cancel` or `Esc`: close the dialog. Do not add a project. Do not show a toast.

---

## 5. Remove a project from the list

### 5.1 Where

1. The project switcher menu (title bar, `Ctrl+Alt+P`). It is the project list.
2. Sort the project rows by name, case-insensitive (same compare as 1.1 rule 7).
3. Each project row gets a trailing remove button. It shows on hover and on the active (keyboard) row.
4. Keep the existing item `Remove <active project>…` at the bottom of the menu.

### 5.2 Trailing remove button

Add one optional field to `MenuItem` in `Menu.tsx`:

```ts
/** Icon button at the right end of the row; shows on hover and on the active row. `Delete` on the active row runs it. */
trailingAction?: { icon: IconName; label: string; onSelect: () => void };
```

| Part | Spec |
|---|---|
| Button | `IconButton` size small: 20 × 20 px, radius 4, icon 14 px `delete`, `--dg-icon-secondary`. |
| Hover | `--dg-hover-bg`, icon `--dg-text-error`. |
| Place | Right end of the row. It replaces the shortcut text (`3 repos`) while it shows. |
| Tooltip | `Remove from list` |
| Keyboard | `Delete` on the active row runs it. |
| Click | It does not select the project. It closes the menu and opens the dialog below. |

```
 Projects
 ✓ HAB                         4 repos
   IRIS                        [🗑]      <- hovered row
   shared-lib                  1 repo
 ─────────────────────────────────────
 + Add project folder…
```

### 5.3 Confirm dialog (`confirmAction`)

| Field | Text |
|---|---|
| Title | `Remove project from the list` |
| Message 1 | `Remove "<name>" from DeepGit?` |
| Message 2 | `DeepGit forgets this project. It does not delete files. The folder and its repositories stay on disk.` |
| Confirm label | `Remove from list` |
| `danger` | `false`. Nothing on disk changes, so the button is the normal primary button. |

1. When the removed project is the active project, open the next project in the sorted list. If no project is left, show the Welcome screen.
2. Use the same dialog for the bottom item `Remove <name>…`.
3. After the removal, show an info toast: `Removed <name> from the list`.

---

## 6. Status bar alerts

### 6.1 What an alert is

1. An alert is a warning or an error that needs the user. Examples: auto-fetch failed, push rejected, a repository is missing on disk.
2. Every `toast` of kind `warning` or `error` also creates an alert. Success and info toasts do not.
3. An alert belongs to one project (the active project when it was created). Each project has its own list.
4. An alert has: `id`, `projectId`, `severity` (`error` | `warning`), `text`, `repoName` (optional), `time` (unix ms).
5. Persist the alerts per project. Key: `alerts.<projectId>`. Keep at most 100 alerts per project, newest first.
6. The same text for the same repo replaces the old alert (new time). It does not add a duplicate.
7. The status bar alert widget replaces the current auto-fetch warning button (`dg-statusbar-autofetch`). The auto-fetch failure becomes an alert.

### 6.2 Auto-expire

1. Setting: `Remove alerts after`. Place: Settings › Appearance › new group `Notifications`.
2. Control: `Select`. Options in this order: `1 hour`, `4 hours`, `24 hours`, `3 days`, `7 days`, `Never`.
3. Default: `24 hours`.
4. Remove expired alerts at app start, every 60 s, and when the popover opens.

### 6.3 Status bar widget

Place: right side, after the branch widget, before the fetch age widget. It is always visible.

| State | Icon (14 px) | Icon colour | Badge |
|---|---|---|---|
| No alerts | `bell` | `--dg-statusbar-fg` | none |
| Warnings only | `warning` | `--dg-text-warning` | count, `--dg-warning-wash` bg, `--dg-warning-fg` text |
| 1 or more errors | `error` | `--dg-text-error` | count, `--dg-danger-wash` bg, `--dg-danger-fg` text |

1. Badge: height 14 px, min width 14 px, padding `0 4px`, radius 7 px, `--dg-font-size-micro`, weight 600, tabular numbers. Above 99: `99+`.
2. Widget: the standard status bar widget (height 22, padding `0 8px`, radius 4, hover `--dg-statusbar-hover-bg`).
3. Tooltip: `No alerts`, or `2 errors, 1 warning in <project name>`.
4. `aria-label`: the same text as the tooltip.
5. Click: open or close the popover.

### 6.4 Popover (`Popup`, placement `top-end`)

```
┌ Alerts · IRIS                              Dismiss all ┐   header 32 px
├─────────────────────────────────────────────────────────┤
│ ⊗  Push rejected by origin. Pull, then push again.   × │   row
│    api-gateway · 13-11-2026 14:05                      │
├─────────────────────────────────────────────────────────┤
│ ⚠  Auto-fetch failed: authentication required.       × │
│    ledger-service · 13-11-2026 09:12                   │
└─────────────────────────────────────────────────────────┘
  Alerts expire after 24 hours. Change it in Settings.        footer
```

| Part | Spec |
|---|---|
| Size | Width 400 px. Max height 360 px. The list scrolls. |
| Surface | `--dg-popup-bg`, 1 px `--dg-popup-border`, radius 8, `--dg-popup-shadow` (standard `Popup`). |
| Header | Height 32 px, padding `0 8px 0 12px`. Title `Alerts · <project name>` 13 px weight 600. Right: small text button `Dismiss all` (`Button size="small"`, ghost), disabled when the list is empty. |
| Row | Padding `8px 8px 8px 12px`, gap 8 px, min height 48 px, 1 px `--dg-separator` line between rows. Hover `--dg-row-hover-bg`. |
| Severity icon | 16 px, top-aligned. `error` in `--dg-text-error`, `warning` in `--dg-text-warning`. |
| Text | 12 px / 16 px, `--dg-text`, max 3 lines, then ellipsis. Selectable. |
| Meta line | 11 px `--dg-text-secondary`: `<repo name> · dd-mm-yyyy HH:mm`. Without a repo: only the date. |
| Dismiss | `IconButton` 20 × 20, icon `close` 12 px, label `Dismiss`. Always visible, top-aligned. |
| Empty state | One line, padding 16 px, 12 px `--dg-text-secondary`: `No alerts for this project.` |
| Footer | Padding `6px 12px`, 11 px `--dg-text-secondary`: `Alerts expire after <setting>. Change it in Settings.` "Settings" is a link (`--dg-text-link`) that opens Settings › Appearance. With `Never`: `Alerts stay until you dismiss them.` |

Keyboard:

1. `↑` `↓` move between rows. `Delete` dismisses the active row.
2. `Shift+Delete` runs `Dismiss all`.
3. `Esc` closes the popover and returns the focus to the widget.

---

## 7. Branch matrix: bulk "Push and set upstream"

### 7.1 Filter

1. Add a toolbar checkbox after `Only branches in 2+ repos`: `Only branches without upstream`.
2. A column passes the filter when 1 or more repos have the branch as a local branch with `upstream === null`.
3. A branch with a deleted upstream (`gone`) does not count. It has an upstream setting.
4. A cell of a local branch without upstream gets this tooltip line: `No upstream. Push it to set one.`

### 7.2 Button in the action bar

1. Place: right after `Push in N repos`.
2. Label: `Push and set upstream in N repos`. N = repos in the selected column where the branch is local, has no upstream, and the repo is not busy.
3. Icon: `push`. Variant: default.
4. Show the button only when N is 1 or more.

### 7.3 Dialog (`Dialog`, width `wide` = 640 px)

```
┌ Push and set upstream ──────────────────────────────────────┐
│ Push "feature/PAY-2318" and set it as the upstream branch.  │
│                                                             │
│ Remote  [origin ▾]                                          │
│                                                             │
│ [x] ▣ api-gateway        3 commits                          │
│ [x] ▣ ledger-service     1 commit                           │
│ [ ] ▣ docs-site          No remote named origin   (disabled)│
│                                                             │
│                           [Cancel] [Push to 2 repositories] │
└─────────────────────────────────────────────────────────────┘
```

| Element | Spec |
|---|---|
| Title | `Push and set upstream` |
| Text | `Push "<branch>" and set it as the upstream branch.` |
| Remote | `Field` label `Remote`, `Select`. Options: every remote name of the listed repos. Default `origin`. |
| List | `RepoChecklist`. All rows are checked. Detail text: `N commits` (commits not on any remote), or `No remote named <remote>` (row disabled and unchecked). |
| Primary | `Push to N repositories`. N = checked rows. Disabled when N = 0. |

### 7.4 Progress and result (same dialog)

1. After the click, the dialog stays open. The checkboxes become status icons. The primary button becomes disabled with the label `Pushing…`.
2. Run at most 4 pushes in parallel (DESIGN 5.17 rule 4). The matrix sweep line runs on the column.
3. Each row shows its status at the right of the detail text:

| Status | Icon (14 px) | Text (12 px) |
|---|---|---|
| Queued | 8 px hollow ring `--dg-clean-dot` | `Queued` `--dg-text-secondary` |
| Running | `Spinner` 14 px | `Pushing…` `--dg-text-secondary` |
| Done | `check` `--dg-text-success` | `Upstream set to origin/<branch>` |
| Failed | `error` `--dg-text-error` | The first line of the git error, `--dg-text-error`, ellipsis; full text in the tooltip |

4. When all rows end, the primary button becomes `Close`. `Cancel` disappears.
5. The matrix cells update when each push ends. Failed cells get the red ring (`is-failed`).
6. Show one toast at the end. All done: success, `Pushed <branch> to N repos`, body `Upstream set to <remote>/<branch>.` Some failed: error, `Push failed in N of M repos`, body the failed repo names, action `Show in console`.

---

## 8. Files tab: tree on the right, Git status colours

### 8.1 Layout

```
┌─ tabs: [app.ts ×] [api.rs ●] ───────────────────┬─ Files │ Search ──── ⟳ ⇊ ┐
│  12 │ export function …                         │ ▾ 📁 src             M   │
│  13 │                                           │     📄 app.ts        M   │
│  …  editor                                      │     📄 new.ts        A   │
│                                                 │   📄 .env            ?   │
└─────────────────────────────────────────────────┴──────────────────────────┘
                                         splitter ↑ (6 px drag zone)
```

1. DOM order in `.dg-fe`: `section.dg-fe-main`, then `Splitter`, then `aside.dg-fe-side`.
2. The aside keeps its tabs `Files` / `Search` and its two icon buttons.
3. Width: default 260 px, min 180 px, max 520 px (unchanged). Keep the persist key `TREE_KEY`.
4. The splitter sizes the right panel. Dragging to the left makes the tree wider.
5. Double-click the splitter: reset to 260 px.

### 8.2 Status colours (file name and status letter)

Use the existing `--dg-status-*` tokens. Do not add new ones.

| Status | Token | Dark | Light | Letter | Extra |
|---|---|---|---|---|---|
| Modified | `--dg-status-modified` | `#FFCF6E` | `#724300` | `M` | — |
| Added (staged new) | `--dg-status-added` | `#7DF0BC` | `#055C34` | `A` | — |
| Untracked | `--dg-status-untracked` | `#7AE6F7` | `#055769` | `?` | — |
| Ignored | `--dg-status-ignored` | `#C3C7CF` | `#474C59` | none | Name and icon at 70 % opacity. |
| Conflicted | `--dg-status-conflict` | `#FFA3AD` | `#961628` | `U` | Row bg `--dg-danger-wash-soft`. |
| Renamed | `--dg-status-renamed` | `#A8C8FF` | `#1442B8` | `R` | The tree shows the new path. |
| Type change | `--dg-status-typechange` | `#DEC4FF` | `#5C20B8` | `T` | — |
| Deleted | — | — | — | — | Not in the tree: the file is not on disk. It shows in Local changes. |
| Unchanged | `--dg-text` | | | none | — |

1. The name keeps its colour on a selected row (DESIGN 4.4 rule 6).
2. The status letter sits at the right end of the row (current `StatusLetter`).
3. A file with staged and unstaged changes shows the unstaged status (current `statusMap` rule).

### 8.3 Folder colour rule

1. A folder takes a colour only from changed files below it, at any depth. This is the JetBrains "show directories with changed descendants" behaviour.
2. Priority: conflicted, then modified (any tracked change: added, modified, renamed, deleted, type change), then untracked (all changed files below are untracked).
3. Keep the current `folderStatuses()` function. It already does this.
4. A folder that is ignored as a whole uses `--dg-status-ignored` at 70 % opacity. Its files do not colour the parent folders.
5. A folder never shows a status letter.
6. Repo root rows in a multi-repo tree keep `--dg-text`, weight 600.

---

## 9. Editor tab context menu

Open it with a right-click on a tab. Use `openMenu`. The clicked tab is "this tab". It does not need to be the active tab.

| # | Label | Shortcut | Enabled when |
|---|---|---|---|
| 1 | `Close` | `Ctrl+W` | always |
| 2 | `Close others` | — | 2 or more tabs |
| 3 | `Close all` | `Ctrl+Shift+W` | always |
| — | separator | | |
| 4 | `Close tabs to the left` | — | a tab is left of this tab |
| 5 | `Close tabs to the right` | — | a tab is right of this tab |
| — | separator | | |
| 6 | `Copy path` | — | always |
| 7 | `Copy absolute path` | — | always |
| — | separator | | |
| 8 | `Reveal in file tree` | `Ctrl+Shift+E` | always |

1. `Copy path` copies the path relative to the repository root. `Copy absolute path` copies the full path. These are the labels of the Local changes menu, so the two menus agree.
2. Each close item uses the current close flow. A tab with unsaved changes asks first. One dialog per dirty tab, in tab order. `Cancel` stops the rest of the batch.
3. `Reveal in file tree`: show the `Files` tab of the side panel, expand the parent folders, select the file row, scroll it to the centre, and focus the tree.
4. The shortcuts `Ctrl+W`, `Ctrl+Shift+W` and `Ctrl+Shift+E` work on the Files tab only (same scope as `Ctrl+S`). `Ctrl+W` and `Ctrl+Shift+E` act on the active tab.
5. Also add `Ctrl+F4` as a second key for `Close`.

---

## 10. Find and replace widget (editor)

Build it as a custom CodeMirror panel on top of `@codemirror/search` (`SearchQuery`, `setSearchQuery`, `findNext`, `findPrevious`, `replaceNext`, `replaceAll`). Remove the old `.cm-panel.cm-search` styling.

### 10.1 Geometry

```
                                                   right edge of the editor ┐
                ┌──┬────────────────────────────────────────────────────────┤
                │▸ │ [Find                Aa ab .*]  3 of 12   ↑  ↓  ×     │  row 1
                │  │ [Replace                     ]  ⇄  ⇄*                  │  row 2 (expanded)
                └──┴────────────────────────────────────────────────────────┘
```

| Part | Spec |
|---|---|
| Position | `position: absolute`, top 0, right 16 px (clears the scrollbar), z-index above the text. Over the code, not above it. |
| Surface | `--dg-popup-bg`, 1 px `--dg-popup-border` on left, right and bottom, radius `0 0 6px 6px`, `--dg-popup-shadow`. |
| Padding | `4px 6px 4px 0`. Row gap 4 px. |
| Height | 34 px collapsed (one row). 62 px expanded (two rows). |
| Expand toggle | Left column, 18 px wide, full height. Icon `chevronRight` 14 px, rotated 90° when expanded (`--dg-dur-fast`). Hover `--dg-hover-bg`. Tooltip `Toggle replace (Ctrl+H)`. |
| Find input | Width 240 px, height 24 px (`--dg-control-height-small`), standard text input, padding-right 72 px for the toggles. Placeholder `Find`. |
| Replace input | Width 240 px, height 24 px. Placeholder `Replace`. |
| Option toggles | Inside the find input, at the right: 3 buttons 20 × 18 px, radius 3, gap 2, 11 px weight 600 mono labels `Aa`, `ab`, `.*`. The `ab` label is underlined. |
| Toggle states | Off: transparent, `--dg-text-secondary`. Hover: `--dg-hover-bg`. On: `--dg-toolbar-selected-bg`, `--dg-toolbar-selected-fg`, 1 px inset `--dg-accent-border` (same as `.dg-fe-toggle.is-on`). |
| Counter | Min width 64 px, 12 px `--dg-text-secondary`, tabular numbers, margin `0 6px`. |
| Buttons | `IconButton` 22 × 22: `arrowUp` (previous), `arrowDown` (next), `close`. Row 2: `replace` and `replace all` text-free icon buttons (see 10.4). |

### 10.2 Counter text

| Case | Text | Colour |
|---|---|---|
| Empty query | (empty) | — |
| Matches, cursor on match k | `k of N` | `--dg-text-secondary` |
| Matches, cursor not on a match | `? of N` | `--dg-text-secondary` |
| No match | `No results` | `--dg-text-error`; the find input gets a 1 px `--dg-input-error-border` |
| Bad regex | `Invalid regex` | `--dg-text-error`; error border |
| More than 9 999 matches | `k of 9999+` | `--dg-text-secondary` |

### 10.3 Tooltips and labels (exact text)

| Control | Tooltip |
|---|---|
| `Aa` | `Match case (Alt+C)` |
| `ab` | `Match whole word (Alt+W)` |
| `.*` | `Use regular expression (Alt+R)` |
| `↑` | `Previous match (Shift+Enter)` |
| `↓` | `Next match (Enter)` |
| `×` | `Close (Escape)` |
| Replace | `Replace (Enter)` |
| Replace all | `Replace all (Ctrl+Alt+Enter)` |

### 10.4 Replace buttons

1. `Replace`: `IconButton` 22 × 22 with icon `replace` (new icon: 16 × 16, one `a→b` arrow: `<path d="M2.5 5.5h7l-2-2M13.5 10.5h-7l2 2"/>`).
2. `Replace all`: `IconButton` with icon `replaceAll` (new icon: the same arrows plus `<path d="M12 3v3M10.5 4.5h3"/>`).
3. Both are disabled when the find query is empty or has no match. The file must be writable.

### 10.5 Keyboard

| Key | Where | Action |
|---|---|---|
| `Ctrl+F` | editor | Open collapsed. Put the selected text (one line only) in the find input. Focus and select the find input. |
| `Ctrl+H` | editor | Open expanded. Focus the replace input. |
| `Enter` | find input | Next match. |
| `Shift+Enter` | find input | Previous match. |
| `F3` / `Shift+F3` | editor or widget | Next / previous match. |
| `Enter` | replace input | Replace the current match, then go to the next one. |
| `Ctrl+Alt+Enter` | widget | Replace all. |
| `Alt+C` / `Alt+W` / `Alt+R` | editor or widget | Toggle match case / whole word / regex. |
| `Escape` | widget | Close. Keep the query. Focus the editor. Remove the match highlights. |

The query and the three options stay for the session, for all tabs.

### 10.6 Match highlight colours

Add these tokens to `colors.css` section 1 (aliases, both themes). Amber keeps matches apart from the blue text selection, and it is the colour of the log text-filter match.

```css
--dg-find-match-bg: var(--dg-warning-wash);            /* every match */
--dg-find-match-border: var(--dg-warning-border);
--dg-find-current-bg: var(--dg-warning-wash-strong);   /* the current match */
--dg-find-current-border: var(--dg-warning);
```

| Element | CSS | Dark result | Light result |
|---|---|---|---|
| `.cm-searchMatch` | bg `--dg-find-match-bg`, `outline: 1px solid var(--dg-find-match-border)`, radius 2 px | `#FFB224` at 16 % | `#AD6600` at 11 % |
| `.cm-searchMatch-selected` | bg `--dg-find-current-bg`, `outline: 1px solid var(--dg-find-current-border)` | `#FFB224` at 24 %, solid edge | `#AD6600` at 18 %, solid edge |

---

## 11. Smart .gitignore

### 11.1 Entry points

1. Files tab tree: right-click a file or folder row.
2. Local changes list: right-click a file row or a folder row.
3. Menu item: `Add to .gitignore…`, with no icon. Place it in a new group after `Copy absolute path`, with a separator before it.
4. Hide the item on a repository root row and on a `.gitignore` file.
5. With several selected rows in one repository: label `Add N files to .gitignore…`.
6. With rows of different repositories: disabled, tooltip `Select files of one repository.`

### 11.2 Dialog (`Dialog`, width `wide` = 640 px)

```
┌ Add to .gitignore ─────────────────────────────────────────────┐
│ core › src/gen/api.ts                                          │
│                                                                │
│ Pattern                                                        │
│ (•) This file                    /src/gen/api.ts     1 file    │
│ ( ) This name anywhere           api.ts              3 files   │
│ ( ) This extension anywhere      *.ts               84 files   │
│ ( ) This folder                  /src/gen/          12 files   │
│ ( ) This folder name anywhere    gen/               14 files   │
│ ( ) Custom                       [/src/gen/api.ts          ]   │
│                                                                │
│ Add to  [core/.gitignore (repository root) ▾]                  │
│                                                                │
│ This line goes at the end of core/.gitignore:                  │
│ ┌────────────────────────────────────────────────────────────┐ │
│ │ /src/gen/api.ts                                            │ │  mono, --dg-layer-1-bg
│ └────────────────────────────────────────────────────────────┘ │
│ ⚠ This file is tracked. Git ignores only untracked files.      │  Note warning, only when true
│                                                                │
│                                   [Cancel] [Add to .gitignore] │
└────────────────────────────────────────────────────────────────┘
```

### 11.3 Pattern options

Paths are relative to the repository root, with `/` separators. `<p>` = file path, `<name>` = file name, `<ext>` = last extension, `<dir>` = parent folder path.

| # | Label | Pattern for a file | Pattern for a folder | Show when |
|---|---|---|---|---|
| 1 | `This file` | `/<p>` | — | file |
| 2 | `This name anywhere` | `<name>` | — | file |
| 3 | `This extension anywhere` | `*.<ext>` | — | file with an extension; not for a dotfile without one (`.env`) |
| 4 | `This folder` | `/<dir>/` | `/<folder path>/` | file not at the root, or folder |
| 5 | `This folder name anywhere` | `<last folder name>/` | `<folder name>/` | same as 4 |
| 6 | `Custom` | text field, prefilled with the selected pattern | same | always |

1. Default selection: option 1 for a file, option 4 for a folder.
2. For several files: show only `These files` (one `/<p>` line per file) and `Custom` (a `TextArea`, one pattern per line).
3. Escape the characters `#`, `!`, `[`, `]`, `*`, `?` and a leading space in path segments with `\`.
4. Use `RadioGroup`. The pattern is the option description, in mono 12 px.

### 11.4 Match count (cheap preview)

1. Count the matches on the file list that the Files tab already holds for this repository. Use a gitignore matcher in the frontend (for example the `ignore` npm package). Do not call git for each option.
2. Text at the right of each option: `1 file`, `84 files`. Include files in subfolders of a matched folder.
3. When the file list is not loaded, or holds more than 50 000 files, show no count.
4. The count includes tracked files. Section 11.5 explains them.

### 11.5 Tracked files note

1. When 1 or more matched files are tracked, show `Note kind="warning"` under the preview.
2. One tracked file: `This file is tracked. Git ignores only untracked files.`
3. Several: `N matching files are tracked. Git ignores only untracked files.`
4. Offer no action. Do not run `git rm --cached`. Do not show a command.

### 11.6 Target file

`Field` label `Add to`, `Select`:

| Option | Meaning |
|---|---|
| `<repo>/.gitignore (repository root)` | Default. Create the file when it does not exist. |
| `.git/info/exclude (only on this computer)` | Not shared with others. |

### 11.7 Rules

1. Preview: `This line goes at the end of <target>:` then the pattern line(s) in a mono box (`--dg-layer-1-bg`, 1 px `--dg-input-border`, radius 4, padding `6px 8px`).
2. When the exact line is already in the target file: `Note kind="info"` `This pattern is already in <target>.` Disable the primary button.
3. Primary button: `Add to .gitignore`. Cancel: `Cancel`.
4. Write: append the lines. Add a newline first when the file does not end with one. Do not stage. Do not commit.
5. Then refresh the status of the repository. Show a success toast: `Added <pattern> to .gitignore`, body `<repo>/.gitignore. Commit it when you are ready.` Action `Open .gitignore` opens the file in the Files tab.

---

## 12. App-wide right-click

### 12.1 Rules

1. Block the webview menu everywhere. Add one `contextmenu` listener on `window` in the bubble phase. It calls `preventDefault()` when no feature has handled the event (`e.defaultPrevented === false`).
2. Feature menus (log, sidebar, changes, details, tabs) keep their handlers. They call `preventDefault()` as now.
3. When the target is a text field, show the text menu below. Text fields: `input` (text, search, password, number), `textarea`, `[contenteditable]`, and the CodeMirror editor (`.cm-content`).
4. When the target is read-only text with the class `dg-selectable` (dialog text, alert text, console output) and text is selected in it, show the read-only text menu.
5. Everywhere else, show nothing.
6. In development builds (`import.meta.env.DEV`), `Shift+right-click` shows the webview menu. This keeps "Inspect element".

### 12.2 Text menu (`openMenu` at the pointer)

| # | Label | Shortcut | Enabled when |
|---|---|---|---|
| 1 | `Undo` | `Ctrl+Z` | the field is writable |
| 2 | `Redo` | `Ctrl+Shift+Z` | the field is writable |
| — | separator | | |
| 3 | `Cut` | `Ctrl+X` | writable and text is selected |
| 4 | `Copy` | `Ctrl+C` | text is selected |
| 5 | `Paste` | `Ctrl+V` | writable |
| — | separator | | |
| 6 | `Select all` | `Ctrl+A` | the field has text |

Read-only text menu: `Copy` (`Ctrl+C`), separator, `Select all` (`Ctrl+A`).

1. A password field: `Cut` and `Copy` are always disabled.
2. In CodeMirror, use its `undo`, `redo` and `selectAll` commands. In other fields, use the native commands.
3. `Paste` reads the clipboard through the Tauri clipboard plugin. The browser API needs a permission prompt.
4. After the action, the focus stays in the field.

---

## 13. App icon: dense tree

### 13.1 Source

1. The source is `src-tauri/icons/logo.svg` (hand-written, 1024 × 1024). `public/favicon.svg` is a copy. The Welcome screen draws the same mark inline (`Welcome.tsx`, `Logo`).
2. There is no generator now. Add `scripts/gen-logo.mjs`. It writes `src-tauri/icons/logo.svg` (large variant), `src-tauri/icons/logo-small.svg` (small variant) and `public/favicon.svg` (small variant).

### 13.2 Target shape

The mark stays a Git graph that reads as a tree. The trunk is one lane with two commits. The crown is a binary tree of commits. Each level doubles the nodes, and the levels get closer together. So the foliage gets much denser as the distance from the trunk grows.

```
          · · · · · · · ·                 level 6: 32 nodes (large)
        ·  ·  ·  ·  ·  ·  ·  ·            level 5: 16
         •   •   •   •   •   •            level 4: 8
            ●     ●     ●     ●           level 3: 4
                ●         ●               level 2: 2
                     ⬤                    level 1: fork (trunk top)
                     ┃
                     ⬤                    level 0: root
```

### 13.3 Geometry (all values in the 1024 viewBox)

Tile: `<rect width="1024" height="1024" rx="224" ry="224" fill="#191A1C"/>` (unchanged).

| Parameter | Large variant | Small variant |
|---|---|---|
| Deepest level L | 6 (32 leaves) | 4 (8 leaves) |
| Root node (level 0) | (512, 880) | (512, 880) |
| Fork node (level 1) = crown centre C | (512, 610) | (512, 640) |
| Radius from C, levels 2..L | 150, 250, 322, 378, 424 | 180, 300, 390 |
| Edge width, levels 1..L | 80, 56, 38, 26, 18, 12 | 96, 72, 56, 44 |
| Node radius, levels 0..L | 64, 64, 44, 32, 24, 18, 13 | 92, 92, 66, 54, 46 |
| Leaf angle span | −96° to +96° | −80° to +80° |

Algorithm:

1. Level k (k ≥ 2) has 2^(k−1) nodes, index i = 0 … 2^(k−1) − 1, left to right.
2. Leaf angles: 2^(L−1) values, evenly spaced from −span to +span. Angle 0° points up. Positive angles go right.
3. The angle of node (k, i) is the mean of the angles of all leaves below it.
4. Position: `x = Cx + r_k · sin(a)`, `y = Cy − r_k · cos(a)`.
5. The parent of (k, i) is (k − 1, ⌊i / 2⌋). The parent of both level-2 nodes is C, with direction "up" (0, −1).
6. Edge from parent P to child Q: `M P C c1 c2 Q`. `d` = distance P–Q. `uP`, `uQ` = unit vectors from C to P and to Q. `c1 = P + uP · 0.5 · d`. `c2 = Q − uQ · 0.4 · d`.
7. Trunk: `M 512 880 V <Cy>`, width = edge width of level 1.
8. Stroke caps round. Draw every edge first, then every node.
9. Node outline: stroke `#191A1C` (the tile), width `max(5, round(0.3 · r))`. It cuts the nodes out of the edges.

Colours (lane colours of the dark theme):

| Part | Colour |
|---|---|
| Root, trunk, fork | `#4A86FF` (accent) |
| Level 2, left node and its edge | `#2FE08A` (lane 1) |
| Level 2, right node and its edge | `#FFB52E` (lane 2) |
| Level 3 and deeper, by quarter of the crown (left to right) | `#22D8EE` (lane 5), `#2FE08A` (lane 1), `#FFB52E` (lane 2), `#FF8A33` (lane 7) |

Quarter of node (k, i) for k ≥ 3: `q = ⌊i · 4 / 2^(k−1)⌋`.

### 13.4 Sizes

1. Use the large variant for every raster of 64 px and more: `icon.png`, `logo-1024.png`, `128x128@2x.png`, `128x128.png`, `64x64.png`, `Square89…` to `Square310…`, `StoreLogo.png`, `icon.icns`, the 256 px layer of `icon.ico`.
2. Use the small variant for rasters under 64 px: `32x32.png`, `Square30x30Logo.png`, `Square44x44Logo.png`, `Square71x71Logo.png`, the 16, 24, 32 and 48 px layers of `icon.ico`, and `favicon.svg`.
3. Use the small variant inline on the Welcome screen (48 px). Keep its theme classes: tile `--dg-island-bg`, outline `--dg-island-bg`, trunk `--dg-accent`, lane colours `--dg-lane-5`, `--dg-lane-1`, `--dg-lane-2`, `--dg-lane-7`.
4. Check the result: render both variants at 256, 64, 32 and 16 px. At 32 px the small variant must show the trunk and 8 separate leaf dots.

A reference render of these parameters was checked during this design pass. It reads as a tree at 256 and 64 px.

---

## 14. Decisions for the product owner

1. **Sidebar folders.** A folder with only 1 repository does not show. Single-child folder chains merge into one row (`tools/scripts`). Folder rows show a repo count and, when collapsed, the worst state dot. They show no ahead/behind sum.
2. **Sidebar order** changes to folders first, then names A–Z. The lane groups in the combined graph follow this order.
3. **Ref pills.** `HEAD` is always first and never shrinks. `+N` is always last. Branch names keep the end ellipsis (no middle cut in this iteration).
4. **Target pulse.** 4 cycles (8 s), then a static ring until the selection changes. It is not infinite: DESIGN 7 allows one moving element at a time.
5. **Init repository.** The initial branch reads `init.defaultBranch` and falls back to `main`. The dialog warns about nested repositories, but does not block them.
6. **Remove project** is not a danger action (nothing on disk changes). The button is the normal primary button, labelled `Remove from list`.
7. **Alerts** are only warnings and errors. They are stored per project and survive a restart. Default expiry 24 hours. The status bar widget replaces the auto-fetch warning button. The title bar bell and the stripe bell keep the session notification list. Merging the two lists is a follow-up.
8. **Bulk push** runs from a dialog that also shows per-repo progress and results, instead of only a toast.
9. **Folder colours** follow changed files below them (JetBrains behaviour). Deleted files do not show in the Files tree.
10. **Tab menu labels** use the app's existing names: `Copy path` (relative) and `Copy absolute path`, not `Copy Relative Path`. Labels are in sentence case.
11. **Find matches** are amber, so they differ from the blue selection.
12. **.gitignore** uses a dialog, not a submenu, so the user sees the pattern, the match count and the tracked-file note. It can also write to `.git/info/exclude`. It never untracks files.
13. **Right-click.** The webview menu is off in all builds. Development builds keep it on `Shift+right-click`.
14. **App icon** gets two variants: a 6-level tree for 64 px and up, and a 4-level tree for small sizes, so the small icons stay readable.
