/**
 * The window layout of DESIGN.md section 2: title bar, tool stripe, islands (sidebar, main with tabs, the right
 * column with the "Changed files" / "File changes" tabs, optional bottom tool window) and status bar. Feature
 * components fill the islands; the shell owns sizes, visibility and the splitters.
 */
import { type JSX, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { HeaderSlotTarget, Icon, IconButton, Splitter, loadSplitSize, openMenu, plural, markNotificationsRead, notifications, unreadCount, type IconName } from "../../components/ui";
import { formatDate } from "../../state/dates";
import { tip } from "../../components/ui";
import { ChangesView } from "../changes/ChangesView";
import { FilesView } from "../files/FilesView";
import { CommitDetails } from "../details/CommitDetails";
import { DiffPanel } from "../diff/DiffPanel";
import { GitConsole } from "../console/GitConsole";
import { BranchMatrix } from "../matrix/BranchMatrix";
import { LogView } from "../log/LogView";
import { Sidebar } from "../sidebar/Sidebar";
import { StatusBar } from "../statusbar/StatusBar";
import { TitleBar } from "../titlebar/TitleBar";
import { bottomTool, openBottomTool, sidebarVisible, toggleBottomTool, toggleSidebar, type BottomTool } from "../../state/layout";
import { changesScopeCount, detailsTab, mainTab, setDetailsTab, setMainTab } from "../../state/selection";
import { activeProject, selectedRepos } from "../../state/workspace";
import { keysFor, formatKeys, register } from "../../state/keymap";
import { loadPersisted, savePersisted } from "../../state/persist";
import { DEFAULT_RATIOS, allocate, maxBottom, ratioFor, sanitizeRatios, type Mins, type Ratios } from "./heights";
import { MIN_DETAILS, clampDetails, defaultDetails, maxDetails, maximizedDetails } from "./widths";
import "./shell.css";

const SPLIT = 6;
const MIN_BOTTOM = 120;
const RATIOS_KEY = "shell.ratios";

const tokenPx = (name: string, fallback: number): number => {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(v) ? v : fallback;
};

function StripeButton(props: { icon: IconName; label: string; keys?: string; active?: boolean; count?: number; onClick: (e: MouseEvent) => void }): JSX.Element {
  return (
    <button
      type="button"
      class="dg-shell-stripe-btn"
      classList={{ "is-on": props.active }}
      aria-label={props.label}
      aria-pressed={props.active}
      {...tip(props.label, props.keys)}
      onClick={props.onClick}
    >
      <Icon name={props.icon} size={18} />
      <Show when={props.count}>
        <span class="dg-shell-stripe-count">{props.count}</span>
      </Show>
    </button>
  );
}

const keyOf = (id: string) => {
  const k = keysFor(id)[0];
  return k ? formatKeys(k) : undefined;
};

export function Shell(): JSX.Element {
  const [sidebarW, setSidebarW] = createSignal(loadSplitSize("sidebar", 280));
  // Width of the right column: the persisted px (NaN = never dragged: 42 % of the row), clamped on every use.
  const [detailsPref, setDetailsPref] = createSignal(loadSplitSize("details", Number.NaN));
  const [rowW, setRowW] = createSignal(0);
  const [maximized, setMaximized] = createSignal(false);
  // The bottom tool window keeps a persisted share of the centre column; the main row takes the rest.
  const [ratios, setRatios] = createSignal<Ratios>(sanitizeRatios(loadPersisted<Partial<Ratios> | null>(RATIOS_KEY, null)));
  const [centerH, setCenterH] = createSignal(0);
  let topRow: HTMLDivElement | undefined;
  let center: HTMLDivElement | undefined;

  const toastWidth = () => (sidebarVisible() ? Math.min(384, Math.max(260, sidebarW() - 12)) : 320);
  const rowWidth = () => rowW() || 1300;
  const detailsW = createMemo(() => (maximized() ? maximizedDetails(rowWidth(), SPLIT) : clampDetails(detailsPref(), rowWidth(), SPLIT)));
  const resizeDetails = (px: number) => {
    setMaximized(false);
    setDetailsPref(px);
  };
  const mins = (): Mins => ({ top: tokenPx("--dg-shell-main-min-height", 260), bottom: MIN_BOTTOM });
  const heights = createMemo(() => allocate(centerH() || 900, SPLIT, bottomTool() !== null, ratios(), mins()));
  const setBottomRatio = (px: number) => {
    const next = sanitizeRatios({ bottom: ratioFor(px, heights().available) });
    setRatios(next);
    savePersisted(RATIOS_KEY, next);
  };

  onMount(() => {
    if (!center) return;
    setCenterH(center.clientHeight);
    const ro = new ResizeObserver(() => {
      if (center) setCenterH(center.clientHeight);
      if (topRow) setRowW(topRow.clientWidth);
    });
    ro.observe(center);
    if (topRow) {
      setRowW(topRow.clientWidth);
      ro.observe(topRow);
    }
    onCleanup(() => ro.disconnect());
  });

  // The maximized column only makes sense on "File changes": leaving that tab restores the width.
  createEffect(on(detailsTab, (t) => t !== "diff" && setMaximized(false), { defer: true }));
  // A click or Enter in the file tree hides the tree under the focus: move the focus into the diff so Esc works at once.
  // (A file chosen in the Local changes list keeps the focus there.)
  createEffect(
    on(
      detailsTab,
      (t) => {
        if (t !== "diff") return;
        const active = document.activeElement;
        if (active && active !== document.body && !active.closest('[data-details-view="files"]')) return;
        queueMicrotask(() => document.querySelector<HTMLElement>('[data-details-view="diff"] .dg-diff')?.focus());
      },
      { defer: true },
    ),
  );
  const toggleMaximized = () => {
    setDetailsTab("diff");
    setMaximized(!maximized());
  };
  onMount(() => {
    const off = register("view.maximizeDiff", [], toggleMaximized, { title: "Maximize or restore the file changes", group: "Tool windows" });
    onCleanup(off);
  });

  const logSubtitle = createMemo(() => {
    const repos = selectedRepos();
    return repos.length > 1 ? `combined · ${plural(repos.length, "repo")}` : repos[0]?.name ?? "";
  });

  const notificationsMenu = (e: MouseEvent) => {
    const items = notifications().slice(0, 12).map((n) => ({
      label: `${n.title} · ${formatDate(n.time / 1000)}`,
      icon: (n.kind === "error" ? "error" : n.kind === "warning" ? "warning" : n.kind === "success" ? "check" : "info") as IconName,
    }));
    markNotificationsRead();
    openMenu(e.currentTarget as HTMLElement, items.length ? items : [{ label: "No notifications", disabled: true }]);
  };

  const bottomLabel: Record<BottomTool, string> = { console: "Git console", matrix: "Branch matrix" };

  return (
    <div class="dg-shell" style={{ "--dg-toast-width": toastWidth() + "px" }}>
      <header class="dg-shell-titlebar">
        <TitleBar />
      </header>

      <div class="dg-shell-main">
        <nav class="dg-shell-stripe" aria-label="Tool windows">
          <StripeButton icon="project" label="Project" keys={keyOf("tool.sidebar")} active={sidebarVisible()} onClick={toggleSidebar} />
          <StripeButton icon="changes" label="Local changes" keys={keyOf("tool.changes")} active={mainTab() === "changes"} count={changesScopeCount()} onClick={() => setMainTab(mainTab() === "changes" ? "log" : "changes")} />
          <StripeButton icon="folder" label="Project files" keys={keyOf("tool.files")} active={mainTab() === "files"} onClick={() => setMainTab(mainTab() === "files" ? "log" : "files")} />
          <StripeButton icon="matrix" label="Branch matrix" keys={keyOf("tool.matrix")} active={bottomTool() === "matrix"} onClick={() => toggleBottomTool("matrix")} />
          <span class="dg-grow" />
          <StripeButton icon="console" label="Git console" keys={keyOf("tool.console")} active={bottomTool() === "console"} onClick={() => toggleBottomTool("console")} />
          <button type="button" class="dg-shell-stripe-btn" aria-label="Notifications" {...tip("Notifications")} onClick={notificationsMenu}>
            <Icon name="bell" size={18} />
            <Show when={unreadCount() > 0}>
              <span class="dg-shell-stripe-dot" />
            </Show>
          </button>
        </nav>

        <div class="dg-shell-islands">
          <Show when={sidebarVisible()}>
            <aside class="dg-shell-island dg-shell-sidebar" style={{ width: sidebarW() + "px" }} aria-label="Project">
              <Sidebar />
            </aside>
            <Splitter orientation="vertical" size={sidebarW()} onSize={setSidebarW} min={200} max={480} defaultSize={280} persistKey="sidebar" />
          </Show>

          <div class="dg-shell-center" ref={center}>
            <div class="dg-shell-top" ref={topRow}>
              <section class="dg-shell-island dg-shell-main-island" aria-label={activeProject()?.name}>
                <div class="dg-shell-head" role="tablist">
                  <button type="button" role="tab" aria-selected={mainTab() === "log"} class="dg-shell-tab" classList={{ "is-on": mainTab() === "log" }} onClick={() => setMainTab("log")}>
                    <Icon name="log" />
                    Log
                    <span class="dg-shell-tab-sub">{logSubtitle()}</span>
                  </button>
                  <button type="button" role="tab" aria-selected={mainTab() === "changes"} class="dg-shell-tab" classList={{ "is-on": mainTab() === "changes" }} onClick={() => setMainTab("changes")}>
                    Local changes
                    <Show when={changesScopeCount() > 0}>
                      <span class="dg-shell-tab-sub">{changesScopeCount()}</span>
                    </Show>
                  </button>
                  <button type="button" role="tab" aria-selected={mainTab() === "files"} class="dg-shell-tab" classList={{ "is-on": mainTab() === "files" }} onClick={() => setMainTab("files")}>
                    <Icon name="folder" />
                    Files
                  </button>
                  <span class="dg-grow" />
                  <HeaderSlotTarget name="main" />
                </div>
                <div class="dg-shell-view" hidden={mainTab() !== "log"}>
                  <LogView />
                </div>
                <div class="dg-shell-view" hidden={mainTab() !== "changes"}>
                  <ChangesView />
                </div>
                <div class="dg-shell-view" hidden={mainTab() !== "files"}>
                  <FilesView />
                </div>
              </section>
              {/* Hidden, not unmounted. The Files tab needs the width. The details keep their state. */}
              <Splitter orientation="vertical" reverse class={mainTab() === "files" ? "dg-shell-off" : undefined} size={detailsW()} onSize={resizeDetails} min={MIN_DETAILS} max={() => maxDetails(rowWidth(), SPLIT)} defaultSize={defaultDetails(rowWidth(), SPLIT)} persistKey="details" />
              <aside class="dg-shell-island dg-shell-details" style={{ width: detailsW() + "px", display: mainTab() === "files" ? "none" : undefined }} aria-label="Details">
                <div class="dg-shell-head" role="tablist" aria-label="Details tabs">
                  <button type="button" role="tab" aria-selected={detailsTab() === "files"} class="dg-shell-tab" classList={{ "is-on": detailsTab() === "files" }} onClick={() => setDetailsTab("files")}>
                    Changed files
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={detailsTab() === "diff"}
                    class="dg-shell-tab"
                    classList={{ "is-on": detailsTab() === "diff" }}
                    {...tip("File changes\nDouble-click to maximize", keyOf("tool.diff"))}
                    onClick={() => setDetailsTab("diff")}
                    onDblClick={toggleMaximized}
                  >
                    File changes
                  </button>
                  <span class="dg-grow" />
                  <span class="dg-shell-slot" hidden={detailsTab() !== "files"}>
                    <HeaderSlotTarget name="details" />
                  </span>
                  <Show when={detailsTab() === "diff"}>
                    <IconButton icon={maximized() ? "restore" : "maximize"} label={maximized() ? "Restore the column width" : "Maximize the file changes"} active={maximized()} onClick={toggleMaximized} />
                  </Show>
                </div>
                <div class="dg-shell-view" data-details-view="files" hidden={detailsTab() !== "files"}>
                  <CommitDetails />
                </div>
                <div class="dg-shell-view" data-details-view="diff" hidden={detailsTab() !== "diff"}>
                  <DiffPanel />
                </div>
              </aside>
            </div>

            <Show when={bottomTool()}>
              {(tool) => (
                <>
                  <Splitter orientation="horizontal" reverse size={heights().bottom} onSize={setBottomRatio} min={MIN_BOTTOM} max={() => maxBottom(heights(), mins())} defaultSize={Math.round(heights().available * DEFAULT_RATIOS.bottom)} />
                  <section class="dg-shell-island dg-shell-bottom" style={{ height: heights().bottom + "px" }} aria-label={bottomLabel[tool()]}>
                    <div class="dg-shell-head">
                      <button type="button" class="dg-shell-tab" classList={{ "is-on": tool() === "console" }} onClick={() => openBottomTool("console")}>
                        <Icon name="console" />
                        Git console
                      </button>
                      <button type="button" class="dg-shell-tab" classList={{ "is-on": tool() === "matrix" }} onClick={() => openBottomTool("matrix")}>
                        <Icon name="matrix" />
                        Branch matrix
                      </button>
                      <span class="dg-grow" />
                      <IconButton icon="minus" label="Hide" onClick={() => openBottomTool(null)} />
                    </div>
                    <div class="dg-shell-view">
                      <Show when={tool() === "console"} fallback={<BranchMatrix />}>
                        <GitConsole />
                      </Show>
                    </div>
                  </section>
                </>
              )}
            </Show>
          </div>
        </div>
      </div>

      <footer class="dg-shell-statusbar">
        <StatusBar />
      </footer>
    </div>
  );
}
