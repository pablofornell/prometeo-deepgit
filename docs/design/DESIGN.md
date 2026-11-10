# DeepGit design specification

Version 1.0 · 10 Nov 2026 · Owner: UX/UI lead

This document is the design source of truth for DeepGit v1.
It uses ASD-STE100 Simplified Technical English.
Each instruction is one sentence.
"Must" is a requirement. "Can" is an option.

Companion files in this folder:

| File | Content |
|---|---|
| `tokens.css` | All CSS custom properties. Dark and light values. Metrics. Motion. |
| `mockup.html` | Static high-fidelity mockup of the main window, dark theme, 1600 × 1000 px. Open it in a browser. |
| `mockup.png` | Screenshot of `mockup.html` at 1600 × 1000, scale 1. |

Rules for implementers:

1. Use only tokens from `tokens.css` for colours, sizes and durations.
2. Do not write a hex value in component CSS.
3. If you need a value that is not in `tokens.css`, add a token. Do not hard-code it.
4. Copy the HTML structure and class logic of `mockup.html` when a component looks the same.
5. When this document and the mockup do not agree, this document is correct.

---

## 1. Design direction

DeepGit is a Git client for professional developers.
The base is the JetBrains New UI "Islands" theme, the same base as Prometeo DataGrip.
Token names and base values are identical to Prometeo DataGrip (`--dg-*`).

Four principles control every decision:

1. **Multi-repo is the default view, not a special mode.** A project with one repository is a project with a list of one. Every list, filter, toast and dialog must handle N repositories.
2. **Colour carries state, not identity.** A repository or a project has no colour of its own: a neutral icon and its name identify it. Colour means the same thing in every view: added, modified, deleted, ahead, behind, error, success, the kind of a ref, the selected row.
3. **Show the git command.** Every operation writes its exact git command to the Git console. The status bar shows the last command. Users trust what they can see.
4. **Dense and calm.** Rows are 24 px. Text is 13 px. Chrome is quiet grey. Only state uses colour: refs, status letters, diff, ahead/behind, conflicts.

Where DeepGit spends its boldness: the **branch matrix** and the **sync strip**. The rest of the UI stays close to JetBrains so that IntelliJ users feel at home on the first day.

---

## 2. Window layout

### 2.1 Structure

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ TITLE BAR 40px: logo · project ▾ · branch ▾ │ fetch pull push │  search  │ tools │ win  │
├────┬───────────────┬──────────────────────────────────────┬───────────────────────────┤
│ S  │ SIDEBAR       │ LOG island                           │ RIGHT column island       │
│ T  │ island        │  header 36 (tabs + actions)          │  header 36: tabs          │
│ R  │ 280 default   │  filter bar 32                       │  [Changed files]          │
│ I  │ 200..480      │  banner 34 (only when a repo is      │  [File changes]           │
│ P  │               │   mid-op)                            │ Changed files: commit     │
│ E  │               │  column header 26                    │  block + file tree        │
│    │               │  rows 24 each (virtualized)          │ File changes: diff of     │
│ 40 │               │                                      │  the selected file        │
│    │               │                                      │ 42 % of the row, min 320  │
│    │               ├──────────────────────────────────────┴───────────────────────────┤
│    │               │ BOTTOM tool window (optional): Git console / Branch matrix        │
├────┴───────────────┴──────────────────────────────────────────────────────────────────┤
│ STATUS BAR 28px: console ticker · progress ·                ·  repo · branch · fetch age  │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Measurements

| Element | Value | Token |
|---|---|---|
| Minimum window size | 1200 × 720 px | — |
| Reference window size | 1600 × 1000 px | — |
| Title bar height | 40 px | `--dg-titlebar-height` |
| Status bar height | 28 px | `--dg-statusbar-height` |
| Tool stripe width (left) | 40 px | `--dg-stripe-width` |
| Island corner radius | 10 px | `--dg-island-radius` |
| Gap between islands | 6 px | `--dg-island-gap` |
| Gap between last island and right window edge | 6 px | — |
| Gap between islands and title bar / status bar | 0 px (the bars have the window colour, so they read as the gap) | — |
| Sidebar width | default 280, min 200, max 480 px | `--dg-sidebar-*` |
| Right column width | default 42 % of the log + column row, min 320 px, max = row width − 480 px (maximized: row width − max(200 px, 15 %)) | `--dg-details-*` |
| Log minimum width | 480 px (200 px while the right column is maximized) | `--dg-log-min-width` |
| Bottom tool window height | default 20 % of the centre column, min 120 px | — |
| Island header height | 36 px, padding 0 8 0 12 | `--dg-panel-header-*` |
| Splitter drag zone | 6 px (the island gap) | `--dg-splitter-hit` |

### 2.3 Panel behaviour

1. The window background is `--dg-window-bg`. Each panel is an island with `--dg-island-bg`.
2. Splitters are invisible. The 6 px gap is the drag zone. Show `col-resize` or `row-resize` cursor on hover.
3. Double-click a splitter to reset the two panels to their default sizes.
4. Persist all panel sizes per project in the app config.
5. The right column is one island with two tabs, drawn like the tabs of the log island: **Changed files** (the commit block and the file tree of the selected commit) and **File changes** (the diff of the selected file). Both tabs stay mounted; the inactive one is only hidden, so the diff keeps its scroll position and the tree keeps its expanded folders and selection. The commit actions (copy hash, cherry-pick, more) sit at the right of the tabs and show only on **Changed files**.
6. There is no diff island under the log: the log and the Local changes list use the full height of the centre column (minus the optional bottom tool window).
7. A click (or `Enter`) on a file in **Changed files** opens it in **File changes**; arrow keys in the tree only move the selection. A file chosen in the Local changes list opens in **File changes** too. When the selected commit changes, the open file stays (shown at the new commit) if the new commit changes the same path in the same repository; otherwise the column returns to **Changed files**. `Ctrl+D` shows **File changes**; `Esc` inside the diff goes back to **Changed files** (focus on the tree); a second `Esc` returns the focus to the log.
8. **File changes** has a maximize button (and a double-click on its tab) that widens the column to most of the row; a second toggle restores it. Dragging the splitter, or leaving the tab, also restores it. The persisted width is `split.details`; an old or too large value is clamped.
9. In a diff pane narrower than 720 px the diff uses the unified layout, unless the user chose a layout in this session (header switch or `Ctrl+Alt+D`). The header then shows icon-only layout buttons and a short "2/9" change counter.
10. Opening a diff in a separate window is not built.
11. The sidebar can be hidden with `Alt+1`. The stripe button stays visible.

### 2.4 Window shell (Tauri)

1. Use `decorations: false` in Tauri. Draw the title bar in the web view.
2. Mark the empty title bar area with `data-tauri-drag-region`.
3. Double-click the empty title bar to maximize or restore.
4. Draw window controls (minimize, maximize, close) at the right: 46 × 40 px each. Close hover background is `#C42B1C` in both themes.
5. Round window corners are the job of the window manager. Do not draw them.

---

## 3. Typography

| Role | Family | Size / line height | Weight | Token |
|---|---|---|---|---|
| UI default | Inter | 13 / 16 | 400 | `--dg-font-size` |
| UI secondary (author, date, captions) | Inter | 12 / 16 | 400 | `--dg-font-size-medium` |
| Small (pills, badges, counters, status letters) | Inter | 11 / 14 | 500 or 600 | `--dg-font-size-small` |
| Island title, dialog title | Inter | 13 / 16 | 600 | — |
| Commit subject in details | Inter | 15 / 20 | 600 | — |
| Empty-state heading | Inter | 16 / 22 | 600 | `--dg-font-size-h3` |
| Onboarding heading | Inter | 22 / 28 | 600 | `--dg-font-size-h1` |
| Hash in log | JetBrains Mono | 11.5 / 16 | 400 | — |
| Code in diff, console | JetBrains Mono | 12 / 20 | 400 | `--dg-font-size-mono`, `--dg-line-height-code` |

Rules:

1. Bundle Inter 4 and JetBrains Mono 2.304 with the app. Copy them from `prometeo-datagrip/src/theme/fonts/`. Do not load fonts from the network.
2. Use `font-variant-numeric: tabular-nums` for all numbers in columns, badges and counters.
3. Use sentence case for all labels, buttons and menu items. Do not use all caps. The only exception is the `HEAD` pill.
4. Use the mono family only for hashes, paths in the console, code and git commands. Do not use it for labels.
5. Truncate with an ellipsis at the end. For paths, truncate in the middle (`src/…/controller.rs`). For branch names, keep the last segment visible (`feature/…/PAY-2318-refunds`).

---

## 4. Colour

The neutral base is in `tokens.css` (tables in 4.3, generated from that file). Every colour that carries meaning is in `colors.css`: the colour system v2 of section 4.4.

### 4.1 How colour assignment works

1. **Repositories and projects have no colour.** Do not derive a colour from a repository or project. Show the name on a neutral repo chip, or a neutral repository icon next to the name.
2. **Lane colour.** Use `--dg-lane-{laneIndex % 10}` in the single-repo log and in the combined log. Lane 0 is always the lane of the first-parent chain of HEAD, so HEAD is always blue.
3. **Avatar colour.** Compute `hash(lowercase(email)) % 12`. Use `--dg-avatar-{n}`. Use FNV-1a 32-bit as the hash, so the colour is stable between sessions and machines.
4. **Repo chip.** Neutral badge: `--dg-badge-bg` (the neutral wash) background, `--dg-text-muted` text, a 1 px `--dg-separator` edge. The same for every repository.
5. **Everything else.** Use the hue families of 4.4. A colour always means a state, never an identity.

### 4.2 Contrast rules

1. Body text on island background must have a contrast of 7:1 or more. `--dg-text` on `--dg-island-bg` is 11.9:1 (dark).
2. Secondary and muted text must have 4.5:1 or more on every surface and on a hovered row. On a coloured wash they switch to `--dg-text-muted-on-wash` (4.4 rule 13).
3. Coloured text (`--dg-<family>-fg`, pill text, status letters) must have 4.5:1 or more on every surface it is drawn on, washes included. Non-text indicators (dots, rings, edges, lanes) must have 3:1 or more. `colors.test.ts` enforces all of this.
4. Do not show state by colour alone. Each state has a letter, an icon or a shape too (status letters, `↑`/`↓`, dot versus ring).

### 4.3 Token tables

Values are `#RRGGBB` or `#RRGGBBAA`. Metrics, motion and font tokens are in the `:root` block of `tokens.css` and in sections 2, 3 and 7.

#### Core surfaces (shared with DataGrip)

