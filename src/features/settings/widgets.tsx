/**
 * Building blocks for settings pages. Every section is a stack of `Section` groups holding `Row`s:
 *
 *   <Section title="Text">
 *     <Row label="Font size" hint="Applies at once."><SizeControl label="Font size" value={13} min={10} max={20} unit="px" onChange={...} /></Row>
 *     <Row label="Show the graph"><Checkbox checked={...} onChange={...} /></Row>
 *   </Section>
 */
import { type JSX, Show, createEffect, createSignal, createUniqueId } from "solid-js";
import { IconButton } from "../../components/ui";

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

export interface NumberFieldProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Text after the number ("px", "%"). */
  unit?: string;
  onChange: (value: number) => void;
  /** Accessible name. */
  label: string;
  disabled?: boolean;
}

/**
 * Minus button, number box, plus button. Type a number and press Enter or leave the box; Up / Down step the value.
 * Out-of-range input is clamped, text that is not a number goes back to the current value.
 */
export function NumberField(props: NumberFieldProps): JSX.Element {
  const step = () => props.step ?? 1;
  const [text, setText] = createSignal(String(props.value));
  createEffect(() => setText(String(props.value)));
  const set = (v: number) => props.onChange(Math.min(props.max, Math.max(props.min, v)));
  const commit = () => {
    const n = Number(text().trim().replace(",", "."));
    if (text().trim() !== "" && Number.isFinite(n)) set(n);
    setText(String(props.value));
  };
  return (
    <div class="dg-settings-num" classList={{ "is-disabled": props.disabled }}>
      <IconButton icon="minus" label={`Decrease ${props.label}`} size="small" disabled={props.disabled || props.value <= props.min} onClick={() => set(props.value - step())} />
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
            set(props.value + (e.key === "ArrowUp" ? step() : -step()));
          }
        }}
      />
      <IconButton icon="plus" label={`Increase ${props.label}`} size="small" disabled={props.disabled || props.value >= props.max} onClick={() => set(props.value + step())} />
      <Show when={props.unit}>
        <span class="dg-settings-num-unit">{props.unit}</span>
      </Show>
    </div>
  );
}

export interface SizeControlProps extends NumberFieldProps {
  /**
   * `live` (default): the value is applied while the slider moves.
   * `release`: the slider only previews the number and applies on release (use it when the change moves the slider itself, like page zoom).
   */
  apply?: "live" | "release";
}

/** Slider and number box for the same value. */
export function SizeControl(props: SizeControlProps): JSX.Element {
  const [drag, setDrag] = createSignal<number | null>(null);
  const shown = () => drag() ?? props.value;
  const fill = () => ((shown() - props.min) / (props.max - props.min)) * 100;
  return (
    <div class="dg-settings-size">
      <input
        class="dg-settings-slider"
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={shown()}
        disabled={props.disabled}
        aria-label={props.label}
        aria-valuetext={`${shown()}${props.unit ?? ""}`}
        style={{ "--dg-fill": `${fill()}%` }}
        onInput={(e) => {
          const v = Number(e.currentTarget.value);
          if ((props.apply ?? "live") === "live") props.onChange(v);
          else setDrag(v);
        }}
        onChange={(e) => {
          if (drag() !== null) props.onChange(Number(e.currentTarget.value));
          setDrag(null);
        }}
      />
      <NumberField {...props} value={shown()} />
    </div>
  );
}
