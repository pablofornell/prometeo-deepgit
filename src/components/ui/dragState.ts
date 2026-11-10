import { createSignal } from "solid-js";

/**
 * True while a `Splitter` drag is in progress (set on pointerdown, cleared on pointerup, pointercancel and a lost pointer
 * capture). Views that change layout with their own width (the diff: unified or side by side) hold the layout while it is
 * true and evaluate again when the drag ends.
 */
export const [splitDragging, setSplitDragging] = createSignal(false);