| Token | Dark | Light | Use |
|---|---|---|---|
| `--dg-window-bg` | `#26282C` | `#E9EAEE` | gaps between islands, title bar, status bar |
| `--dg-island-bg` | `#191A1C` | `#FFFFFF` | every island (sidebar, log, details, diff) |
| `--dg-panel-bg` | `#191A1C` | `#F7F8F9` |  |
| `--dg-dialog-bg` | `#191A1C` | `#F7F8F9` |  |
| `--dg-layer-1-bg` | `#26282C` | `#F7F8F9` | raised surface inside an island (filter bar inputs, headers) |
| `--dg-layer-2-bg` | `#33353B` | `#FFFFFF` | floating: toasts, tooltips |
| `--dg-border` | `#26282C` | `#E9EAEE` |  |
| `--dg-separator` | `#33353B` | `#E9EAEE` |  |
| `--dg-island-header-border` | `#26282C` | `#EBECF0` |  |

#### Text

| Token | Dark | Light | Use |
|---|---|---|---|
| `--dg-text` | `#D1D3D9` | `#000000` |  |
| `--dg-text-secondary` | `#969AA2` | `#5F6269` |  |
| `--dg-text-muted` | `#9FA2A8` | `#5F6269` |  |
| `--dg-text-disabled` | `#4C4F56` | `#9FA2A8` |  |
| `--dg-text-over-accent` | `#FFFFFF` | `#FFFFFF` |  |

#### Accent / interaction

| Token | Dark | Light | Use |
|---|---|---|---|
| `--dg-hover-bg` | `#FFFFFF17` | `#00000012` | icon buttons, toolbar |
| `--dg-pressed-bg` | `#FFFFFF29` | `#00000020` |  |

#### Title bar / stripe / status bar

| Token | Dark | Light | Use |
|---|---|---|---|
| `--dg-toolbar-bg` | `#26282C` | `#E9EAEE` |  |
| `--dg-toolbar-fg` | `#D1D3D9` | `#000000` |  |
| `--dg-toolbar-separator` | `#FFFFFF21` | `#00000020` |  |
| `--dg-stripe-bg` | `#26282C` | `#E9EAEE` |  |
| `--dg-stripe-button-fg` | `#9FA2A8` | `#5F6269` |  |
| `--dg-statusbar-bg` | `#26282C` | `#E9EAEE` |  |
| `--dg-statusbar-fg` | `#B4B7BE` | `#505359` |  |
| `--dg-statusbar-hover-bg` | `#FFFFFF17` | `#00000012` |  |
| `--dg-statusbar-hover-fg` | `#D1D3D9` | `#000000` |  |

#### Controls

| Token | Dark | Light | Use |
|---|---|---|---|
| `--dg-button-border` | `#40434A` | `#D1D3D9` |  |
| `--dg-button-disabled-fg` | `#4C4F56` | `#9FA2A8` |  |
| `--dg-button-disabled-border` | `#33353B` | `#E9EAEE` |  |
| `--dg-input-bg` | `#191A1C` | `#FFFFFF` |  |
| `--dg-input-fg` | `#D1D3D9` | `#000000` |  |
| `--dg-input-border` | `#40434A` | `#D1D3D9` |  |
| `--dg-input-placeholder` | `#73767C` | `#9FA2A8` |  |
| `--dg-combo-bg` | `#26282C` | `#FFFFFF` |  |
| `--dg-checkbox-bg` | `#2B2D30` | `#FFFFFF` |  |
| `--dg-checkbox-border` | `#5A5D63` | `#B4B7BD` |  |
| `--dg-checkbox-check` | `#FFFFFF` | `#FFFFFF` |  |
| `--dg-toggle-off-bg` | `#FFFFFF3B` | `#0000002E` |  |
| `--dg-chip-bg` | `#26282C` | `#FFFFFF` | filter chip |
| `--dg-chip-border` | `#40434A` | `#D1D3D9` |  |
| `--dg-kbd-bg` | `#FFFFFF12` | `#0000000A` | keycap in menus, palette, empty states |
| `--dg-kbd-border` | `#FFFFFF1F` | `#0000001F` |  |
| `--dg-kbd-fg` | `#9FA2A8` | `#5F6269` |  |

#### Popups / menus / tooltips

| Token | Dark | Light | Use |
|---|---|---|---|
| `--dg-popup-bg` | `#26282C` | `#FFFFFF` |  |
| `--dg-popup-border` | `#33353B` | `#D1D3D9` |  |
| `--dg-popup-shadow` | `0 8px 24px #00000066, 0 0 0 1px #00000033` | `0 8px 24px #00000026, 0 0 0 1px #0000000F` |  |
| `--dg-menu-accelerator-fg` | `var(--dg-text-secondary)` | `var(--dg-text-secondary)` |  |
| `--dg-tooltip-bg` | `#33353B` | `#FFFFFF` |  |
| `--dg-tooltip-fg` | `#D1D3D9` | `#000000` |  |
| `--dg-scrim` | `#0000008C` | `#00000052` | behind modal dialogs |

#### Scrollbars

| Token | Dark | Light | Use |
|---|---|---|---|
| `--dg-scrollbar-thumb` | `#80808059` | `#73737333` |  |
| `--dg-scrollbar-thumb-hover` | `#8080808C` | `#7373735C` |  |
| `--dg-scrollbar-track-hover` | `#8080801A` | `#7373731A` |  |

#### Notifications / banners

| Token | Dark | Light | Use |
|---|---|---|---|
| `--dg-notification-bg` | `#33353B` | `#FFFFFF` |  |
| `--dg-notification-fg` | `#D1D3D9` | `#000000` |  |
| `--dg-progress-track` | `#40434A` | `#D1D3D9` |  |
| `--dg-icon` | `#C3C5CB` | `#6C707E` |  |
| `--dg-icon-secondary` | `#868A91` | `#818594` |  |
| `--dg-icon-disabled` | `#5F6269` | `#A8ADBD` |  |

#### Editor / code (Islands Dark scheme)

| Token | Dark | Light | Use |
|---|---|---|---|
| `--dg-editor-bg` | `#191A1C` | `#FFFFFF` |  |
| `--dg-editor-fg` | `#BCBEC4` | `#080808` |  |
| `--dg-editor-line-number` | `#4B5059` | `#AEB3C2` |  |
| `--dg-editor-line-number-current` | `#A1A3AB` | `#767A8A` |  |
| `--dg-editor-caret-row` | `#1F2024` | `#F5F8FE` |  |
| `--dg-editor-keyword` | `#CF8E6D` | `#0033B3` |  |
| `--dg-editor-string` | `#6AAB73` | `#067D17` |  |
| `--dg-editor-number` | `#2AACB8` | `#1750EB` |  |
| `--dg-editor-comment` | `#7A7E85` | `#8C8C8C` |  |
| `--dg-editor-function` | `#56A8F5` | `#00627A` |  |
| `--dg-editor-field` | `#C77DBB` | `#871094` |  |
| `--dg-editor-metadata` | `#B3AE60` | `#9E880D` |  |
| `--dg-editor-type` | `#16BAAC` | `#008080` |  |

#### Graph lanes (10). Lane colour = palette[laneIndex % 10].

| Token | Dark | Light | Use |
|---|---|---|---|
| `--dg-lane-0` | `#4C8DFF` | `#2563F5` | blue   - reserved first for the lane that holds HEAD |
| `--dg-lane-1` | `#2FE08A` | `#0B9454` | jade |
| `--dg-lane-2` | `#FFB52E` | `#AD6700` | amber |
| `--dg-lane-3` | `#D65CFF` | `#BF2FE0` | orchid |
| `--dg-lane-4` | `#FF5F7A` | `#E83A58` | rose |
| `--dg-lane-5` | `#22D8EE` | `#07829C` | cyan |
| `--dg-lane-6` | `#B6F03A` | `#5A8400` | lime |
| `--dg-lane-7` | `#FF8A33` | `#CC5A06` | tangerine |
| `--dg-lane-8` | `#8F8CFF` | `#5B57E8` | periwinkle |
| `--dg-lane-9` | `#FF63B4` | `#E0287F` | pink |
| `--dg-lane-dim-opacity` | `0.32` | `0.28` | lanes not on the selected commit's path when "highlight path" is on |
| `--dg-graph-node-stroke` | `#191A1C` | `#FFFFFF` | 1.5px ring that cuts the node out of the edges |
| `--dg-graph-head-ring` | `#D1D3D9` | `#000000` | outer ring of HEAD node |
| `--dg-graph-wip-stroke` | `#9FA2A8` | `#73767C` | dashed hollow node of the "Uncommitted changes" row |

#### Repo palette

> Removed. Repositories and projects have no colour (4.1 rule 1). There are no `--dg-repo-*` tokens.

#### Ref pills

All tokens of this group are aliases of the colour system: see 4.4.

#### Ahead / behind / dirty

| Token | Dark | Light | Use |
|---|---|---|---|
| `--dg-clean-dot` | `#4C4F56` | `#B4B7BD` | clean (hollow ring) |

#### File status (letter colour; file name uses the same colour)

All tokens of this group are aliases of the colour system: see 4.4.

#### Diff

| Token | Dark | Light | Use |
|---|---|---|---|
| `--dg-diff-filler-bg` | `#1D1E21` | `#F7F8F9` | empty side in side-by-side, drawn with hatch |
| `--dg-diff-filler-hatch` | `#FFFFFF08` | `#0000000A` |  |
| `--dg-diff-connector` | `#FFFFFF0D` | `#0000000A` | band between the two sides |

#### Avatars (initials). Colour = palette[hash(lower(email)) % 12]. Text is #FFFFFF at 600.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--dg-avatar-0` | `#3F6FC9` | `#3F6FC9` |  |
| `--dg-avatar-1` | `#2E8A6B` | `#2E8A6B` |  |
| `--dg-avatar-2` | `#B0742A` | `#B0742A` |  |
| `--dg-avatar-3` | `#8A4FB5` | `#8A4FB5` |  |
| `--dg-avatar-4` | `#B5485A` | `#B5485A` |  |
| `--dg-avatar-5` | `#2B8C9E` | `#2B8C9E` |  |
| `--dg-avatar-6` | `#6D8A2E` | `#6D8A2E` |  |
| `--dg-avatar-7` | `#B85E34` | `#B85E34` |  |
| `--dg-avatar-8` | `#5A62C2` | `#5A62C2` |  |
| `--dg-avatar-9` | `#A84E8E` | `#A84E8E` |  |
| `--dg-avatar-10` | `#5F7387` | `#5F7387` |  |
| `--dg-avatar-11` | `#8C7A2E` | `#8C7A2E` |  |
| `--dg-avatar-fg` | `#FFFFFF` | `#FFFFFF` |  |

#### Log

