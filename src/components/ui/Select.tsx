import { For, type JSX, Show, createEffect, createSignal } from "solid-js";
import { Icon } from "./Icon";
import type { IconName } from "./icons";
import { Popup } from "./Popup";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
  disabled?: boolean;
}

export interface SelectProps<T extends string> {
  options: SelectOption<T>[];
  value: T | undefined;
  onChange: (value: T) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Popup width follows the trigger (default true). */
  matchWidth?: boolean;
  ariaLabel?: string;
  class?: string;
}

/**
 * Drop-down list (combo box look, 28 px). Keyboard: Down/Enter/Space open, Up/Down move, Enter picks, Esc closes.
 *
 *   <Select value={mode()} onChange={setMode} options={[{ value: "mixed", label: "Mixed" }, { value: "hard", label: "Hard" }]} />
 */
export function Select<T extends string>(props: SelectProps<T>): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [active, setActive] = createSignal(0);
  let trigger: HTMLButtonElement | undefined;
  const current = () => props.options.find((o) => o.value === props.value);

  createEffect(() => {
    if (open()) setActive(Math.max(0, props.options.findIndex((o) => o.value === props.value)));
  });

  const move = (dir: 1 | -1) => {
    const n = props.options.length;
    for (let k = 1; k <= n; k++) {
      const i = (((active() + dir * k) % n) + n) % n;
      if (!props.options[i].disabled) return setActive(i);
    }
  };
  const pick = (o: SelectOption<T>) => {
    if (o.disabled) return;
    props.onChange(o.value);
    setOpen(false);
    trigger?.focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (props.disabled) return;
    if (!open()) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "ArrowDown") (e.preventDefault(), move(1));
    else if (e.key === "ArrowUp") (e.preventDefault(), move(-1));
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const o = props.options[active()];
      if (o) pick(o);
    }
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        class={"dg-select" + (props.class ? " " + props.class : "")}
        role="combobox"
        aria-expanded={open()}
        aria-haspopup="listbox"
        aria-label={props.ariaLabel}
        disabled={props.disabled}
        onClick={() => setOpen(!open())}
        onKeyDown={onKeyDown}
      >
        <Show when={current()?.icon}>{(i) => <Icon name={i()} />}</Show>
        <span class="dg-select-text" classList={{ "is-placeholder": !current() }}>{current()?.label ?? props.placeholder ?? ""}</span>
        <Icon name="chevronDown" size={14} class="dg-select-chev" />
      </button>
      <Popup open={open()} anchor={() => trigger} onClose={() => setOpen(false)} matchWidth={props.matchWidth ?? true} class="dg-select-popup">
        <div role="listbox" class="dg-select-list" onKeyDown={onKeyDown}>
          <For each={props.options}>
            {(o, i) => (
              <div
                role="option"
                aria-selected={o.value === props.value}
                class="dg-select-opt"
                classList={{ "is-active": active() === i(), "is-selected": o.value === props.value, "is-disabled": !!o.disabled }}
                onMouseEnter={() => !o.disabled && setActive(i())}
                onClick={() => pick(o)}
              >
                <Show when={o.icon}>{(n) => <Icon name={n()} />}</Show>
                <span class="dg-select-opt-text">{o.label}</span>
                <Show when={o.value === props.value}>
                  <Icon name="check" size={14} />
                </Show>
              </div>
            )}
          </For>
        </div>
      </Popup>
    </>
  );
}
