// @vitest-environment node
// Menus and popups close when a dialog opens over them, but a menu opened from a dialog stays.
import { createEffect, createRoot, createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { closeWhenDialogOpens, dialogDepth, setDialogDepth } from "./overlays";

describe("closeWhenDialogOpens", () => {
  it("closes an overlay that was open when a dialog opens, and only then", () => {
    setDialogDepth(0);
    let closed = 0;
    const dispose = createRoot((d) => {
      closeWhenDialogOpens(() => closed++);
      return d;
    });
    expect(closed).toBe(0);
    setDialogDepth(1); // a dialog opens
    expect(closed).toBe(1);
    setDialogDepth(2); // a second one over it
    expect(closed).toBe(2);
    setDialogDepth(1); // closing one does not close anything
    setDialogDepth(0);
    expect(closed).toBe(2);
    dispose();
  });

  it("leaves a menu alone that opens while a dialog is already open (opened from the dialog)", () => {
    setDialogDepth(1);
    const [open, setOpen] = createSignal(false);
    let closed = 0;
    const dispose = createRoot((d) => {
      // like Popup: the hook is set up when the popup opens
      createEffect(() => {
        if (open()) closeWhenDialogOpens(() => closed++);
      });
      return d;
    });
    setOpen(true);
    expect(closed).toBe(0);
    expect(dialogDepth()).toBe(1);
    setDialogDepth(2); // another dialog opens over it: now it closes
    expect(closed).toBe(1);
    dispose();
    setDialogDepth(0);
  });
});