| Token | Dark | Light | Use |
|---|---|---|---|
| `--dg-log-date-header-fg` | `var(--dg-text-secondary)` | `var(--dg-text-secondary)` | sticky "Today", "Yesterday" rows |
| `--dg-log-date-header-bg` | `#191A1C` | `#FFFFFF` |  |
| `--dg-log-hash-fg` | `var(--dg-text-secondary)` | `var(--dg-text-secondary)` |  |
| `--dg-log-unreachable-fg` | `#73767C` | `#9FA2A8` | commits not reachable from a visible ref (filtered context) |
| `--dg-ruler-selection` | `#D1D3D9` | `#000000` |  |

#### Branch Matrix (synchronous branch control)

| Token | Dark | Light | Use |
|---|---|---|---|
| `--dg-matrix-cell-bg` | `#1F2024` | `#F7F8F9` |  |
| `--dg-matrix-cell-hover-bg` | `#26282C` | `#EBECF0` |  |
| `--dg-matrix-missing` | `#33353B` | `#DFE1E5` | dash: branch not in this repo |

#### Git console

| Token | Dark | Light | Use |
|---|---|---|---|
| `--dg-console-bg` | `#191A1C` | `#FFFFFF` |  |
| `--dg-console-fg` | `#BCBEC4` | `#080808` |  |
| `--dg-console-repo` | `#9FA2A8` | `#5F6269` | "[api-gateway]" prefix |
| `--dg-console-duration` | `var(--dg-text-secondary)` | `var(--dg-text-secondary)` |  |


### 4.4 Colour system v2

**Idea.** The DataGrip look: calm JetBrains Islands surfaces, and saturated, electric hues laid over them as low-alpha washes. Colour always means something: selection and focus, a ref kind, a file state, a result. Repositories and projects never get a colour (4.1 rule 1).

**Where it lives.** `tokens.css` holds the neutral base (surfaces, text, neutral controls, editor, avatars, metrics). `colors.css` holds every colour that carries meaning: seven hue families, and every semantic token (selection, ref pills, file status, diff, merge, banners, toasts, ahead/behind, matrix, console) as an alias of a family token. Feature CSS uses these tokens only. It never writes a hex value (`colors.test.ts` checks this).

**Tokens of a family `<fam>`.**

| Token | What it is | Use |
|---|---|---|
| `--dg-<fam>` | vivid solid, 3:1 or more on every surface | dots, icons, lines, left edges, rings, the source of the washes |
| `--dg-<fam>-fill` | deeper solid, white text on it is 4.5:1 or more | filled controls: primary and danger buttons, HEAD pill, Push |
| `--dg-<fam>-fg` | text colour, 4.5:1 or more on every surface and on its own washes | coloured text: status letters and names, pill text, links |
| `--dg-<fam>-wash-soft` | `color-mix(in srgb, <solid> soft%, transparent)` | hover, quiet highlights (a conflicted row) |
| `--dg-<fam>-wash` | the same with the normal strength | badges, pills, banners, unfocused selection, tonal buttons |
| `--dg-<fam>-wash-strong` | the same with the strong strength | focused selection, active states, current branch, operation banner |
| `--dg-<fam>-border` | the same at the border strength | 1 px edge of a washed element |

The washes are transparent, so they work on every surface. Where an opaque colour is needed (diff lines under a sticky gutter, merge chunks, toasts, the title bar glow) the same solid is mixed into the surface: `color-mix(in srgb, <solid> N%, <surface>)`.

**Palette.**

| Family | Means | Dark solid / fill / fg | Light solid / fill / fg |
|---|---|---|---|
| accent (electric blue) | selection, focus, active tab, primary action, behind, renamed, modified merge chunk, progress | `#4A86FF` / `#2862EB` / `#A8C8FF` | `#2563F5` / `#2563F5` / `#1442B8` |
| success (green) | added, ahead, current branch, local branch pill, success, fresh fetch, Push | `#2ED98A` / `#147D49` / `#7DF0BC` | `#07844A` / `#0B7D46` / `#055C34` |
| warning (amber) | modified, tags, warnings, text-filter match, diverged, aging fetch, dirty tree | `#FFB224` / `#9A6100` / `#FFCF6E` | `#AD6600` / `#A85F00` / `#724300` |
| danger (coral red) | deleted, conflicts, errors, failed commands, stale fetch | `#FF5C6C` / `#D4364A` / `#FFA3AD` | `#DC2F45` / `#D02A40` / `#961628` |
| info (cyan) | information, untracked, stashes, hunk headers, git command text, the progress gradient end | `#22D3EE` / `#0B7F94` / `#7AE6F7` | `#06819D` / `#087C96` / `#055769` |
| special (violet) | remote branches, only-on-origin, merge / rebase / cherry-pick in progress, type change | `#B57BFF` / `#7C4DE0` / `#DEC4FF` | `#8B45F2` / `#7A35E0` / `#5C20B8` |
| neutral (grey) | counters, repo chip, "+3" pill, ignored, deleted merge chunk | `#8E939E` / `#5B6070` / `#C3C7CF` | `#6E7382` / `#5B6070` / `#474C59` |

**Wash strengths** (`--dg-wash-*-a`, per theme; light needs less to look as strong).

| Strength | Dark | Light |
|---|---|---|
| soft | 8 % | 6 % |
| normal | 16 % | 11 % |
| strong | 24 % | 18 % |
| border | 45 % | 40 % |
| diff line / gutter / word | 13 / 19 / 30 % | 12 / 18 / 30 % |
| merge chunk / changed word | 17 / 18 % | 15 / 24 % |
| title bar glow accent / violet, status bar glow | 18 / 10 / 10 % | 16 / 10 / 10 % |

**Rules.**

1. **Selection.** A selected row is `--dg-selection-bg` (accent strong wash) with a 2 px `--dg-selection-edge` bar at the left when its list has the focus, and `--dg-selection-inactive-bg` (accent wash, no bar) when it has not. Hover is `--dg-row-hover-bg` (accent soft wash). Logs, trees, Local changes, the matrix, Search Everywhere, menus, selects, the branch popup, the conflicts table and the Settings section list all do this.
2. **Active tab.** `--dg-tab-active-bg` (accent wash), `--dg-tab-active-fg` text and a 2 px `--dg-selection-edge` underline: Log / Local changes, Changed files / File changes, Git console / Branch matrix, the Search Everywhere tabs. Toggled icon buttons and tool stripe buttons: accent strong wash, accent text, 1 px accent border. A selected matrix column: accent wash down the column and an accent underline on its header.
3. **Focus ring.** `--dg-focus-ring` is the accent solid.
4. **Ref pills.** HEAD: accent fill, white text. Local branch: success wash, fg and border (current branch: the strong wash and bold). Remote branch: special. Tag: warning. Stash: info. "+3": neutral.
5. **Ahead and behind.** Ahead is green (`--dg-ahead-*`, success), behind is blue (`--dg-behind-*`, accent), both is amber (`--dg-diverged-*`, warning wash and border). The same capsule everywhere: sidebar, sync strip, matrix, status bar, branch popup, Search Everywhere. Push with commits to push: a success wash on the title bar button.
6. **File status.** Letter and file name in `--dg-status-*`: added success, modified warning, deleted danger (and struck through), renamed and copied accent, untracked info, conflicted danger (and the row gets a danger soft wash, a strong one when selected), type change special, ignored neutral. The same in Changed files, Local changes, the diff header, Search Everywhere, the conflicts dialog and the merge window title. The name keeps its colour on a selected row.
7. **Diff.** Added lines are success, removed lines are danger, modified lines (side by side) are accent; the changed words are the stronger mix of the same family. Hunk headers are an info wash with info text and a 1 px info edge. Merge window chunks: conflict danger, modified accent, inserted success, deleted neutral; changed words in a chunk are its marker at `--dg-merge-word-a`.
8. **Banners.** An operation in progress (merge, rebase, cherry-pick, revert) is the special strong wash with a special border and a 3 px special bar at the left. Errors are the danger wash, warnings the warning wash, done states the success wash, information the info wash, each with its border and a 3 px bar.
9. **Toasts.** The toast surface with its family mixed in (`--dg-toast-<kind>-bg`), a 1 px family border, a 3 px family bar at the left and the icon in the family fg: success, info, warning, error.
10. **Console.** The command and `$` are info fg. Exit 0 is success fg. The line of a failed command has a danger wash and a 2 px danger bar; its stderr is danger fg. stderr of a command that worked stays warning fg (git writes progress there).
11. **Buttons.** Primary: accent fill. Danger: danger fill. Tonal (`variant="tonal"` / `"tonal-danger"`): the wash, the fg and the border of accent or danger. The git command preview in dialogs is an info wash with an info bar.
12. **Glow.** The title bar is a gradient from `--dg-toolbar-tint` (accent mixed into the window colour) through `--dg-toolbar-tint-2` (violet) to the plain bar at 72 %. The status bar has a weaker accent glow at the left. Dialogs and Search Everywhere have a soft accent wash at the top (`--dg-dialog-glow`). The Welcome screen has an accent glow behind the logo and a violet one in a corner; its cards each get a family (accent, success, special, info) for the top edge and the icon tile.
13. **Text on a wash.** Muted and secondary text is too weak on a coloured wash. Inside a selected row, a banner, a toast, the command preview and an active tab, `colors.css` section 4 sets them to `--dg-text-muted-on-wash`.
14. **Motion.** The colour system adds no transition of its own. Existing transitions keep their `prefers-reduced-motion` rules.

**Contrast guarantee** (`src/theme/colors.test.ts`). The test reads the real `tokens.css`, `extra.css` and `colors.css`, resolves `var()` and `color-mix` like the browser, and checks both themes: every `*-fg` on every surface (window, island, panel, raised, popup, dialog, console, editor), plain and under each wash of its family, on a hovered row and on both selected-row backgrounds, and as a pill on a selected row (4.5:1); body and on-wash text on every wash (4.5:1); family solids, lanes, the focus ring and the selection edge (3:1); white on every fill, the primary and danger buttons, Push, HEAD and the project badge (4.5:1); ref pills, ahead/behind, file status, diff and merge lines and words, toasts, banners, console lines, the title bar and status bar glow. It also fails when a stylesheet or a component uses a token that is not defined, and when feature CSS has a hex colour.

---

## 5. Components

States use these tokens unless a component says something different:

