import { For, type JSX, Show } from "solid-js";
import { Icon } from "./Icon";
import type { IconName } from "./icons";
import { tip } from "./Tooltip";

export interface SegmentOption<T extends string> {
  value: T;
  /** Text label; omit for an icon-only segment. */
  label?: string;
  icon?: IconName;
  /** Tooltip (and aria-label for icon-only segments). */
  title?: string;
}

export interface SegmentedControlProps<T extends string> {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name of the group. */
  label?: string;
}

/**
 * Segmented toggle (24 px high). Used for "Side by side / Unified" and "Tree / List".
 *
 *   <SegmentedControl value={mode()} onChange={setMode}
 *     options={[{ value: "sideBySide", label: "Side by side", icon: "sideBySide" }, { value: "unified", label: "Unified", icon: "unified" }]} />
 */
export function SegmentedControl<T extends string>(props: SegmentedControlProps<T>): JSX.Element {
  return (
    <div class="dg-seg" role="group" aria-label={props.label}>
      <For each={props.options}>
        {(o) => (
          <button
            type="button"
            class="dg-seg-btn"
            classList={{ "is-on": o.value === props.value, "is-icon": !o.label }}
            aria-pressed={o.value === props.value}
            aria-label={o.title ?? o.label}
            {...tip(o.title)}
            onClick={() => props.onChange(o.value)}
          >
            <Show when={o.icon}>{(i) => <Icon name={i()} size={14} />}</Show>
            <Show when={o.label}>{o.label}</Show>
          </button>
        )}
      </For>
    </div>
  );
}
