/**
 * Settings feature entry. `registerSettings()` is called once from `App`:
 *  - registers the "settings" dialog (open it with `showDialog("settings", { section? })` or `runBinding("settings.open")`),
 *  - binds Ctrl+, / Ctrl+Alt+S (Cmd on macOS) to it,
 *  - binds the zoom keys: Ctrl+= / Ctrl++ zoom in, Ctrl+- zoom out, Ctrl+0 reset (they also work in text fields and while a dialog is open).
 */
import { registerDialog, showDialog } from "../../state/dialogs";
import { register } from "../../state/keymap";
import { UI_SCALE_DEFAULT, UI_SCALE_MAX, UI_SCALE_MIN } from "../../state/appearance";
import { setSetting, settings, zoomUi } from "../../state/settings";
import { SettingsDialog } from "./SettingsDialog";
import { showOsd } from "./SettingsHost";

export { SettingsHost } from "./SettingsHost";
export { registerSettingsSection, type SettingsSection } from "./registry";

/** Text of the message after a zoom change ("UI scale 120%", with "(maximum)" at the end of the range). */
export function zoomMessage(percent: number): string {
  const edge = percent >= UI_SCALE_MAX ? " (maximum)" : percent <= UI_SCALE_MIN ? " (minimum)" : "";
  return `UI scale ${percent}%${edge}`;
}

export function registerSettings(): void {
  registerDialog("settings", SettingsDialog);
  register("settings.open", ["Ctrl+Alt+S", "Ctrl+,"], () => void showDialog("settings", {}), { title: "Settings", group: "Global", allowInInput: true });

  // These keys must work in any state: while typing, and with a dialog (Settings itself) open.
  const zoom = { group: "View", allowInInput: true, allowInOverlay: true };
  register("view.zoomIn", ["Ctrl+=", "Ctrl+Plus", "Ctrl+Shift+="], () => showOsd(zoomMessage(zoomUi(1))), { ...zoom, title: "Zoom in (UI scale)" });
  register("view.zoomOut", ["Ctrl+-"], () => showOsd(zoomMessage(zoomUi(-1))), { ...zoom, title: "Zoom out (UI scale)" });
  register(
    "view.zoomReset",
    ["Ctrl+0"],
    () => {
      setSetting("uiScale", UI_SCALE_DEFAULT);
      showOsd(zoomMessage(settings.uiScale));
    },
    { ...zoom, title: "Reset zoom (UI scale 100%)" },
  );
}