| State | Background | Text / icon | Other |
|---|---|---|---|
| Default | transparent | `--dg-text` / `--dg-icon` | — |
| Hover (row) | `--dg-row-hover-bg` (accent soft wash) | unchanged | No transition. |
| Hover (button, icon button) | `--dg-hover-bg` | unchanged | — |
| Pressed | `--dg-pressed-bg` | unchanged | — |
| Selected, component focused | `--dg-selection-bg` (accent strong wash) | `--dg-selection-fg` | 2 px `--dg-selection-edge` bar at the left (4.4 rule 1). |
| Selected, component not focused | `--dg-selection-inactive-bg` (accent wash) | `--dg-selection-fg` | No bar. |
| Toggled on (icon button) | `--dg-toolbar-selected-bg` (accent strong wash) | `--dg-toolbar-selected-fg` icon | 1 px `--dg-accent-border`. |
| Keyboard focus | unchanged | unchanged | 2 px ring `--dg-focus-ring`, offset 0 for inputs, inset for rows. Show only for keyboard focus (`:focus-visible`). |
| Disabled | transparent | `--dg-text-disabled` / `--dg-icon-disabled` | No hover. Tooltip still explains why it is disabled. |

### 5.1 Title bar (40 px)

Order from left to right:

| # | Element | Size | Behaviour |
|---|---|---|---|
| 1 | App mark | 20 × 20, left padding 10, right gap 8 | Click opens the app menu (File, Edit, View, Git, Help). |
| 2 | Project switcher | height 30, radius 6, padding 0 6 0 10 | 20 × 20 project badge (two initials, gradient from project colour) + project name 13/600 + chevron 14. Click opens the project popup: recent projects, "Add project folder…", "Manage projects…". Shortcut `Ctrl+Alt+P`. |
| 3 | Branch widget | height 30 | Branch icon + current branch 13/600 + secondary text 12. Single repo: secondary text is the upstream state (`↑3 ↓1`). Multi-repo: secondary text is "N of M repos" (repos where this branch is current). Click opens the branch popup (5.20, rule 5). Shortcut `Ctrl+Shift+``. |
| 4 | Separator | 1 × 20, `--dg-toolbar-separator`, margin 0 6 | — |
| 5 | Fetch | 30 × 30, radius 6 | Fetch all repos of the project. Shows the fetch age ring (signature 11.4). |
| 6 | Pull | min 30 × 30 | Icon + number of incoming commits (blue, 11/600). Hide the number when 0. |
| 7 | Push | min 30 × 30 | Icon + number of outgoing commits. When the number is above 0, the button background is the push tint `color-mix(--dg-push-bg 22%)` and the icon is green. |
| 8 | Search Everywhere field | flex, max 440, height 28, radius 6, centred | Background `--dg-hover-bg`. Placeholder "Search commits, branches, files, actions". Keycaps "Shift Shift" at the right. Click opens the palette (5.15). |
| 9 | Git console button | 30 × 30 | Toggles the console tool window. |
| 10 | Notifications button | 30 × 30 | Blue 6 px dot when there are unread notifications. |
| 11 | Settings button | 30 × 30 | Opens settings. |
| 12 | Window controls | 3 × 46 × 40 | See 2.4. |

The numbers on Pull and Push are the sums for all repos in the project.
The tooltip on Pull and Push lists each repo with its count.

### 5.2 Tool stripe (40 px)

1. Buttons are 30 × 30, radius 6, icon 18 px, gap 4, centred in the 40 px column.
2. Top group: Project (`Alt+1`), Local changes (`Alt+0`), Branch matrix (`Alt+2`), Stashes (`Alt+3`).
3. Bottom group: Git console (`Alt+9`), Notifications.
4. The selected button has `--dg-stripe-button-selected-bg` and a white icon.
5. A counter badge sits at the bottom right of the button: height 14, min width 14, radius 7, 9/600 text, 2 px ring of `--dg-window-bg`. Local changes shows the number of changed files.

### 5.3 Sidebar (Project island)

Content from top to bottom:

1. **Header** (36 px): title "Project", then icon buttons Fetch all, Add repository, More.
2. **Project card** (52 px): 32 × 32 project badge (radius 8), name 13/600, path and repo count 12 secondary. Bottom border 1 px `--dg-separator`, side margin 8.
3. **Sync strip** (signature 11.2). Shows only when the project has more than one repo and the current branch of the focused repo exists in more than one repo.
4. **Section label** "Repositories" (12/500 secondary, padding 8 8 4) with a right-aligned hint ("5 of 12 shown in log") when the log filter hides repos.
5. **Repository tree.**

Repository row (26 px):

| Part | Spec |
|---|---|
| Chevron | 14 px, `--dg-icon-secondary`. |
| Repository icon | 14 px, `--dg-icon-secondary`. The same for every repository. Click it to show or hide the repository in the log. |
| Name | 13/500, no shrink. |
| Branch | 12 secondary, flex, ellipsis. In a merge/rebase/cherry-pick state, show the state ("rebasing 3/7") in `--dg-text-error`. Detached HEAD shows the short hash in mono. |
| Ahead/behind capsule | See 5.4. Hidden when both are 0. |
| State dot | 8 px. Clean: ring 1.5 px `--dg-clean-dot`. Dirty: filled `--dg-dirty-dot`. Conflict or operation in progress: filled `--dg-conflict-dot` with a 3 px halo at 22 %. |

Rules:

1. Repos hidden by the log repo filter show name and branch at 55 % opacity.
2. Child nodes of an expanded repo, at indent 16 px per level: Local (branches), origin (one node per remote), Tags, Stashes, Submodules. Show counts in 12 secondary after the label.
3. Branch rows show: branch icon, name, ahead/behind capsule against upstream, a "gone" tag (11, 1 px border, radius 4) when the upstream was deleted.
4. The current branch has a green icon (`--dg-ref-local-fg`) and 600 weight.
5. Remote lists longer than 8 show the first 2 and a link "N more…". The link expands the list.
6. Nested repositories show under their parent repo as children with the same row format, after Submodules.
7. Speed search: typing in the focused tree filters and highlights matches with `--dg-match-fg`. This is the JetBrains behaviour.
8. Double-click a local branch to check it out. Double-click a remote branch to create a tracking branch and check it out.
9. Drag a branch onto another branch to open the Merge/Rebase menu (5.11).

### 5.4 Ahead/behind capsule

1. Height 16, radius 8, padding 0 5, background `--dg-badge-bg`, text 11/600 tabular.
2. Ahead is `↑N` in `--dg-ahead-fg`. Behind is `↓N` in `--dg-behind-fg`. Gap 4 between them.
3. When both are above 0 (diverged), add a 1 px inset ring of `--dg-diverged-fg` at 45 %.
4. Numbers above 999 show as "999+".
5. Tooltip: "3 commits to push to origin/feature/PAY-2318-refunds. 0 to pull."

### 5.5 Commit log

#### Header and tabs

1. The island header holds segmented tabs: "Log" and "Local changes" (with file count). Tab height 28, radius 6, padding 0 10.
2. The selected tab has `--dg-selection-muted-bg` and a 1 px inset ring `--dg-chip-active-border`.
3. The Log tab shows a secondary text: "combined · N repos" in multi-repo mode, or the repo name in single-repo mode.
4. Right side icon buttons: Highlight path (toggle), Refresh.

#### Filter bar (height 32 incl. 8 bottom padding)

| Control | Spec |
|---|---|
| Text filter | 220 × 26, radius 4, input style. Placeholder "Filter by text or hash". Keycap `Ctrl+F`. Matches subject, body, hash prefix and author. Supports `author:`, `path:`, `before:`, `after:` prefixes. Debounce 150 ms. |
| Chip "Repos" | Shows a repository icon + "Repos: 5 of 12". Popup: checklist of repos with a repository icon, "All", "Only this" (on hover per row). |
| Chip "Branch" | "Branch: all", "Branch: HEAD", or a branch name. Popup: branch list with search; multi-select. In combined mode, a branch name matches in every repo that has it. |
| Chip "Author" | Popup: author list with avatars, "Me" first. |
| Chip "Date" | Popup: Last 24 h, Last 7 days, Last 30 days, Custom range. |
| Chip "Path" | Popup: file tree of the union of repos with a search field. |

Chip spec: height 24, radius 12, padding 0 6 0 8, 12 text, 1 px inset ring `--dg-chip-border`, 14 px leading icon and trailing chevron. An active chip uses `--dg-chip-active-bg`, ring `--dg-chip-active-border` and `--dg-text`. An active chip shows a 12 px clear button instead of the chevron on hover.

#### Operation banner (34 px)

1. Show one banner for each repo with a merge, rebase, cherry-pick, revert or bisect in progress.
2. Margin 0 10 6, radius 6, operation colours (`--dg-banner-operation-*`: the special strong wash, a 3 px special bar at the left). Use error colours when there are unresolved conflicts and the user tried to continue. A banner about repositories that could not be loaded uses the warning colours.
3. Text: "**ledger-service**: rebase onto main is in progress. Step 3 of 7. 2 files have conflicts."
4. Buttons (24 px, small): "Resolve conflicts" (primary, only when conflicts exist), "Continue", "Skip" (rebase only), "Abort".
5. More than 2 banners collapse into one: "3 repos have an operation in progress." with "Show".

#### Columns

| Column | Width | Content |
|---|---|---|
| Graph | `16 + lanesInViewport × 14` px, min 30, max 220 | SVG graph. Recompute width when the visible lane count changes; animate width over `--dg-dur-base`. |
| Subject | flex, min 200 | Subject text, ref pills right-aligned. |
| Repository | 104 px | Repo chip (neutral, the repository name). Only in multi-repo mode. |
| Author | 124 px | 18 px avatar + name 12 muted. |
| Date | 56 px | 12 muted tabular. See date rules. |
| Hash | 66 px | Short hash (7 chars), mono 11.5, `--dg-log-hash-fg`. |
| Overview ruler | 14 px | Signature 11.5. |

Column header: 26 px, 12 secondary, 1 px top and bottom border `--dg-island-header-border`. Right-click the header to show or hide columns. Drag the header borders to resize.

#### Rows

1. Row height is 24 px (`--dg-log-row-height`). A "Comfortable" density option sets 28 px.
2. Subject text is 13/400. The HEAD commit subject is 13/600.
3. Commits that do not match the active text filter but are needed for graph context show in `--dg-log-unreachable-fg`.
4. Text filter matches in the subject get `--dg-log-match-bg` and `--dg-log-match-fg`.
5. Hover: `--dg-row-hover-bg`. Selection: `--dg-selection-bg` (focused) or `--dg-selection-inactive-bg`.
6. On the selected row, author, date and hash use `--dg-text`.
7. Multi-select with `Ctrl+click` and `Shift+click`. With 2 commits selected in one repo, the details panel shows the diff between them.

#### Date groups

1. Insert a 24 px group row before the first commit of each group: "Today", "Yesterday", "This week", "Last week", "Earlier this month", then "October 2026", "September 2026".
2. Group row: label 11/600 `--dg-log-date-header-fg`, then a 1 px line `--dg-separator` that fills the row. The graph continues through the group row.
3. The current group label sticks to the top of the log viewport.
4. Date column format: the user's **Date format** setting (Settings > Appearance), the same for every date of the UI (`state/dates.ts`): Relative "3 h ago", Absolute "10 Nov 2026, 14:32" (locale order and words), ISO "2026-11-10 14:32". The column is as wide as a date of that format (measured; a width set by the user wins). Group labels follow it too: Absolute and ISO add the day to "Today" / "Yesterday" ("Today, 10 Nov 2026"), and a month group is "October 2026" or "2026-10". Tooltip always shows the full date with time zone.
5. Use the commit date for ordering and the author date for display. The tooltip shows both if they differ.

#### Uncommitted changes row

1. When any visible repo has a dirty working tree, the first row is "Uncommitted changes" (italic, muted) + "14 files in 3 repos" (12 secondary).
2. The graph shows a hollow dashed node (`--dg-graph-wip-stroke`, dash 2 / 1.6) and a dashed edge to the HEAD commit (dash 3 / 3, 75 % opacity).
3. The Repository column of this row names the dirty repo, or shows "N repos".
4. The repository column shows overlapping dots of the dirty repos + "3 repos".
5. Click the row to open the Local changes tab.

#### Ref pills

| Ref type | Background | Border (1 px inset) | Text | Icon |
|---|---|---|---|---|
| HEAD | `--dg-ref-head-bg` | — | `--dg-ref-head-fg`, 11/600 | none, text "HEAD" |
| Current branch | `--dg-ref-local-current-bg` | `--dg-ref-local-border` | `--dg-ref-local-fg`, 11/600 | branch |
| Local branch | `--dg-ref-local-bg` | `--dg-ref-local-border` | `--dg-ref-local-fg`, 11/500 | branch |
| Remote branch | `--dg-ref-remote-bg` | `--dg-ref-remote-border` | `--dg-ref-remote-fg` | cloud |
| Tag | `--dg-ref-tag-bg` | `--dg-ref-tag-border` | `--dg-ref-tag-fg` | tag |
| Stash | `--dg-ref-stash-bg` | `--dg-ref-stash-border` | `--dg-ref-stash-fg` | box |
| Overflow "+N" | `--dg-ref-overflow-bg` | — | `--dg-ref-overflow-fg` | none |

Pill geometry: height 16, radius 4, padding 0 5, icon 11 px, gap 3, max width 150 (label ellipsis).

Pill rules:

1. **Split pill.** When HEAD points to a branch, draw one pill with two segments: "HEAD" (blue) and the branch (current-branch style). Max width 220.
2. **Synced pill.** When a local branch and its upstream point to the same commit, draw one local pill and add an 11 px cloud icon at 70 % opacity after the label. Tooltip: "main and origin/main".
3. Order: split pill or HEAD, local branches, remote branches, tags.
4. Show at most 2 pills. Put the rest in "+N". The "+N" tooltip lists all refs.
5. Pills are right-aligned inside the subject column with a gap of 4. The subject text truncates first. The subject keeps at least 40 px.

#### Avatars

1. 18 px circle in the log, 32 px in the details panel.
2. Two initials: first letter of the first and last words of the name. One word: first two letters. Text 8.5/600 (18 px) or 12/600 (32 px), `#FFFFFF`.
3. Do not load Gravatar in v1. The initials avatar is the design.

