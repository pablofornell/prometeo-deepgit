/**
 * How many modal dialogs are open, and a hook for the overlays that must not stay above a new dialog.
 *
 * Menus and popups sit above the dialog scrim (z-index 1600 against 1500) so that one opened from inside a dialog is
 * visible. The price: one that was already open when a dialog opens would stay above the scrim and could be clicked.
 * So every menu and popup calls `closeWhenDialogOpens`: it closes when the number of open dialogs grows, and only then,
 * so a menu opened from a dialog (the count does not change after it opened) stays.
 */
import { createEffect, createSignal, on } from "solid-js";

const [dialogDepth, setDialogDepth] = createSignal(0);

/** Number of open modal dialogs (reactive). `ui/Dialog.tsx` keeps it. */
export { dialogDepth, setDialogDepth };

/** Inside a component or effect: runs `close` each time a dialog opens after this call (not for one that is open already). */
export function closeWhenDialogOpens(close: () => void): void {
  createEffect(
    on(dialogDepth, (depth, before) => {
      if (before !== undefined && depth > before) close();
    }),
  );
}
