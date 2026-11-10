/** Title bar (DESIGN.md 5.1): logo, project switcher, branch widget, fetch / pull / push, Search Everywhere, tools, window controls. */
import { type JSX, Show, createMemo } from "solid-js";
import {
  Icon, Kbd, Spinner, WindowControls, dragRegion, markNotificationsRead, notifications, openMenu, plural, unreadCount,
  type IconName, type MenuItem, THEME_ICONS,
} from "../../components/ui";
import * as actions from "../../state/actions";
import { activities } from "../../state/activity";
import { autoFetchLine } from "../../state/autoFetch";
import { formatDate } from "../../state/dates";
import { fetchAge } from "../../state/fetchAge";
import { bottomTool, toggleBottomTool } from "../../state/layout";
import { runBinding, shortcutLabel } from "../../state/keymap";
import { settings, setSetting, type ThemePref } from "../../state/settings";
import { focusedRepo, projectRepos, projectTotals, summary } from "../../state/workspace";
import { BranchWidget } from "./BranchWidget";
import { ProjectSwitcher } from "./ProjectSwitcher";
import "./titlebar.css";

const LOGO = (
  <svg class="dg-titlebar-logo" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
    <rect width="20" height="20" rx="5" fill="var(--dg-accent)" />
    <path d="M6 5v10M6 9c0-2.5 8-1.5 8-4.5M6 11c0 2.5 8 1.5 8 4.5" stroke="var(--dg-text-over-accent)" stroke-width="1.6" fill="none" stroke-linecap="round" />
    <circle cx="14" cy="4.6" r="1.6" fill="var(--dg-text-over-accent)" />
    <circle cx="14" cy="15.4" r="1.6" fill="var(--dg-text-over-accent)" />
  </svg>
);

/** Repos with a count above 0, as tooltip lines ("api-gateway 3"). */
function perRepoLines(pick: (repoId: string) => number, arrow: string): string[] {
  return projectRepos()
    .map((r) => ({ name: r.name, n: pick(r.id) }))
    .filter((x) => x.n > 0)
    .map((x) => `${x.name}  ${arrow}${x.n}`);
}