#### Virtualization (100 000 commits)

1. Rows have a fixed height. Render only the visible rows plus 20 rows above and below.
2. Draw the graph per row: each row owns one SVG of `graphWidth × 24` that holds the edge segments from y = 0 to y = 24 and its node. Do not use one SVG for the whole log.
3. The Rust backend computes the lane layout for each row and sends it in pages of 500 rows: `{ lane, color, edgesUp: [lanes], edgesDown: [lanes], nodeKind }`.
4. Scroll must keep 60 fps. Do not animate row content during scroll.
5. Keep the selected commit when the log reloads. If the commit no longer exists, select HEAD.

### 5.6 Graph rendering

| Item | Spec |
|---|---|
| Lane spacing | 14 px (`--dg-log-lane-width`). |
| Lane 0 centre | x = 14 px from the left of the graph column. |
| Edge | 2 px stroke, round caps. |
| Fork/merge edge | Cubic Bézier inside one row: `M x1 y1 C x1 ymid, x2 ymid, x2 y2`, where `ymid` is the row's vertical centre between the two node centres. Rules 1 and 2 say which row holds the curve. |
| Commit node | Circle r = 4, fill lane colour, 1.5 px stroke `--dg-graph-node-stroke` (cuts the node out of the edges). |
| Merge commit node | Circle r = 4, fill `--dg-island-bg`, 2 px stroke lane colour (hollow). |
| HEAD node | Circle r = 4.5 filled + outer ring r = 7, 2 px, lane colour at 35 % opacity. |
| Uncommitted node | Circle r = 4, hollow, dashed. See 5.5. |
| Highlight path | When on, edges and nodes that are not ancestors or descendants of the selected commit use `--dg-lane-dim-opacity`. |

Rules:

1. A curve that leaves a lane goes in the row directly below the child commit (merge to second parent).
2. A curve that joins an existing lane goes in the row directly above the parent commit (branch start).
3. A lane keeps its x position until it ends. Do not compact lanes in the middle of a branch.
4. In combined mode, each repo owns a contiguous lane group. Lane groups never connect. Order groups by the order of the repos in the sidebar.
5. Hover a node: show a tooltip with the full hash, author and the refs. Hover an edge: show the branch name of that lane.
6. Click an edge: select the commit at the near end of the edge.

### 5.7 Overview ruler (log)

See signature 11.5. Width 14, 1 px left border `--dg-island-header-border`. The scrollbar thumb lives inside it (3 px inset, radius 4).

### 5.8 Commit details island

Header (36 px): title "Commit", icon buttons Copy hash (`Ctrl+Shift+C`), Cherry-pick, More.

Body, padding 2 16 12:

1. **Identity row**: repo chip + full 40-char hash (mono 11, secondary, ellipsis). Click the hash to copy it. Show the toast "Copied 9f3c2a1".
2. **Subject**: 15/20, 600, margin bottom 8.
3. **Body**: 12.5/19, `--dg-text`. Render inline code in backticks with mono 12 on `--dg-layer-1-bg`, radius 3. Detect URLs and issue keys (`PAY-2318`, `#1287`) as links. Trailers (`Refs:`, `Co-authored-by:`, `Signed-off-by:`) show in 12 secondary.
4. **Person block** (top border 1 px `--dg-separator`, padding 10 0): 32 px avatar, name 13/600, email 12 secondary, line 2 "Authored today at 10:42, Tue 10 Nov 2026". When committer differs, add line 3 "Committed by Name on date".
5. **Meta grid** (columns 76 px / 1fr, row gap 8, text 12):
   - Parent / Parents: short hash link (mono 11.5, `--dg-text-link`) + subject in secondary. Click selects the parent in the log.
   - Branches: pills of branches that contain this commit. Show at most 4 and "+N".
   - Tags: nearest tag that contains the commit ("Released in v3.13.0") when it exists.
   - Push state: "Not on origin. 3 commits to push." in `--dg-text-warning` with the push icon, or "On origin/main" in secondary.
6. **Changed files** header (34 px, top border): "Changed files", count, `+138` (added colour), `−41` (deleted colour). Right: Tree / List toggle (icon buttons, toggled state).
7. **File tree** (rows 24): see 5.9.

Merge commits: show a selector above the file list: "Changes against: first parent ▾ / second parent / combined".

### 5.9 File rows (details, local changes)

| Part | Spec |
|---|---|
| Indent | 16 px per level. Folders compress single-child chains (`src/refunds`). |
| Chevron | 14 px for folders. 12 px spacer for files. |
| Icon | 16 px file-type icon in `--dg-icon-secondary`. |
| Name | Status colour (`--dg-status-*`). Deleted files have a 1 px line-through. |
| Rename source | "from refund_test.rs" in 11 secondary. |
| Line counts | `+N` and `−N`, 11 tabular, added / deleted colours. Hide zero. |
| Status letter | Mono 11, 12 px wide, centred, status colour. |

Status letters: `A` added, `M` modified, `D` deleted, `R` renamed, `C` copied, `U` conflict, `?` untracked, `!` ignored, `T` type change.

On the selected row, the name uses `--dg-text` so it stays readable on blue.

### 5.10 Diff viewer

Header (36 px, bottom border): file icon, path (directory in secondary, file name 13/500), status letter, `+N −N`. Right: change navigation, separator, mode segmented control, options menu.

| Control | Spec |
|---|---|
| Change navigation | Up icon, text "Change 3 of 6" (12 muted), down icon. `Shift+F7` previous, `F7` next. At the last change, `F7` moves to the next file. |
| Mode | Segmented control with "Side by side" and "Unified". Height 24, radius 6, 1 px ring. Selected segment `--dg-toolbar-selected-bg`, white text. Shortcut `Ctrl+Alt+D` toggles. |
| Options menu | Ignore whitespace (off / trailing / all), Word diff (on), Syntax colours (on), Collapse unchanged lines (on, keep 4 lines of context), Show line numbers (on). |

Side-by-side layout: `1fr 22px 1fr 12px` (left, connector gap, right, diff ruler).

1. Each side has a 24 px caption: short hash (mono 11) + "parent" / "this commit" (12 secondary). For local changes: "HEAD" and "Working tree" or "Index".
2. Line height 20 px, mono 12. Line number column 44 px, right-aligned, padding right 12, mono 11.5, `--dg-editor-line-number`.
3. Added line: `--dg-diff-added-bg`, gutter `--dg-diff-added-gutter-bg`.
4. Removed line: `--dg-diff-removed-bg`, gutter `--dg-diff-removed-gutter-bg`.
5. Changed block (lines removed and added at the same place): left side uses removed colours, right side uses added colours. Changed characters inside it use `--dg-diff-removed-word-bg` / `--dg-diff-added-word-bg` with radius 2.
6. Empty space on the other side: `--dg-diff-filler-bg` with a 135° hatch of 1 px lines every 6 px in `--dg-diff-filler-hatch`.
7. Hunk header row: `--dg-diff-hunk-header-bg`, text `--dg-diff-hunk-header-fg` mono 11.5: "@@ -40,11 +40,18 @@ impl RefundController". It spans both sides.
8. The focused change has a 2 px left bar `--dg-diff-hunk-active-border` on the left side.
9. The connector gap draws curved bands between related blocks in `--dg-diff-connector` (JetBrains style). The bands are optional in v1; the gap colour is required.
10. Both sides scroll together vertically. Horizontal scroll is per side and synced.
11. Diff ruler (12 px): marks for each change, green added, blue changed, red removed. The focused change has a 1 px `--dg-text` ring. Click a mark to jump.

Unified layout:

1. Columns: old line number 44 px, new line number 44 px, marker 16 px (`+` / `−` in marker colour), code.
2. Use the same backgrounds and word highlights as side-by-side.

