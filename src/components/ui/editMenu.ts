/**
 * The items of the text menu (ITERATION-3.md 12.2) that `contextGuard.ts` opens on a right click. Pure, so it is tested.
 *
 *   field:     Undo, Redo | Cut, Copy, Paste | Select all
 *   read-only: Copy | Select all
 */
import type { MenuItem } from "./Menu";

/** What the menu needs to know about the field under the pointer. */
export interface EditState {
  /** The field can be changed (no `readonly`, not a locked editor). */
  writable: boolean;
  /** Some text is selected. */
  hasSelection: boolean;
  /** The field holds some text (Select all has something to select). */
  hasText: boolean;
  /** Cut and Copy are never allowed (password fields). */
  noCopy?: boolean;
}

export interface EditActions {
  undo(): void;
  redo(): void;
  cut(): void;
  copy(): void;
  paste(): void;
  selectAll(): void;
}

/** The text menu of an editable field. */
export function editMenuItems(state: EditState, run: EditActions): MenuItem[] {
  const canTake = state.hasSelection && !state.noCopy;
  return [
    { label: "Undo", shortcut: "Ctrl+Z", disabled: !state.writable, onSelect: run.undo },
    { label: "Redo", shortcut: "Ctrl+Shift+Z", disabled: !state.writable, onSelect: run.redo },
    { separator: true },
    { label: "Cut", shortcut: "Ctrl+X", disabled: !state.writable || !canTake, onSelect: run.cut },
    { label: "Copy", shortcut: "Ctrl+C", disabled: !canTake, onSelect: run.copy },
    { label: "Paste", shortcut: "Ctrl+V", disabled: !state.writable, onSelect: run.paste },
    { separator: true },
    { label: "Select all", shortcut: "Ctrl+A", disabled: !state.hasText, onSelect: run.selectAll },
  ];
}

/** The menu of selected text that cannot be edited (dialog text, commit message, console output). */
export function readOnlyMenuItems(run: Pick<EditActions, "copy" | "selectAll">): MenuItem[] {
  return [
    { label: "Copy", shortcut: "Ctrl+C", onSelect: run.copy },
    { separator: true },
    { label: "Select all", shortcut: "Ctrl+A", onSelect: run.selectAll },
  ];
}
