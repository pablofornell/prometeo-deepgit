/**
 * Changing the colour of a repository or project: the "Set Color" submenu, the custom colour dialog and the
 * calls to the backend. Used by the sidebar menus and Search Everywhere.
 *
 *   openContextMenu(e, [...items, repoColorMenu(repo)]);       // submenu: 12 swatches, Auto, Custom...
 *   await setRepoColor(repo.id, { kind: "palette", index: 3 });
 */
import * as api from "../api/tauri";
import { ColorDialog, type MenuItem, openDialog, toast } from "../components/ui";
import { type ColorChoice, HEX_COLOR, REPO_COLOR_NAMES, REPO_COLOR_ORDER, colorFill, paletteIndex } from "../theme/palette";
import { activeProject, applyProjectColor, applyRepoColor, projectRepos } from "./workspace";

/** What the user picked: a palette index, a custom `#RRGGBB`, or Auto (back to the automatic colour). */
export type ColorPick = { kind: "auto" } | { kind: "palette"; index: number } | { kind: "custom"; hex: string };

const args = (pick: ColorPick): [number | null, string | null] =>
  pick.kind === "palette" ? [pick.index, null] : pick.kind === "custom" ? [null, pick.hex] : [null, null];

/** Sets the colour of a repo (in every project that holds it). Shows an error toast on failure. */
export async function setRepoColor(repoId: string, pick: ColorPick): Promise<void> {
  try {
    const [color, custom] = args(pick);
    applyRepoColor(await api.repoSetColor(repoId, color, custom));
  } catch (e) {
    toast({ kind: "error", title: "Could not change the color", body: api.toApiError(e).message });
  }
}

/** Sets the colour of a project. Shows an error toast on failure. */
export async function setProjectColor(projectId: string, pick: ColorPick): Promise<void> {
  try {
    const [color, custom] = args(pick);
    applyProjectColor(await api.projectSetColor(projectId, color, custom));
  } catch (e) {
    toast({ kind: "error", title: "Could not change the color", body: api.toApiError(e).message });
  }
}

/** Puts the active project and each of its repos back to their automatic colour, one after the other (Settings > Colors). */
export async function resetColorsToAuto(): Promise<void> {
  const project = activeProject();
  if (!project) return;
  const repoIds = projectRepos().map((r) => r.id);
  await setProjectColor(project.id, { kind: "auto" });
  for (const id of repoIds) await setRepoColor(id, { kind: "auto" });
}

/** Opens the custom colour dialog; resolves to the chosen `#RRGGBB`, or undefined when cancelled. */
export function pickCustomColor(subject: string, current: ColorChoice | undefined): Promise<string | undefined> {
  const initial = current?.customColor && HEX_COLOR.test(current.customColor) ? current.customColor : null;
  return openDialog(ColorDialog, { title: "Custom color", subject, initial });
}

/** The "Set Color" menu item for any colour holder (repo or project): swatches with names, Auto, Custom... */
function colorMenu(current: ColorChoice, apply: (pick: ColorPick) => void, subject: string): MenuItem {
  const custom = current.customColor && HEX_COLOR.test(current.customColor) ? current.customColor : null;
  const swatches: MenuItem[] = REPO_COLOR_ORDER.map((i) => ({
    label: REPO_COLOR_NAMES[i],
    swatch: colorFill({ color: i }),
    checked: !custom && paletteIndex(current.color) === i,
    onSelect: () => apply({ kind: "palette", index: i }),
  }));
  return {
    label: "Set Color",
    icon: "palette",
    submenu: [
      ...swatches,
      { separator: true },
      { label: "Auto", tooltip: "Use the automatic color", onSelect: () => apply({ kind: "auto" }) },
      {
        label: "Custom…",
        swatch: custom ?? undefined,
        checked: custom ? true : undefined,
        onSelect: () => void pickCustomColor(subject, current).then((hex) => hex && apply({ kind: "custom", hex })),
      },
    ],
  };
}

export const repoColorMenu = (repo: { id: string; name: string } & ColorChoice): MenuItem =>
  colorMenu(repo, (pick) => void setRepoColor(repo.id, pick), repo.name);

export const projectColorMenu = (project: { id: string; name: string } & ColorChoice): MenuItem =>
  colorMenu(project, (pick) => void setProjectColor(project.id, pick), project.name);
