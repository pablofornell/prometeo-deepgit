/** The items of the Cut / Copy / Paste / Select All menu of an editable field (`contextGuard.ts` opens it). Pure, so it is tested. */
import type { MenuItem } from "./Menu";

/** What the Edit menu needs to know about the field under the pointer. */
export interface EditState {
  /** Some text is selected (cut and copy have something to take). */
  hasSelection: boolean;
  /** The field cannot be changed (cut and paste are off). */
  readOnly: boolean;
  /** Copying is not allowed (password fields). */
  noCopy?: boolean;
}

export interface EditActions {
  cut(): void;
  copy(): void;
  paste(): void;
  selectAll(): void;
}

/** The items of the edit menu for a field in `state`. Pure. */
export function editMenuItems(state: EditState, run: EditActions): MenuItem[] {
  const noSelection = !state.hasSelection || !!state.noCopy;
  return [
    { label: "Cut", shortcut: "Ctrl+X", disabled: noSelection || state.readOnly, onSelect: run.cut },
    { label: "Copy", shortcut: "Ctrl+C", disabled: noSelection, onSelect: run.copy },
    { label: "Paste", shortcut: "Ctrl+V", disabled: state.readOnly, onSelect: run.paste },
    { separator: true },
    { label: "Select All", shortcut: "Ctrl+A", onSelect: run.selectAll },
  ];
}
