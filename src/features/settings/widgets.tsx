/**
 * Building blocks for settings pages. Every section is a stack of `Section` groups holding `Row`s:
 *
 *   <Section title="Text">
 *     <Row label="Font size" hint="Applies at once."><SizeControl label="Font size" value={13} min={10} max={20} unit="px" pin="layout" onChange={...} /></Row>
 *     <Row label="Show the graph"><Checkbox checked={...} onChange={...} /></Row>
 *   </Section>
 */
import { type JSX, For, Show, createEffect, createSignal, createUniqueId, onCleanup } from "solid-js";
import { IconButton, type PendingReanchor, moveDialogBy, reanchorClick, reanchorResized, reanchorScale } from "../../components/ui";
import {
  type DragSignal, type NumberRange, type Point, SLIDER_IDLE, type SliderEvent, dragEnd, parseNumberText, pinShift, sliderStep, snapToRange, stepBy,
} from "./sizeControl";

/** A titled group of rows inside a page. */
export function Section(props: { title?: string; children: JSX.Element }): JSX.Element {
  return (
    <section class="dg-settings-group">
      <Show when={props.title}>
        <h3 class="dg-settings-group-title">{props.title}</h3>
      </Show>
      {props.children}
    </section>
  );
}

/** One setting: label (and optional hint) on the left, the control on the right. */
export function Row(props: { label: string; hint?: JSX.Element; children: JSX.Element }): JSX.Element {
  const hintId = createUniqueId();
  return (
    <div class="dg-settings-row" role="group" aria-label={props.label} aria-describedby={props.hint ? hintId : undefined}>
      <div class="dg-settings-row-text">
        <span class="dg-settings-row-label">{props.label}</span>
        <Show when={props.hint}>
          <span class="dg-settings-row-hint" id={hintId}>{props.hint}</span>
        </Show>
      </div>
      <div class="dg-settings-row-control">{props.children}</div>
    </div>
  );
}

export interface Choice<T extends string> {
  value: T;
  label: string;
  /** Shown after the label, muted; may be a live value (read inside the list, so it updates in place). */
  example?: () => string;
}

/** Radio list, one choice per line with an optional live example ("Relative  3 h ago"). Arrow keys move the choice. */
export function ChoiceList<T extends string>(props: { label: string; value: T; options: readonly Choice<T>[]; onChange: (v: T) => void }): JSX.Element {
  const name = createUniqueId();
  return (
    <div class="dg-settings-choices" role="radiogroup" aria-label={props.label}>
      <For each={props.options}>
        {(o) => (
          <label class="dg-settings-choice" classList={{ "is-on": props.value === o.value }}>
            <input class="dg-settings-choice-input" type="radio" name={name} value={o.value} checked={props.value === o.value} onChange={() => props.onChange(o.value)} />
            <span class="dg-settings-choice-dot" aria-hidden="true" />
            <span class="dg-settings-choice-label">{o.label}</span>
            <Show when={o.example}>{(ex) => <span class="dg-settings-choice-example">{ex()()}</span>}</Show>
          </label>
        )}
      </For>
    </div>
  );
}

export interface NumberFieldProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Text after the number ("px", "%"). */
  unit?: string;
  /** Shown instead of the unit when the value is 0 ("Off"). */
  zeroLabel?: string;
  onChange: (value: number) => void;
  /** Accessible name. */
  label: string;
  disabled?: boolean;
  /**
   * Set it when a change of this value resizes the page, so that the control would move away from the pointer:
   * "layout" for a size that reflows the page (font size), "zoom" when the value is the page zoom in percent.
   * After a change made with the pointer the dialog is moved so that the control is still under the pointer.
   */
  pin?: "layout" | "zoom";
}

const inTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
/** The keys that change a number: holding one down gives one step, not a run of them (each step resizes the page). */
const STEP_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"]);

/** The one dialog move that waits for a page zoom (`reanchorClick`), and what ends it. */
let pending: PendingReanchor<HTMLElement> | null = null;
let pendingTimer = 0;
let pendingFrame = 0;

const endPending = () => {
  window.clearTimeout(pendingTimer);
  cancelAnimationFrame(pendingFrame);
  window.removeEventListener("resize", onZoomResize);
  pending = null;
};

/**
 * The zoom applied. The dialog moves in the next frame, from the geometry it has then. Each `resize` puts the dialog
 * back in its place (`Dialog`), so a second `resize` (one per zoom step) moves it again from scratch, not twice.
 */
