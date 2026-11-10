import { type JSX, Show, createEffect, createUniqueId } from "solid-js";

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Visible label (clicking it toggles). */
  label?: JSX.Element;
  /** Dash instead of a tick (mixed children). */
  indeterminate?: boolean;
  disabled?: boolean;
  title?: string;
  /** Needed when there is no `label`. */
  ariaLabel?: string;
}

/**
 * 16 px checkbox with optional label.
 *
 *   <Checkbox checked={amend()} onChange={setAmend} label="Amend" />
 */
export function Checkbox(props: CheckboxProps): JSX.Element {
  const id = createUniqueId();
  let input: HTMLInputElement | undefined;
  createEffect(() => {
    if (input) input.indeterminate = !!props.indeterminate;
  });
  return (
    <label class="dg-check" classList={{ "is-disabled": props.disabled }} title={props.title} for={id}>
      <input
        id={id}
        type="checkbox"
        class="dg-check-input"
        checked={props.checked}
        disabled={props.disabled}
        aria-label={props.ariaLabel}
        ref={input}
        onChange={(e) => props.onChange(e.currentTarget.checked)}
      />
      <span class="dg-check-box" classList={{ "is-checked": props.checked || !!props.indeterminate }} aria-hidden="true">
        <Show when={props.indeterminate} fallback={props.checked ? <svg viewBox="0 0 16 16" width="16" height="16"><path d="m4 8.4 2.6 2.6L12 5.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg> : null}>
          <svg viewBox="0 0 16 16" width="16" height="16"><path d="M4.5 8h7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
        </Show>
      </span>
      <Show when={props.label}>
        <span class="dg-check-label">{props.label}</span>
      </Show>
    </label>
  );
}
