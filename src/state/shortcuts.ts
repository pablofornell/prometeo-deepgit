/**
 * Global shortcuts that are not owned by a feature (tool windows, git actions on the focused repo).
 * Registered once from `App`. Feature-specific keys (log filter, diff navigation...) are registered by the
 * feature itself with `register()` from `state/keymap.ts`.
 */
import * as actions from "./actions";
import { notifyRepoChanged } from "./events";
import { openBottomTool, setSidebarVisible, toggleBottomTool, toggleSidebar } from "./layout";
import { register } from "./keymap";
import { detailsTab, mainTab, setDetailsTab, setMainTab } from "./selection";
import { toggleTheme } from "./settings";
import { activeProject, focusedRepo, projectRepos, refreshSummaries } from "./workspace";

const hasProject = () => !!activeProject();
/** Focus is inside the "File changes" tab of the right column. */
const inFileChanges = () => !!(document.activeElement as HTMLElement | null)?.closest?.('[data-details-view="diff"]');

export function registerGlobalShortcuts(): void {
  // Ctrl chords do not fire in text fields unless `allowInInput`: none of these clash with text editing, so they all opt in.
  const g = (title: string) => ({ title, group: "Global", when: hasProject, allowInInput: true });
  register("tool.sidebar", "Alt+1", toggleSidebar, { title: "Toggle project sidebar", group: "Tool windows" });
  register("tool.changes", "Alt+0", () => setMainTab(mainTab() === "changes" ? "log" : "changes"), { title: "Show local changes", group: "Tool windows", when: hasProject });
  register("tool.stashes", "Alt+3", () => setSidebarVisible(true), { title: "Show the sidebar (stashes)", group: "Tool windows", when: hasProject });
  register("tool.matrix", "Alt+2", () => toggleBottomTool("matrix"), { title: "Toggle branch matrix", group: "Tool windows", when: hasProject });
  register("tool.console", "Alt+9", () => toggleBottomTool("console"), { title: "Toggle git console", group: "Tool windows" });
  register("tool.diff", "Ctrl+D", () => setDetailsTab("diff"), { title: "Show file changes (the diff)", group: "Tool windows", allowInInput: true });
  register("tool.changedFiles", [], () => setDetailsTab("files"), { title: "Show changed files (Esc in the diff)", group: "Tool windows" });
  // Esc inside the diff goes back to the file tree. The log's own Esc ("return focus to the log") ignores the diff tab.
  register(
    "diff.back",
    "Esc",
    () => {
      if (!inFileChanges()) return false;
      setDetailsTab("files");
      queueMicrotask(() => document.querySelector<HTMLElement>('[data-details-view="files"] [role="tree"]')?.focus());
    },
    { when: () => detailsTab() === "diff" },
  );
  register("tool.closeBottom", "Shift+Esc", () => openBottomTool(null), { title: "Hide the bottom tool window", group: "Tool windows" });

  register("git.fetchAll", "Ctrl+T", () => void actions.fetchAll(), g("Fetch all repositories"));
  register("git.pull", "Ctrl+Shift+T", () => {
    const r = focusedRepo();
    if (r) void actions.pull(r.id);
  }, g("Pull the focused repository"));
  register("git.pullAll", "Ctrl+Alt+Shift+T", () => void actions.pull(projectRepos().map((r) => r.id)), g("Pull all repositories"));
  register("git.push", "Ctrl+Shift+K", () => {
    const r = focusedRepo();
    if (r) void actions.push(r.id);
  }, g("Push the focused repository"));
  register("git.newBranch", "Ctrl+Alt+N", () => {
    const r = focusedRepo();
    if (r) void actions.createBranch([r.id], "HEAD", { startLabel: "HEAD" });
  }, g("New branch"));
  register("git.stash", "Ctrl+Alt+Z", () => {
    const r = focusedRepo();
    if (r) void actions.stashSave([r.id]);
  }, g("Stash changes"));
  register("view.refresh", "Ctrl+R", () => {
    for (const r of projectRepos()) notifyRepoChanged(r.id);
    void refreshSummaries();
  }, g("Refresh"));
  register("view.toggleTheme", [], toggleTheme, { title: "Toggle dark / light theme", group: "View" });
}