function onZoomResize(): void {
  if (!pending) return;
  pending = reanchorResized(pending);
  cancelAnimationFrame(pendingFrame);
  pendingFrame = requestAnimationFrame(() => {
    const p = pending;
    if (p?.anchor.isConnected) moveDialogBy(p.anchor, pinShift(p.before, p.anchor.getBoundingClientRect(), p.pointer, reanchorScale(p)));
  });
  window.clearTimeout(pendingTimer);
  pendingTimer = window.setTimeout(endPending, 400);
}

/**
 * Runs `change` (it resizes the page) and then moves the dialog so that `anchor` is under the pointer again
 * (`pinShift`). `zoom` is `[old percent, new percent]` when the change is a page zoom: the webview applies it a moment
 * later and client coordinates change with it, so the move waits for the `resize` that the zoom causes. Quick clicks
 * share one pending move, so the dialog moves once (`reanchorClick`).
 */
function changeInPlace(anchor: HTMLElement, pointer: Point | null, change: () => void, zoom?: [number, number]): void {
  const before = anchor.getBoundingClientRect();
  if (!zoom) {
    change();
    if (anchor.isConnected) moveDialogBy(anchor, pinShift(before, anchor.getBoundingClientRect(), pointer, 1));
    return;
  }
  // In a browser the zoom is the CSS `zoom` of <html>: nothing to wait for, and the dialog is not moved.
  if (!inTauri()) return change();
  const fresh = pending === null;
  pending = reanchorClick(pending, { anchor, before, pointer, from: zoom[0], to: zoom[1] });
  if (fresh) window.addEventListener("resize", onZoomResize);
  // a move computed for the earlier click must not run with this click's geometry
  cancelAnimationFrame(pendingFrame);
  window.clearTimeout(pendingTimer);
  pendingTimer = window.setTimeout(endPending, 1500);
  change();
}

/**
 * Minus button, number box, plus button. A click on `-` / `+` is exactly one step (no repeat while the button is held).
 * Type a number and press Enter or leave the box; Up / Down step the value. Out-of-range input is clamped, text that is
 * not a number goes back to the current value.
 */
export function NumberField(props: NumberFieldProps): JSX.Element {
  const range = (): NumberRange => ({ min: props.min, max: props.max, step: props.step ?? 1 });
  const [text, setText] = createSignal(String(props.value));
  createEffect(() => setText(String(props.value)));
  const set = (v: number) => {
    const next = snapToRange(v, range());
    if (next !== props.value) props.onChange(next);
  };
  /** One step from a `-` / `+` click. A real pointer click keeps the button under the pointer (`pin`). */
  const stepClick = (e: MouseEvent, dir: 1 | -1) => {
    const next = stepBy(props.value, dir, range());
    if (next === props.value) return;
    const button = e.currentTarget;
    if (props.pin && e.detail > 0 && button instanceof HTMLElement) {
      changeInPlace(button, { x: e.clientX, y: e.clientY }, () => props.onChange(next), props.pin === "zoom" ? [props.value, next] : undefined);
    } else {
      props.onChange(next);
    }
  };
  const commit = () => {
    const n = parseNumberText(text());
    if (n !== null) set(n);
    setText(String(props.value));
  };
  return (
    <div class="dg-settings-num" classList={{ "is-disabled": props.disabled }}>
      <IconButton icon="minus" label={`Decrease ${props.label}`} size="small" disabled={props.disabled || props.value <= props.min} onClick={(e) => stepClick(e, -1)} />
      <input
        class="dg-settings-num-input"
        type="text"
        inputmode="numeric"
        aria-label={props.label}
        value={text()}
        disabled={props.disabled}
        onInput={(e) => setText(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            commit();
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            if (!e.repeat) set(stepBy(props.value, e.key === "ArrowUp" ? 1 : -1, range()));
          }
        }}
      />
      <IconButton icon="plus" label={`Increase ${props.label}`} size="small" disabled={props.disabled || props.value >= props.max} onClick={(e) => stepClick(e, 1)} />
      <Show when={props.unit}>
        <span class="dg-settings-num-unit">{props.value === 0 && props.zeroLabel ? props.zeroLabel : props.unit}</span>
      </Show>
    </div>
  );
}