Word diff: compute on the Rust side with a token diff (split on word boundaries and punctuation). Do not highlight when more than 60 % of the line changed; colour the line only.

Syntax colours: use the editor tokens (`--dg-editor-keyword`, `-string`, `-number`, `-comment`, `-function`, `-field`, `-metadata`, `-type`). Use a highlighter that runs in a worker (Shiki with a custom theme or tree-sitter on the Rust side). Turn syntax colours off for files above 1 MB.

Large and binary files:

1. Above 5 000 changed lines, show "This diff has 12 480 changed lines." with "Show diff" and "Open in external tool".
2. Binary files show "Binary file. 2.4 MB → 2.6 MB." For images, show the two images side by side with a checkerboard background.

### 5.11 Branch operations

#### Context menu on a commit (log)

Groups, separated by 9 px separators:

1. Copy hash `Ctrl+Shift+C` · Copy subject
2. Checkout revision… · New branch here… `Ctrl+Alt+N` · New tag here…
3. Cherry-pick · Revert commit · Reset current branch to here… · Interactive rebase from here… (v1.1, show disabled with tooltip "Coming in 1.1")
4. Compare with local · Show repository at revision
5. Open on origin (when the remote is GitHub, GitLab or Bitbucket)

#### Context menu on a branch (sidebar, ref pill, branch popup)

1. Checkout · New branch from "X"… · Checkout and rebase onto current
2. Merge "X" into "current" · Rebase "current" onto "X"
3. Compare with current · Show diff with working tree
4. Push… · Pull (current only) · Set upstream…
5. Rename… `F2` · Delete `Delete`
6. **Checkout "X" in all repos that have it** (multi-repo only, see 11.2)

Each menu item names the exact branches. Do not write "Merge selected". Write "Merge feature/x into main".

#### Dialogs

All dialogs: width 480 (wide 640), radius 10, padding 16 20, background `--dg-dialog-bg`, scrim `--dg-scrim`. Title 13/600. Buttons at the bottom right: secondary first, primary last. `Enter` runs the primary action. `Esc` closes.

Every dialog shows a **command preview** at the bottom: a mono 11.5 line on `--dg-layer-1-bg`, radius 4, padding 6 8: `$ git -C api-gateway reset --mixed 3c0e9b5`. The preview updates when options change.

| Dialog | Fields | Primary button |
|---|---|---|
| New branch | Name (validated live with `git check-ref-format`), base (read-only), checkbox "Check out" (on), multi-repo: repo checklist | "Create branch" |
| Rename branch | Name, checkbox "Also rename on origin" | "Rename" |
| Delete branch | Text "Delete feature/x? It has 2 commits that are not merged into main.", checkbox "Also delete origin/feature/x", checkbox "Force delete" (only when not merged) | "Delete" (danger) |
| Merge | Source, target (read-only), options: fast-forward (if possible / only / never), squash, commit message (when not fast-forward) | "Merge" |
| Rebase | Onto (branch picker), checkbox "Autostash" | "Rebase" |
| Reset | Mode radio: Soft (keep index and working tree), Mixed (keep working tree), Hard (discard everything). Hard shows a red warning line "Uncommitted changes in 4 files will be lost." | "Reset" (danger for hard) |
| Push | Target remote and branch, list of commits to push, checkbox "Force with lease" (never plain force), checkbox "Push tags" | "Push 3 commits" |
| Stash | Message, checkbox "Include untracked", checkbox "Keep index" | "Stash" |
| Checkout with changes | Text "Your local changes to 3 files would be overwritten.", options Stash and checkout, Force checkout, Cancel | "Stash and checkout" |

Destructive actions (hard reset, force delete, discard, drop stash) use `--dg-button-danger-bg` for the primary button. The button text always names the action ("Discard 3 files"). Never use "OK".

### 5.12 Local changes view

Location: tab "Local changes" in the log island. The **File changes** tab of the right column shows the selected file.

Layout of the tab (top to bottom):

1. **Repo scope bar** (32 px): chips of dirty repos with counts ("api-gateway 6", "ledger-service 5", "web-checkout 3"). Select one or more. Default: all dirty repos.
2. **Unstaged** section header (24 px): chevron, "Unstaged", count, right: "Stage all" icon button (`Ctrl+Alt+A`), "Discard all" icon button.
3. File rows (5.9) with a 16 px checkbox at the left. In multi-repo scope, group files by repo with a repo row (repository icon + name).
4. **Staged** section header, same structure, with "Unstage all".
5. **Commit message editor** at the bottom, min height 96, max 50 % of the island. JetBrains Mono 12/20. Subject line ruler at 72 chars (`--dg-editor-indent-guide`). Subject over 72 chars turns the counter warning colour. Placeholder "Commit message".
6. **Commit bar** (44 px): checkbox "Amend", checkbox "Sign off", flexible space, button "Commit" (primary, `Ctrl+Enter`), split button "Commit and push" (`Ctrl+Alt+K`).

Row actions on hover (right side, 22 px icon buttons): Stage / Unstage, Discard (with confirm dialog), Open file.

Hunk staging: in the **File changes** tab, each hunk gets a 20 px action strip at its top right: "Stage hunk", "Discard hunk". Line selection with `Shift+click` on line numbers enables "Stage selected lines".

Multi-repo commit: when the scope has more than one repo, the button text is "Commit in 3 repos". One message goes to all repos. The console shows one command per repo.

Amend: when "Amend" is on, fill the editor with the last commit message of the repo and change the button text to "Amend commit".

Keyboard: `Space` stages or unstages the selected file. `Delete` asks to discard. `Ctrl+M` focuses the message editor.

### 5.13 Conflict resolution (v1 minimum)

1. Conflicted files show with status `U` in `--dg-status-conflict`, at the top of Unstaged.
2. Selecting a conflicted file shows a three-pane diff: "Yours" (left), "Result" (centre), "Theirs" (right). Conflict blocks use `--dg-diff-conflict-bg`, marker `--dg-diff-conflict-marker`.
3. Each block has buttons "Accept yours", "Accept theirs", "Accept both".
4. File-level buttons: "Accept yours for file", "Accept theirs for file", "Mark as resolved".
5. "Open in external merge tool" uses `git mergetool` with the user's config.

### 5.14 Branch matrix (tool window, `Alt+2`)

See signature 11.2 for the full build instructions.

### 5.15 Search Everywhere / command palette

Open: `Shift Shift` (two presses within 300 ms) or `Ctrl+K`. `Ctrl+Shift+A` opens it on the Actions tab.

| Part | Spec |
|---|---|
| Panel | 640 wide, max 480 high, centred horizontally, top 80 px below the title bar. Radius 8. `--dg-popup-bg`, 1 px `--dg-popup-border`, `--dg-popup-shadow`. |
| Tabs | 28 px row: All, Commits, Branches, Files, Actions, Repos. `Tab` / `Shift+Tab` switch. |
| Input | 40 px, 14 px text, search icon, no border. Placeholder "Type to search". |
| Results | Rows 28 px, grouped by kind with a 22 px group label (11/600 secondary) and "more" link. Match characters in `--dg-match-fg` 600. |
| Footer | 24 px, 11 secondary: "↑↓ to move · Enter to open · Ctrl+Enter to open in new window". |

Result row contents:

- Commit: commit icon, subject, repo chip, short hash at right.
- Branch: branch icon, name, repo chips (all repos that have it), ahead/behind capsule.
- File: file icon, name, path secondary, repo chip.
- Action: action icon, name, shortcut keycaps at right.
- Repo: repository icon, name, branch, state dot.

Prefixes: `#` commits, `@` authors, `/` files, `>` actions, `:` repos. Fuzzy match on all.
Search must return the first results in under 50 ms for 100 000 commits. Rust indexes subjects and hashes at load time.

### 5.16 Notifications (toasts)

1. Toasts dock at the bottom of the sidebar column: left = stripe width + 6, bottom = status bar height + 6. Width = sidebar width − 12 (min 260, max 384). Reason: this area is usually empty, and toasts do not cover code or the log. When the sidebar is hidden, the width is 320.
2. Background `--dg-notification-bg`, radius 8, padding 12 14, `--dg-popup-shadow`.
3. Content: 16 px status icon + title 13/600 + close button; body 12/17 muted (max 3 lines); action links 12 `--dg-text-link`, gap 16.
4. Success and info toasts close after 6 s. Pause the timer on hover. Warnings and errors stay until closed.
5. Stack up to 3. Newer toasts are at the bottom. Older toasts collapse into "2 more notifications".
6. Every toast is also in the Notifications tool window.
7. Errors always have the action "Show in console".

Message rules:

1. The title names the action in the past tense and the scope: "Pushed 3 commits", "Checked out in 2 repos", "Fetched 12 repositories".
2. The body says what changed and what did not: "feature/PAY-2318-refunds in api-gateway and ledger-service. 9 repos skipped."
3. Errors say what failed and how to fix it: "Push rejected by origin. The remote has 2 new commits. Pull, then push again." Action: "Pull and push".
4. Do not apologize. Do not write "Oops" or "Something went wrong".

### 5.17 Progress area

1. Long operations show in the status bar as a progress widget: label (12), 96 × 4 bar (radius 2, `--dg-progress-fg` on `--dg-progress-track`), count "7 / 12" (12 secondary), 18 px cancel button.
2. Multi-repo operations count repos. Single-repo operations show git's percentage when git reports it (`--progress`).
3. Click the widget to open a popover with one row per running operation and per repo: repository icon, name, status (queued / running / done / failed), elapsed time.
4. Run at most 4 git processes in parallel. Queue the rest.

### 5.18 Git console tool window (`Alt+9`)

1. Opens as a bottom island under the log and the right column (default 20 % of the centre column, min 120 px).
2. Background `--dg-console-bg`, mono 12/20, padding 8 12.
3. Each command is one block:

```
10:42:07  [api-gateway]  $ git push --porcelain origin refs/heads/feature/PAY-2318-refunds:refs/heads/feature/PAY-2318-refunds   0.9 s  ✓
          To github.com:acme/api-gateway.git
          =  refs/heads/feature/PAY-2318-refunds  [up to date]
```

4. Time in `--dg-console-duration`. Repo prefix as a neutral repo chip. `$` and command in `--dg-console-prompt`. stderr lines in `--dg-console-stderr`. Exit code above 0: `--dg-console-error` and a red `✗ exit 1`.
5. Read-only commands that DeepGit runs for its own state (`status`, `for-each-ref`, `log`) are hidden by default. Toggle "Show background commands" shows them in secondary colour.
6. Toolbar: filter by repo (chip), text search, "Show background commands", Clear, Copy all.
7. Click a command line to copy it. Users can paste it in a terminal.
8. Never print credentials. Mask URLs that hold a token: `https://***@github.com/...`.

