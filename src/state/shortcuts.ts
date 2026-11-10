/**
 * Global shortcuts that are not owned by a feature (tool windows, git actions on the focused repo).
 * Registered once from `App`. Feature-specific keys (log filter, diff navigation...) are registered by the
 * feature itself with `register()` from `state/keymap.ts`.
 */
import * as actions from "./actions";
import { notifyRepoChanged } from "./events";
import { openBottomTool, setSidebarVisible, toggleBottomTool, toggleDiff, toggleSidebar } from "./layout";
import { register } from "./keymap";
import { mainTab, setMainTab } from "./selection";
import { toggleTheme } from "./settings";
import { activeProject, focusedRepo, projectRepos, refreshSummaries } from "./workspace";

const hasProject = () => !!activeProject();

export function registerGlobalShortcuts(): void {
  // Ctrl chords do not fire in text fields unless `allowInInput`: none of these clash with text editing, so they all opt in.
  const g = (title: string) => ({ title, group: "Global", when: hasProject, allowInInput: true });
  register("tool.sidebar", "Alt+1", toggleSidebar, { title: "Toggle project sidebar", group: "Tool windows" });
  register("tool.changes", "Alt+0", () => setMainTab(mainTab() === "changes" ? "log" : "changes"), { title: "Show local changes", group: "Tool windows", when: hasProject });
  register("tool.stashes", "Alt+3", () => setSidebarVisible(true), { title: "Show the sidebar (stashes)", group: "Tool windows", when: hasProject });
  register("tool.matrix", "Alt+2", () => toggleBottomTool("matrix"), { title: "Toggle branch matrix", group: "Tool windows", when: hasProject });
  register("tool.console", "Alt+9", () => toggleBottomTool("console"), { title: "Toggle git console", group: "Tool windows" });
  register("tool.diff", "Ctrl+D", toggleDiff, { title: "Show or hide the diff island", group: "Tool windows", allowInInput: true });
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