export type SizeControlProps = NumberFieldProps;

/**
 * Slider and number box for the same value.
 *
 * A drag of the slider only previews: the number box shows the value under the pointer and the setting changes once,
 * when the pointer is released. Applying while the slider moves would be a loop for a size setting: the new size moves
 * the slider under the pressed pointer, which reads a new value from the same pointer position (`sizeControl.ts`).
 * Arrow keys on the slider apply at once, one step per key press.
 */
export function SizeControl(props: SizeControlProps): JSX.Element {
  let input: HTMLInputElement | undefined;
  let state = SLIDER_IDLE;
  /** Where the pointer is during a drag (window coordinates). */
  let pointer: Point | null = null;
  let stopTracking: (() => void) | undefined;
  const [preview, setPreview] = createSignal<number | null>(null);
  const shown = () => preview() ?? props.value;
  const fill = () => ((shown() - props.min) / (props.max - props.min)) * 100;

  const dispatch = (event: SliderEvent) => {
    const wasDragging = state.dragging;
    const r = sliderStep(state, event, props.value);
    state = r.state;
    setPreview(r.state.preview);
    if (r.apply === null) return;
    const next = r.apply;
    if (props.pin && wasDragging && input) {
      changeInPlace(input, pointer, () => props.onChange(next), props.pin === "zoom" ? [props.value, next] : undefined);
    } else {
      props.onChange(next);
    }
  };

  /**
   * A pointer went down on the slider. The slider captures it (`setPointerCapture`), so it gets the moves and the
   * release also outside its box; nothing listens on the window for the pointer. The drag ends on the release, or is
   * lost (`dragEnd`: the stored value comes back) when the capture ends without one, the window loses the focus
   * (alt-tab) or the page is hidden.
   */
  const begin = (e: PointerEvent) => {
    const slider = input;
    if (e.button !== 0 || props.disabled || state.dragging || !slider) return;
    pointer = { x: e.clientX, y: e.clientY };
    dispatch({ type: "down" });
    try {
      slider.setPointerCapture(e.pointerId);
    } catch {
      // not an active pointer any more: the release and the window events still end the drag
    }
    const move = (ev: PointerEvent) => {
      pointer = { x: ev.clientX, y: ev.clientY };
    };
    const end = (signal: DragSignal, pressed = false) => {
      if (signal === "pointerup") {
        stop();
        // `change` is the normal end of a drag and comes with the release; this is the net for an engine that does not send it
        window.setTimeout(() => dispatch(dragEnd("pointerup", false, Number(slider.value))!), 0);
        return;
      }
      const event = dragEnd(signal, pressed);
      if (!event) return;
      stop();
      dispatch(event);
    };
    const up = () => end("pointerup");
    const cancel = () => end("pointercancel");
    const lost = (ev: PointerEvent) => end("lostpointercapture", (ev.buttons & 1) === 1);
    const blur = () => end("blur");
    const hidden = () => {
      if (document.visibilityState === "hidden") end("hidden");
    };
    const stop = () => {
      slider.removeEventListener("pointermove", move);
      slider.removeEventListener("pointerup", up);
      slider.removeEventListener("pointercancel", cancel);
      slider.removeEventListener("lostpointercapture", lost);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", hidden);
      stopTracking = undefined;
    };
    slider.addEventListener("pointermove", move);
    slider.addEventListener("pointerup", up);
    slider.addEventListener("pointercancel", cancel);
    slider.addEventListener("lostpointercapture", lost);
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", hidden);
    stopTracking = stop;
  };
  onCleanup(() => stopTracking?.());

  return (
    <div class="dg-settings-size">
      <input
        ref={input}
        class="dg-settings-slider"
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={shown()}
        disabled={props.disabled}
        aria-label={props.label}
        aria-valuetext={shown() === 0 && props.zeroLabel ? props.zeroLabel : `${shown()}${props.unit ?? ""}`}
        style={{ "--dg-fill": `${fill()}%` }}
        onPointerDown={begin}
        onKeyDown={(e) => {
          if (e.repeat && STEP_KEYS.has(e.key)) e.preventDefault();
        }}
        onInput={(e) => dispatch({ type: "input", value: Number(e.currentTarget.value) })}
        onChange={(e) => dispatch({ type: "release", value: Number(e.currentTarget.value) })}
      />
      <NumberField {...props} value={shown()} />
    </div>
  );
}
