import { type JSX } from "solid-js";
import { closeWindow, minimizeWindow, toggleMaximizeWindow } from "../../api/window";
import { Icon } from "./Icon";

/**
 * Spread on the empty parts of the title bar so the window can be dragged and a double-click maximizes it:
 *
 *   <div class="my-titlebar" {...dragRegion}>…</div>
 *
 * (Tauri only honours `data-tauri-drag-region` on the element that was clicked, not its children.)
 */
export const dragRegion = {
  "data-tauri-drag-region": true,
  onDblClick: (e: MouseEvent) => {
    if (e.target === e.currentTarget) void toggleMaximizeWindow();
  },
} as const;

/** The three window buttons (minimize, maximize, close), 46 x 40 px each, at the right of the title bar. No-ops in a browser. */
export function WindowControls(): JSX.Element {
  return (
    <div class="dg-wc-group">
      <button type="button" class="dg-wc" aria-label="Minimize" title="Minimize" onClick={() => void minimizeWindow()}>
        <Icon name="minimize" />
      </button>
      <button type="button" class="dg-wc" aria-label="Maximize" title="Maximize" onClick={() => void toggleMaximizeWindow()}>
        <Icon name="maximize" />
      </button>
      <button type="button" class="dg-wc dg-wc-close" aria-label="Close" title="Close" onClick={() => void closeWindow()}>
        <Icon name="close" />
      </button>
    </div>
  );
}
