/**
 * The window layout of DESIGN.md section 2: title bar, tool stripe, islands (sidebar, main with tabs, details,
 * diff, optional bottom tool window) and status bar. Feature components fill the islands; the shell owns sizes,
 * visibility and the splitters.
 */
import { type JSX, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { HeaderSlotTarget, Icon, IconButton, Splitter, loadSplitSize, openMenu, plural, markNotificationsRead, notifications, unreadCount, formatRelative, type IconName } from "../../components/ui";
import { tip } from "../../components/ui";
import { ChangesView } from "../changes/ChangesView";
import { CommitDetails } from "../details/CommitDetails";
import { DiffPanel } from "../diff/DiffPanel";
import { GitConsole } from "../console/GitConsole";
import { BranchMatrix } from "../matrix/BranchMatrix";
import { LogView } from "../log/LogView";
import { Sidebar } from "../sidebar/Sidebar";
import { StatusBar } from "../statusbar/StatusBar";
import { TitleBar } from "../titlebar/TitleBar";
import { bottomTool, diffVisible, openBottomTool, setSidebarVisible, sidebarVisible, toggleBottomTool, toggleSidebar, type BottomTool } from "../../state/layout";
import { mainTab, setMainTab } from "../../state/selection";
import { activeProject, projectTotals, selectedRepos } from "../../state/workspace";
import { keysFor, formatKeys } from "../../state/keymap";
import { loadPersisted, savePersisted } from "../../state/persist";
import { DEFAULT_RATIOS, allocate, maxFor, ratioFor, sanitizeRatios, type Mins, type Ratios } from "./heights";
import "./shell.css";

const MIN_LOG_WIDTH = 480;
const SPLIT = 6;
const MIN_DIFF = 160;
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
  const [detailsW, setDetailsW] = createSignal(loadSplitSize("details", 400));
  // The diff island and the bottom tool window keep a persisted share of the centre column; the main row takes the rest.
  const [ratios, setRatios] = createSignal<Ratios>(sanitizeRatios(loadPersisted<Partial<Ratios> | null>(RATIOS_KEY, null)));
  const [centerH, setCenterH] = createSignal(0);
  let topRow: HTMLDivElement | undefined;
  let center: HTMLDivElement | undefined;

  const toastWidth = () => (sidebarVisible() ? Math.min(384, Math.max(260, sidebarW() - 12)) : 320);
  const maxDetails = () => Math.max(300, Math.min(720, (topRow?.clientWidth ?? 1600) - MIN_LOG_WIDTH - SPLIT));
  const mins = (): Mins => ({ top: tokenPx("--dg-shell-main-min-height", 260), diff: MIN_DIFF, bottom: MIN_BOTTOM });
  const heights = createMemo(() => allocate(centerH() || 900, SPLIT, diffVisible(), bottomTool() !== null, ratios(), mins()));
  const setRatio = (part: "diff" | "bottom", px: number) => {
    const next = sanitizeRatios({ ...ratios(), [part]: ratioFor(px, heights().available) });
    setRatios(next);
    savePersisted(RATIOS_KEY, next);
  };
  const maxPart = (part: "diff" | "bottom") => () => maxFor(part, heights(), mins(), diffVisible(), bottomTool() !== null);

  onMount(() => {
    if (!center) return;
    setCenterH(center.clientHeight);
    const ro = new ResizeObserver(() => center && setCenterH(center.clientHeight));
    ro.observe(center);
    onCleanup(() => ro.disconnect());
  });

  const logSubtitle = createMemo(() => {
    const repos = selectedRepos();
    return repos.length > 1 ? `combined · ${plural(repos.length, "repo")}` : repos[0]?.name ?? "";
  });

  const notificationsMenu = (e: MouseEvent) => {
    const items = notifications().slice(0, 12).map((n) => ({
      label: `${n.title} · ${formatRelative(n.time / 1000)}`,
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
          <StripeButton icon="changes" label="Local changes" keys={keyOf("tool.changes")} active={mainTab() === "changes"} count={projectTotals().changes} onClick={() => setMainTab(mainTab() === "changes" ? "log" : "changes")} />
          <StripeButton icon="matrix" label="Branch matrix" keys={keyOf("tool.matrix")} active={bottomTool() === "matrix"} onClick={() => toggleBottomTool("matrix")} />
          <StripeButton icon="stash" label="Stashes" keys={keyOf("tool.stashes")} onClick={() => setSidebarVisible(true)} />
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
                    <Show when={projectTotals().changes > 0}>
                      <span class="dg-shell-tab-sub">{projectTotals().changes}</span>
                    </Show>
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
              </section>
              <Splitter orientation="vertical" reverse size={detailsW()} onSize={setDetailsW} min={300} max={maxDetails} defaultSize={400} persistKey="details" />
              <aside class="dg-shell-island dg-shell-details" style={{ width: detailsW() + "px" }} aria-label="Commit details">
                <CommitDetails />
              </aside>
            </div>

            <Show when={diffVisible()}>
              <Splitter orientation="horizontal" reverse size={heights().diff} onSize={(px) => setRatio("diff", px)} min={MIN_DIFF} max={maxPart("diff")} defaultSize={Math.round(heights().available * DEFAULT_RATIOS.diff)} />
              <section class="dg-shell-island dg-shell-diff" style={{ height: heights().diff + "px" }} aria-label="Diff">
                <DiffPanel />
              </section>
            </Show>

            <Show when={bottomTool()}>
              {(tool) => (
                <>
                  <Splitter orientation="horizontal" reverse size={heights().bottom} onSize={(px) => setRatio("bottom", px)} min={MIN_BOTTOM} max={maxPart("bottom")} defaultSize={Math.round(heights().available * DEFAULT_RATIOS.bottom)} />
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