export function TitleBar(): JSX.Element {
  let settingsBtn: HTMLButtonElement | undefined;
  let bellBtn: HTMLButtonElement | undefined;

  const fetching = () => activities().some((a) => /fetch/i.test(a.label));
  const age = fetchAge;

  const pullTip = createMemo(() => {
    const t = projectTotals();
    if (t.behind === 0) return "Pull\nNothing to pull";
    return [`Pull ${plural(t.behind, "commit")}`, ...perRepoLines((id) => summary(id)?.behind ?? 0, "↓")].join("\n");
  });
  const pushTip = createMemo(() => {
    const t = projectTotals();
    if (t.ahead === 0) return "Push\nNothing to push";
    return [`Push ${plural(t.ahead, "commit")}`, ...perRepoLines((id) => summary(id)?.ahead ?? 0, "↑")].join("\n");
  });

  const pull = () => {
    const ids = projectRepos().filter((r) => (summary(r.id)?.behind ?? 0) > 0).map((r) => r.id);
    void actions.pull(ids.length > 0 ? ids : projectRepos().map((r) => r.id));
  };
  const push = () => {
    const ids = projectRepos().filter((r) => (summary(r.id)?.ahead ?? 0) > 0).map((r) => r.id);
    const target = ids.length > 0 ? ids : focusedRepo() ? [focusedRepo()!.id] : [];
    if (target.length > 0) void actions.push(target);
  };

  const themeItem = (label: string, value: ThemePref): MenuItem => ({ label, icon: THEME_ICONS[value], checked: settings.theme === value, onSelect: () => setSetting("theme", value) });
  /** Gear menu: the full Settings dialog (it owns Ctrl+, and Ctrl+Alt+S, see features/settings) and the quick toggles. */
  const openSettingsMenu = (anchor: HTMLElement | undefined) => {
    if (!anchor) return;
    openMenu(anchor, () => [
      { label: "Settings…", icon: "gear", shortcut: shortcutLabel("settings.open"), onSelect: () => runBinding("settings.open") },
      { separator: true },
      { label: "Theme", heading: true },
      themeItem("Dark", "dark"),
      themeItem("Light", "light"),
      themeItem("Follow the system", "system"),
      { separator: true },
      { label: "Log", heading: true },
      { label: "Show commit graph", checked: settings.showGraph, onSelect: () => setSetting("showGraph", !settings.showGraph) },
      { label: "Comfortable rows", checked: settings.comfortableRows, onSelect: () => setSetting("comfortableRows", !settings.comfortableRows) },
      { separator: true },
      { label: "Show background commands in the console", checked: settings.showBackgroundCommands, onSelect: () => setSetting("showBackgroundCommands", !settings.showBackgroundCommands) },
    ]);
  };

  const openNotifications = () => {
    if (!bellBtn) return;
    const items: MenuItem[] = notifications()
      .slice(0, 12)
      .map((n) => ({
        label: `${n.title} · ${formatDate(n.time / 1000)}`,
        icon: (n.kind === "error" ? "error" : n.kind === "warning" ? "warning" : n.kind === "success" ? "check" : "info") as IconName,
      }));
    markNotificationsRead();
    openMenu(bellBtn, items.length > 0 ? items : [{ label: "No notifications", disabled: true }]);
  };

  return (
    <div class="dg-titlebar" {...dragRegion}>
      <div class="dg-titlebar-left" {...dragRegion}>
        {LOGO}
        <ProjectSwitcher />
        <BranchWidget />
        <span class="dg-titlebar-sep" />
        <button
          type="button"
          class="dg-titlebar-btn dg-titlebar-fetch"
          classList={{ [`is-${age().level}`]: true }}
          style={{ "--dg-titlebar-age": `${age().fraction * 360}deg` }}
          aria-label="Fetch all repositories"
          data-tip={`Fetch all repositories\n${age().tooltip} ${autoFetchLine()}`}
          data-tip-shortcut={shortcutLabel("git.fetchAll")}
          onClick={() => void actions.fetchAll()}
        >
          <span class="dg-titlebar-ring" />
          <Show when={fetching()} fallback={<Icon name="fetch" />}>
            <Spinner size={16} />
          </Show>
        </button>
        <button type="button" class="dg-titlebar-btn dg-titlebar-pull" aria-label="Pull" data-tip={pullTip()} data-tip-shortcut={shortcutLabel("git.pull")} onClick={pull}>
          <Icon name="pull" />
          <Show when={projectTotals().behind > 0}>
            <span class="dg-titlebar-n dg-titlebar-n-down">{projectTotals().behind}</span>
          </Show>
        </button>
        <button
          type="button"
          class="dg-titlebar-btn dg-titlebar-push"
          classList={{ "is-hot": projectTotals().ahead > 0 }}
          aria-label="Push"
          data-tip={pushTip()}
          data-tip-shortcut={shortcutLabel("git.push")}
          onClick={push}
        >
          <Icon name="push" />
          <Show when={projectTotals().ahead > 0}>
            <span class="dg-titlebar-n">{projectTotals().ahead}</span>
          </Show>
        </button>
      </div>

      <div class="dg-titlebar-center" {...dragRegion}>
        <button type="button" class="dg-titlebar-search" onClick={() => runBinding("palette.open")} aria-label="Search everywhere">
          <Icon name="search" />
          <span class="dg-titlebar-search-text">Search commits, branches, files, actions</span>
          <Kbd keys="Shift Shift" small />
        </button>
      </div>

      <div class="dg-titlebar-right" {...dragRegion}>
        <button
          type="button"
          class="dg-titlebar-btn"
          classList={{ "is-on": bottomTool() === "console" }}
          aria-label="Git console"
          aria-pressed={bottomTool() === "console"}
          data-tip="Git console"
          data-tip-shortcut={shortcutLabel("tool.console")}
          onClick={() => toggleBottomTool("console")}
        >
          <Icon name="console" />
        </button>
        <button type="button" ref={bellBtn} class="dg-titlebar-btn" aria-label="Notifications" data-tip="Notifications" onClick={openNotifications}>
          <Icon name="bell" />
          <Show when={unreadCount() > 0}>
            <span class="dg-titlebar-dot" />
          </Show>
        </button>
        <button type="button" ref={settingsBtn} class="dg-titlebar-btn" aria-label="Settings" data-tip="Settings" data-tip-shortcut={shortcutLabel("settings.open")} onClick={() => openSettingsMenu(settingsBtn)}>
          <Icon name="gear" />
        </button>
        <span class="dg-titlebar-sep" />
        <WindowControls />
      </div>
    </div>
  );
}
