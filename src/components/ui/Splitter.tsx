import { type JSX, createSignal } from "solid-js";
import { loadPersisted, savePersisted } from "../../state/persist";
import { dragSize } from "./splitterMath";

export interface SplitterProps {
  /** "vertical" = a vertical bar between left/right panes (drag changes a width);
   *  "horizontal" = a horizontal bar between top/bottom panes (drag changes a height). */
  orientation: "vertical" | "horizontal";
  /** Current size in px of the pane being resized. */
  size: number;
  onSize: (size: number) => void;
  min?: number;
  /** Maximum size; may be a function for layout-dependent limits. */
  max?: number | (() => number);
  /** The pane being resized is on the right / bottom of the bar: dragging towards the start grows it. */
  reverse?: boolean;
  /** Double-click resets to this size (DESIGN.md 2.3). */
  defaultSize?: number;
  /** Persists the size in localStorage `deepgit.ui.split.<key>` when a drag ends. Read it back with `loadSplitSize`. */
  persistKey?: string;
  class?: string;
}

/** Reads a size saved by a Splitter with the same `persistKey`. */
export function loadSplitSize(key: string, fallback: number): number {
  const v = loadPersisted<number>("split." + key, fallback);
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Invisible 6 px bar between two islands that is also the drag handle (cursor changes only).
 * Place it between the two panes in a flex container; the sized pane gets `size` px.
 *
 *   const [w, setW] = createSignal(loadSplitSize("sidebar", 280));
 *   <aside style={{ width: w() + "px" }} />
 *   <Splitter orientation="vertical" size={w()} onSize={setW} min={200} max={480} defaultSize={280} persistKey="sidebar" />
 */
export function Splitter(props: SplitterProps): JSX.Element {
  const [dragging, setDragging] = createSignal(false);
  const vertical = () => props.orientation === "vertical";
  const maxSize = () => (typeof props.max === "function" ? props.max() : props.max);

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const start = vertical() ? e.clientX : e.clientY;
    const startSize = props.size;
    let last = dragSize(startSize, 0, false, props.min, maxSize());
    setDragging(true);
    document.body.classList.add(vertical() ? "dg-resizing-col" : "dg-resizing-row");
    const move = (ev: PointerEvent) => {
      const d = (vertical() ? ev.clientX : ev.clientY) - start;
      last = dragSize(startSize, d, !!props.reverse, props.min, maxSize());
      props.onSize(last);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      setDragging(false);
      document.body.classList.remove("dg-resizing-col", "dg-resizing-row");
      if (props.persistKey) savePersisted("split." + props.persistKey, last);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const onKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 40 : 10;
    const grow = vertical() ? (props.reverse ? "ArrowLeft" : "ArrowRight") : props.reverse ? "ArrowUp" : "ArrowDown";
    const shrink = vertical() ? (props.reverse ? "ArrowRight" : "ArrowLeft") : props.reverse ? "ArrowDown" : "ArrowUp";
    if (e.key !== grow && e.key !== shrink) return;
    e.preventDefault();
    const v = dragSize(props.size, e.key === grow ? step : -step, false, props.min, maxSize());
    props.onSize(v);
    if (props.persistKey) savePersisted("split." + props.persistKey, v);
  };

  return (
    <div
      class={`dg-splitter dg-splitter-${props.orientation}${props.class ? " " + props.class : ""}`}
      classList={{ "is-dragging": dragging() }}
      role="separator"
      tabindex={0}
      aria-orientation={vertical() ? "vertical" : "horizontal"}
      aria-valuenow={props.size}
      onPointerDown={onDown}
      onKeyDown={onKey}
      onDblClick={() => {
        if (props.defaultSize === undefined) return;
        props.onSize(props.defaultSize);
        if (props.persistKey) savePersisted("split." + props.persistKey, props.defaultSize);
      }}
    />
  );
}