### 5.19 Status bar (28 px)

Left to right:

1. **Command ticker** (signature 11.3).
2. **Progress widget** (5.17), only while an operation runs.
3. Flexible space.
4. Focused repo: repository icon + name. Click focuses the repo in the sidebar.
5. Branch: branch icon 14 + name + ahead/behind capsule. Click opens the branch popup.
6. Fetch age: 8 px age dot (signature 11.4) + "Fetched 4 min ago". Click fetches.
7. Theme switch text "Dark" / "Light". Click toggles.

Widgets: height 22, padding 0 8, radius 4, 12 `--dg-statusbar-fg`. Hover `--dg-statusbar-hover-bg` and `--dg-statusbar-hover-fg`.

### 5.20 Popups and menus

1. Popup background `--dg-popup-bg`, border 1 px `--dg-popup-border`, radius 8, shadow `--dg-popup-shadow`.
2. Menu padding 6 0. Item height 24, inner padding 0 8, selection radius 4 with 6 px side margin. Separators 9 px high with a 1 px line.
3. Shortcuts at the right in `--dg-menu-accelerator-fg`.
4. Submenus open on hover after 150 ms and on `→`.
5. Branch popup (title bar): search field at the top, then sections "Recent", "Local", "Remote", "Tags". In multi-repo mode, each branch row shows repo dots for the repos that have it. Bottom actions: "New branch…", "Checkout tag or revision…", "Open branch matrix".

### 5.21 Buttons, inputs, checkboxes

Use the DataGrip specs without change:

| Control | Height | Radius | Padding | Colours |
|---|---|---|---|---|
| Button | 28 (small 24) | 4 | 0 14 (small 0 10) | Border `--dg-button-border`, text `--dg-text`. |
| Primary button | 28 | 4 | 0 14 | `--dg-button-primary-bg`, white text, hover `--dg-accent-hover`. |
| Danger button | 28 | 4 | 0 14 | `--dg-button-danger-bg`, white text. |
| Text input | 28 (filter 26) | 4 | 0 8 | `--dg-input-bg`, 1 px `--dg-input-border`, focus 2 px `--dg-input-focus-border`. |
| Checkbox | 16 | 3 | — | `--dg-checkbox-*`. |
| Icon button | 22 | 4 | — | Hover `--dg-hover-bg`. |
| Keycap | 18 (16 in fields) | 4 | 0 5 | `--dg-kbd-bg`, 1 px inset `--dg-kbd-border`, 11/500 `--dg-kbd-fg`. |

---

## 6. Iconography

1. All icons are inline SVG, 16 × 16 viewBox, in JetBrains expui style.
2. Draw strokes at 1 px with round caps and round joins, `stroke="currentColor"`, `fill="none"`. Align strokes to the 0.5 px grid.
3. Set colour with CSS `color`. Default `--dg-icon`. Secondary `--dg-icon-secondary`. Disabled `--dg-icon-disabled`.
4. Put all icons in one SVG sprite (`<symbol id="i-name">`) and reference them with `<use href="#i-name">`. The mockup contains a working sprite.
5. Stripe icons render at 18 px. Ref pill icons render at 11 px. Do not draw new icons for these sizes.
6. Where IntelliJ has an expui icon with the same meaning, copy its shape from `intellij-community/platform/icons/src/expui/` (Apache 2.0).

Icon list (v1):

| Group | Icons |
|---|---|
| Git objects | branch, branch-current, remote (cloud), tag, stash, submodule, commit, merge, repo, project, detached-head |
| Git actions | fetch, pull, push, checkout, cherry-pick, revert, reset, rebase, stash-push, stash-pop, new-branch, delete, rename |
| Files | file, folder, file-rust, file-ts, file-js, file-json, file-toml, file-yaml, file-md, file-sql, file-image, file-binary |
| View | log, changes, matrix (grid), console, tree, list, side-by-side, unified, eye (highlight path), palette (lane colours), collapse, expand |
| Navigation | chevron-down, chevron-right, arrow-up, arrow-down, search, filter, close, more (three dots), plus, refresh, external-link |
| People / time | user, calendar, path |
| Status | check, warning, error, info, progress (spinner), conflict |
| Window | minimize, maximize, restore, close, settings (gear), bell |

---

## 7. Motion

| Interaction | Duration | Easing | Detail |
|---|---|---|---|
| Hover, selection | 0 ms | — | Instant. JetBrains does not fade hover. |
| Popup and menu open | 90 ms | `--dg-ease-out` | Opacity 0 → 1 and translateY(−4 px → 0). No close animation. |
| Chevron rotate | 90 ms | `--dg-ease-out` | 0° → 90°. |
| Toast in | 140 ms | `--dg-ease-out` | translateY(8 px → 0) + opacity. Out: opacity 100 ms. |
| Banner in | 140 ms | `--dg-ease-out` | Height 0 → 34 px. |
| Panel collapse | 140 ms | `--dg-ease-in-out` | Width or height. |
| Graph column width change | 140 ms | `--dg-ease-in-out` | Only when not scrolling. |
| Palette open | 140 ms | `--dg-ease-out` | Scale 0.98 → 1 + opacity. |
| Matrix sweep (signature 11.2) | 220 ms per cell row | `--dg-ease-out` | — |
| Fetch ring refill (signature 11.4) | 220 ms | `--dg-ease-out` | — |
| Indeterminate progress | 1200 ms loop | linear | — |

Rules:

1. Do not animate content during scroll.
2. Respect `prefers-reduced-motion`. `tokens.css` sets all durations to 0 ms then.
3. Do not use more than one moving element at a time outside of progress indicators.

---

## 8. Keyboard map

Windows/Linux keys. On macOS, `Ctrl` becomes `Cmd` and `Alt` becomes `Option`.

| Area | Key | Action |
|---|---|---|
| Global | `Shift Shift` / `Ctrl+K` | Search Everywhere |
| Global | `Ctrl+Shift+A` | Find action |
| Global | `Ctrl+Alt+P` | Switch project |
| Global | ``Ctrl+Shift+` `` | Branch popup |
| Global | `Ctrl+T` | Fetch all repos of the project |
| Global | `Ctrl+Shift+T` | Pull (focused repo; with `Alt`: all repos) |
| Global | `Ctrl+Shift+K` | Push |
| Global | `Ctrl+Alt+N` | New branch |
| Global | `Ctrl+Alt+Z` | Stash changes |
| Global | `Ctrl+R` | Refresh |
| Global | `Ctrl+Alt+S` | Settings |
| Global | `Ctrl+,` | Settings (alias) |
| Tool windows | `Alt+1` | Project sidebar |
| Tool windows | `Alt+0` | Local changes |
| Tool windows | `Alt+2` | Branch matrix |
| Tool windows | `Alt+3` | Stashes |
| Tool windows | `Alt+9` | Git console |
| Tool windows | `Esc` | Return focus to the log |
| Tool windows | `Ctrl+D` | Show the **File changes** tab (the diff) |
| Tool windows | `Esc` (in the diff) | Back to the **Changed files** tab |
| Log | `↑` `↓` | Previous / next commit |
| Log | `PgUp` `PgDn` `Home` `End` | Scroll by page / to start / to end |
| Log | `Ctrl+F` | Focus the text filter |
| Log | `Ctrl+Shift+F` | Clear all filters |
| Log | `Ctrl+Shift+C` | Copy hash |
| Log | `Enter` | Focus the file list of the commit |
| Log | `Ctrl+G` | Go to hash, branch or tag |
| Log | `Alt+←` / `Alt+→` | Back / forward in selection history |
| Log | `H` | Select HEAD |
| Log | `P` | Select first parent |
| Log | `[` / `]` | Previous / next repo filter preset |
| Files | `↑` `↓` | Previous / next file |
| Files | `Space` | Stage / unstage (local changes) |
| Files | `Delete` | Discard (local changes, asks first) |
| Files | `F4` | Open file in external editor |
| Diff | `F7` / `Shift+F7` | Next / previous change |
| Diff | `Ctrl+Alt+D` | Side by side / unified |
| Diff | `Ctrl+Alt+W` | Toggle ignore whitespace |
| Commit | `Ctrl+M` (in Local changes) | Focus the commit message |
| Commit | `Ctrl+Enter` | Commit |
| Commit | `Ctrl+Alt+K` | Commit and push |
| Trees | type letters | Speed search |
| Trees | `←` `→` | Collapse / expand |
| Trees | `F2` | Rename branch |

Show shortcuts in tooltips, menus and the palette. Use the keycap style (5.21).

---

## 9. Empty states, onboarding and copy

### 9.1 Layout of an empty state

1. Centre the content in the island, with a max width of 360 px.
2. Use a 48 px line icon in `--dg-icon-secondary`, then a heading 16/600, then 1 or 2 lines of body 13 `--dg-text-muted`, then actions (primary button + link).
3. Show the shortcut keycaps of the primary action under the button.

### 9.2 Copy

| Where | Heading | Body | Actions |
|---|---|---|---|
| First start (no projects) | Add your first project | Choose a folder. DeepGit finds every Git repository inside it, including nested repositories. | "Add project folder" (primary), "Clone repository" |
| Project folder has no repos | No repositories in this folder | DeepGit searched 4 levels deep in ~/work/payments-platform. | "Choose another folder", "Initialize a repository here" |
| Log with filters and no result | No commits match these filters | 3 filters are active: Author, Date, Path. | "Clear filters" |
| Local changes, clean | Working tree clean | All 12 repositories have no uncommitted changes. | — (shows the last commit time) |
| Details, no selection | Select a commit | Its message, files and diff appear here. | — |
| Diff, no file | Select a file | Pick a file in the list to see its changes. | — |
| Stashes, empty | No stashes | Stash your changes to switch branches without committing. | "Stash changes" |
| Console, empty | No commands yet | Every git command that DeepGit runs appears here. | — |
| Repo folder deleted | Repository not found | ~/work/payments-platform/risk-engine does not exist anymore. | "Remove from project", "Locate…" |
| Git not installed | Git is not installed | DeepGit needs Git 2.30 or later. | "Download Git", "Set path to git…" |

### 9.3 Onboarding flow

1. **Welcome** (no project): full window, logo 48, heading "Add your first project", body as above, primary "Add project folder", link "Clone repository". Under it: "Recent folders" if the OS gives a list.
2. **Folder picker**: native dialog via Tauri.
3. **Scan**: a dialog (640 wide) shows the scan live: "Scanning ~/work/payments-platform…" and the repo list fills row by row (repository icon, name, relative path, current branch). Scan depth default 4. Skip `node_modules`, `target`, `.venv`, `vendor`, `dist`.
4. **Review**: each found repo has a checkbox (all on). Nested repos show indented under their parent. The user can change the project name and colour.
5. Primary button: "Add 12 repositories". Then the main window opens with the combined log, and runs one fetch of all repos in the background.
6. Show one dismissable tip banner in the log for the first session: "Tip: press Shift twice to search everything. Press Alt+2 to see your branches across all repos."

### 9.4 Writing rules

1. Use the same verb in the button, the toast and the console title: "Push" → "Pushed".
2. Name the repos and branches. Do not write "the selected item".
3. Use numbers with units: "3 commits", "12 repositories", "4 min ago".
4. Use "repo" in compact places (chips, toasts). Use "repository" in headings and dialogs.
5. Use sentence case. No exclamation marks.

---

## 10. Light theme

1. Set `data-theme="light"` on `<html>`. All tokens switch. No component needs light-specific CSS.
2. Islands are white (`#FFFFFF`) on `#E9EAEE`.
3. Every family has its own light values (4.4): text colours have 4.5:1 or more and solids 3:1 or more on white, on `#F7F8F9` and on a selected row; the washes are a little weaker.
4. Avatars keep the same colours in both themes, with white text.
5. Follow the OS theme by default (`prefers-color-scheme`). The status bar switch and settings override it.

