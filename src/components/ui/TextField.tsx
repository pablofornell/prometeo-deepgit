import { type JSX, Show, splitProps } from "solid-js";
import { Icon } from "./Icon";
import { Kbd } from "./Kbd";

export interface TextFieldProps extends Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "onInput" | "value" | "size"> {
  value: string;
  onInput?: (value: string, e: InputEvent) => void;
  /** 28 px (default) or 26 px "filter" style. */
  size?: "normal" | "filter";
  /** Red border + aria-invalid. */
  error?: boolean;
  /** Content before / after the input inside the border. */
  leading?: JSX.Element;
  trailing?: JSX.Element;
  /** Receives the <input> (focus it, select it). */
  inputRef?: (el: HTMLInputElement) => void;
}

/**
 * Single-line input (DESIGN.md 5.21): 28 px high, radius 4, 2 px focus border.
 *
 *   <TextField value={name()} onInput={setName} placeholder="Branch name" error={!valid()} />
 */
export function TextField(props: TextFieldProps): JSX.Element {
  const [local, rest] = splitProps(props, ["value", "onInput", "size", "error", "leading", "trailing", "inputRef", "class"]);
  return (
    <label class={`dg-field dg-field-${local.size ?? "normal"}${local.error ? " is-error" : ""}${rest.disabled ? " is-disabled" : ""}${local.class ? " " + local.class : ""}`}>
      {local.leading}
      <input
        {...rest}
        ref={(el) => local.inputRef?.(el)}
        class="dg-field-input"
        value={local.value}
        aria-invalid={local.error ? true : undefined}
        onInput={(e) => local.onInput?.(e.currentTarget.value, e)}
      />
      {local.trailing}
    </label>
  );
}

export interface SearchFieldProps extends Omit<TextFieldProps, "leading" | "trailing"> {
  /** Keycap shown at the right while the field is empty, e.g. "Ctrl+F". */
  shortcut?: string;
  /** Called when the clear button is pressed (the value is also reset to ""). */
  onClear?: () => void;
}

/**
 * TextField with a search icon, a clear button and an optional shortcut hint.
 *
 *   <SearchField size="filter" value={text()} onInput={setText} placeholder="Filter by text or hash" shortcut="Ctrl+F" />
 */
export function SearchField(props: SearchFieldProps): JSX.Element {
  const [local, rest] = splitProps(props, ["shortcut", "onClear", "placeholder"]);
  return (
    <TextField
      {...rest}
      placeholder={local.placeholder ?? "Search"}
      leading={<Icon name="search" size={14} class="dg-field-icon" />}
      trailing={
        <>
          <Show when={rest.value}>
            <button
              type="button"
              class="dg-field-clear"
              aria-label="Clear"
              tabindex={-1}
              onClick={(e) => {
                e.preventDefault();
                rest.onInput?.("", e as unknown as InputEvent);
                local.onClear?.();
              }}
            >
              <Icon name="close" size={12} />
            </button>
          </Show>
          <Show when={local.shortcut && !rest.value}>
            <Kbd keys={local.shortcut} small />
          </Show>
        </>
      }
    />
  );
}
