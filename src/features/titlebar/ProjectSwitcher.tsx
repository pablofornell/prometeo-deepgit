/** Project switcher (DESIGN.md 5.1 #2): badge + name + chevron; the menu lists projects and the project actions. Ctrl+Alt+P. */
import { type JSX, onCleanup } from "solid-js";
import { Icon, initials, openMenu, plural, toast, type MenuItem } from "../../components/ui";
import { projectColorMenu } from "../../state/colorActions";
import { confirmAction } from "../../state/dialogs";
import { register } from "../../state/keymap";
import { activeProject, addProject, removeProject, repoVars, rescanProject, setActiveProject, workspace } from "../../state/workspace";
import * as api from "../../api/tauri";

export function ProjectSwitcher(): JSX.Element {
  let button: HTMLButtonElement | undefined;

  const add = async () => {
    try {
      await addProject();
    } catch (e) {
      const err = api.toApiError(e);
      toast({ kind: "error", title: err.message || "Could not add the project", body: err.detail });
    }
  };

  const rescan = async (id: string, name: string) => {
    try {
      await rescanProject(id);
      toast({ kind: "success", title: `Rescanned ${name}` });
    } catch (e) {
      toast({ kind: "error", title: api.toApiError(e).message || `Could not rescan ${name}` });
    }
  };

  const remove = async (id: string, name: string) => {
    const r = await confirmAction({
      title: "Remove project",
      message: `Remove ${name} from DeepGit? The repositories stay on disk.`,
      confirmLabel: "Remove project",
      danger: true,
    });
    if (r) await removeProject(id);
  };

  const items = (): MenuItem[] => {
    const active = activeProject();
    const list: MenuItem[] = [{ label: "Projects", heading: true }];
    for (const p of workspace.projects) {
      list.push({
        label: p.name,
        shortcut: plural(p.repos.length, "repo"),
        checked: p.id === active?.id,
        tooltip: p.path,
        tint: p,
        onSelect: () => void setActiveProject(p.id),
      });
    }
    list.push({ separator: true }, { label: "Add project folder…", icon: "plus", onSelect: () => void add() });
    if (active) {
      list.push(
        { label: `Rescan ${active.name}`, icon: "refresh", onSelect: () => void rescan(active.id, active.name) },
        projectColorMenu(active),
        { label: `Remove ${active.name}…`, icon: "delete", danger: true, onSelect: () => void remove(active.id, active.name) },
      );
    }
    return list;
  };

  const open = () => {
    if (button) openMenu(button, items);
  };

  const offs = [register("project.switch", "Ctrl+Alt+P", open, { title: "Switch project", group: "Global", allowInOverlay: true })];
  onCleanup(() => offs.forEach((off) => off()));

  return (
    <button type="button" ref={button} class="dg-titlebar-dd dg-titlebar-project dg-tint-strong" style={repoVars(activeProject())} aria-haspopup="menu" data-tip="Switch project" data-tip-shortcut="Ctrl+Alt+P" onClick={open}>
      <span class="dg-titlebar-badge">{initials(activeProject()?.name ?? "")}</span>
      <span class="dg-titlebar-dd-main">{activeProject()?.name}</span>
      <Icon name="chevronDown" size={14} class="dg-titlebar-chev" />
    </button>
  );
}