---

## 11. Creative signature

These features make DeepGit different from Fork and from IntelliJ. Build each one exactly as written.

### 11.1 Repo spine

Removed. Repositories have no colour, so there is no spine. The **Repository** column of the log (a neutral repo chip with the name) says which repository owns a commit.

### 11.2 Branch matrix and sync strip (synchronous branch control)

**What it is.** A grid of repositories (rows) × branches (columns). Each cell shows the state of that branch in that repo. Select a column to run one branch operation over many repos. The sidebar shows a one-line version: the sync strip.

**Sync strip (sidebar card).**

1. Card: margin 10 12 2, padding 8 10, radius 8, `--dg-layer-1-bg`.
2. Line 1: matrix icon, branch name (12/600, ellipsis), link "Matrix" (11) at the right.
3. Line 2: 12 equal segments in a grid (gap 3, height 6, radius 2), one per repo in sidebar order.
   - Branch is current in the repo: filled with `--dg-matrix-current` (green).
   - Branch exists only on origin: 1 px inset ring in `--dg-matrix-remote-only` (violet), no fill.
   - Branch is local but not current: `--dg-matrix-current` at 40 %.
   - Branch is missing: `--dg-matrix-missing`.
4. Line 3: a legend with counts: "3 current", "2 on origin", "7 missing" (11 secondary, with 8 × 6 swatches).
5. Hover a segment: tooltip "web-checkout: only origin/feature/PAY-2318-refunds".
6. Click a segment: focus that repo in the sidebar.
7. For more than 24 repos, segments shrink to a min width of 4 px; then the strip scrolls.

**Matrix tool window.**

1. Open with `Alt+2`, the stripe button, the "Matrix" link or the toast action. It opens as a large island that replaces the log area (the log stays one click away in the tabs).
2. Rows: repos (repository icon + name + current branch), 28 px high.
3. Columns: branches that exist in 2 or more repos, sorted by number of repos, then by the newest commit date. Column width 120. Header: branch name rotated 0° (horizontal, ellipsis) with a repo count "7/12".
4. Cell (28 × 120, `--dg-matrix-cell-bg`, hover `--dg-matrix-cell-hover-bg`) shows one glyph and the ahead/behind capsule against the column's base branch:
   - Filled 8 px dot `--dg-matrix-current` (green, with a soft green halo): checked out.
   - Hollow 8 px ring `--dg-matrix-local`: local branch exists.
   - Dashed 8 px ring `--dg-matrix-remote-only` (violet): only on origin.
   - 8 px dash `--dg-matrix-missing`: not present.
   - Red dot `--dg-conflict-dot`: repo is mid-operation; operations skip it.
5. Click a column header to select the column. The selected column has `--dg-matrix-column-selected-bg`.
6. With a column selected, an action bar appears at the bottom (44 px): "feature/PAY-2318-refunds · 3 current · 2 on origin · 7 missing" and buttons:
   - "Checkout in 5 repos" (primary; includes origin-only repos, which get a tracking branch).
   - "Create in 7 missing repos from…" (opens a base picker: default branch of each repo, or a named branch).
   - "Pull in 3 repos", "Push in 2 repos", "Merge into…", "Delete in 5 repos…".
7. Before a batch runs, show a confirm dialog with one row per repo and the exact git command for each row. Repos with uncommitted changes show a select: "Stash and continue" / "Skip".
8. While the batch runs, a 2 px `--dg-matrix-sweep` line moves down the selected column, one row at a time (220 ms per row, or the real duration if longer). Each cell turns into its new state when its command ends. Failed cells show a red ring and a tooltip with the git error.
9. After the batch, show one toast (5.16) with the summary and the action "Show in console".
10. Repos where the operation does not apply are skipped, never failed. The toast counts them as "skipped".

**Data.** The Rust side runs `git for-each-ref --format=... refs/heads refs/remotes` per repo in parallel and merges the branch names into one table. Refresh after every fetch and every branch operation.

### 11.3 Command ticker

**What it is.** The left end of the status bar always shows the last git command that DeepGit ran for a user action, with its result and duration. It is a live window into the Git console.

**How to build it.**

1. Widget content: result icon 14 px (check `--dg-text-success`, cross `--dg-text-error`, spinner while running), repo name (mono 11.5, `--dg-text-muted`), the command without the `git -C <path>` prefix (mono 11.5, `--dg-text-muted`), duration "0.8 s" (12 secondary).
2. Max width 520 px. Truncate the command in the middle.
3. While a multi-repo command runs, show "git fetch --prune origin × 12" and the progress widget next to it.
4. Click: open the Git console and scroll to this command.
5. Show only user-initiated commands. Background refresh commands do not change the ticker.

### 11.4 Fetch age ring

**What it is.** The Fetch button in the title bar has a thin ring that shows how old the last fetch is. The user knows at a glance if remote data is fresh.

**How to build it.**

1. Draw a 22 px circle centred on the 30 px button with a conic gradient and a radial mask that keeps only a 1 px ring.
2. Ring fill angle = `min(ageMinutes / 120, 1) × 360°`, starting at 12 o'clock, clockwise. The unfilled part is `--dg-hover-bg`.
3. Ring colour: `--dg-fetch-fresh` under 15 min, `--dg-fetch-aging` from 15 min to 2 h, `--dg-fetch-stale` over 2 h or never.
4. Age = time since the oldest last-fetch of all repos in the project (read `FETCH_HEAD` mtime).
5. After a successful fetch, animate the ring back to 0° in 220 ms.
6. The status bar shows the same state as an 8 px dot with the same conic fill and the text "Fetched 4 min ago".
7. Tooltip: "Last fetch 4 min ago. Oldest: docs-site, 4 min ago. Auto-fetch every 15 min." Auto-fetch is a setting (off, 5, 15, 30 min).

### 11.5 Overview ruler

**What it is.** The log scrollbar is a map of the whole history, like the error stripe in a JetBrains editor.

**How to build it.**

1. Make the ruler a 14 px column at the right of the log body. The scrollbar thumb sits inside it.
2. Draw marks (3 px high, radius 1) at `top = rowIndex / totalRows × 100 %`:
   - HEAD: `--dg-ruler-head`, 4 px high, full width.
   - Selected commit: `--dg-ruler-selection`, 2 px.
   - Branch tips: `--dg-ruler-branch`, full width.
   - Tags: `--dg-ruler-tag`, right half only (left inset 7 px).
   - Text filter matches (when the filter is in highlight mode): `--dg-ruler-match`.
3. Merge marks that are closer than 2 px.
4. Click a mark: scroll to that row and select it. Hover a mark: tooltip with the ref name or subject.
5. Compute marks in Rust from the full row list. Send them as one array of `{row, kind}`.

### 11.6 Combined graph

Lanes are coloured by lane (4.1 rule 2) in the combined log too. There is no "by repository" lane mode: the Repository column names the repository of each commit.

### 11.7 Command preview in every dialog

**What it is.** Each operation dialog shows the git command it will run, and updates it live as options change. Users learn git and trust the tool.

**How to build it.** See 5.11 "Dialogs". The preview line is selectable text. A copy button (16 px) sits at its right.

---

## 12. Accessibility

1. Every interactive element is reachable by keyboard. Tab order follows the visual order: title bar, stripe, sidebar, log, details, diff, status bar.
2. Use roles: `tree` / `treeitem` for the sidebar and file tree, `grid` / `row` / `gridcell` for the log, `dialog` with `aria-modal` for dialogs, `status` with `aria-live="polite"` for toasts and the ticker.
3. Every icon button has an `aria-label` and a tooltip with the shortcut.
4. The graph SVG has `aria-hidden="true"`. Each log row has an accessible name: "Add idempotency key to refund endpoint, api-gateway, Lucía Martín, today 10:42, HEAD, feature/PAY-2318-refunds".
5. UI scale and font size (Settings > Appearance, implemented in `src/state/settings.ts` and `src/state/appearance.ts`):
   - **UI scale** 80 % to 200 % (step 10 %, default 100 %) with `Ctrl+=` / `Ctrl+-` / `Ctrl+0`. In the desktop app it is the webview zoom (true page zoom). In a browser it is CSS `zoom` on `<html>`. All tokens stay in px.
   - **Font size** 10 to 20 px (default 13). One base variable `--dg-font-base` drives all `--dg-font-size-*` tokens. `--dg-u` (= 1 px at 13 px) scales every size that depends on text (row heights, controls, icons, pills): write it as `calc(N * var(--dg-u))`, or `round(calc(N * var(--dg-u)), 1px)` when JavaScript reads the token with `cssPx()` (`src/state/metrics.ts`). Do not hard-code font sizes or text-line heights in px.
   - **Editor font size** (`--dg-editor-font-base`) drives `--dg-font-size-mono` and `--dg-line-height-code`.
   - `index.html` sets these variables before first paint.

---

## 13. Implementation checklist

1. Copy `tokens.css` into `src/theme/tokens.css`. Import it before any component CSS.
2. Copy the fonts from Prometeo DataGrip. Add the `@font-face` block from `prometeo-datagrip/src/theme/fonts.css`.
3. Build the window shell (2.1–2.4) with empty islands. Check it against `mockup.png` at 1600 × 1000.
4. Build the log with fake data and virtualization (5.5–5.7). Test with 100 000 rows.
5. Build the sidebar (5.3), details (5.8, 5.9) and diff (5.10).
6. Build local changes (5.12), dialogs (5.11), palette (5.15), toasts (5.16), console (5.18).
7. Build the signature features (section 11).
8. Switch to `data-theme="light"` and check each screen.
