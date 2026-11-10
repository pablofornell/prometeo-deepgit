import { type JSX, Show } from "solid-js";
import { Icon } from "./Icon";

/** Rotating arc. `<Spinner />` or `<Spinner size={14} />`. Colour = current text colour. */
export function Spinner(props: { size?: number }): JSX.Element {
  return <Icon name="progress" size={props.size ?? 16} class="dg-spinner" role="progressbar" aria-label="Loading" />;
}

export interface ProgressBarProps {
  /** Current value; omit (or `indeterminate`) for the looping bar. */
  value?: number;
  max?: number;
  indeterminate?: boolean;
  /** Width in px (default 96, DESIGN.md 5.17). */
  width?: number;
}

/**
 * 4 px progress bar.
 *
 *   <ProgressBar value={7} max={12} />      <ProgressBar indeterminate />
 */
export function ProgressBar(props: ProgressBarProps): JSX.Element {
  const indeterminate = () => props.indeterminate || props.value === undefined;
  const pct = () => Math.max(0, Math.min(100, ((props.value ?? 0) / (props.max ?? 100)) * 100));
  return (
    <div
      class="dg-progress"
      style={{ width: (props.width ?? 96) + "px" }}
      role="progressbar"
      aria-valuenow={indeterminate() ? undefined : props.value}
      aria-valuemax={props.max ?? 100}
    >
      <Show when={indeterminate()} fallback={<i style={{ width: pct() + "%" }} />}>
        <i class="dg-progress-ind" />
      </Show>
    </div>
  );
}
