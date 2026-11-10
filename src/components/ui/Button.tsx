import { type JSX, Show, splitProps } from "solid-js";
import { Icon } from "./Icon";
import type { IconName } from "./icons";
import { tip } from "./Tooltip";

export interface ButtonProps extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "title"> {
  /** default = outlined, primary = accent fill, danger = red fill, ghost = no border, tonal / tonal-danger = accent / red wash. */
  variant?: "default" | "primary" | "danger" | "ghost" | "tonal" | "tonal-danger";
  /** "small" is 24 px high (banners, inline). Default 28 px. */
  size?: "normal" | "small";
  icon?: IconName;
  /** Tooltip text. */
  title?: string;
  /** Shortcut shown in the tooltip, e.g. "Ctrl+Enter". */
  shortcut?: string;
}

/**
 * Text button (DESIGN.md 5.21).
 *
 *   <Button variant="primary" onClick={save}>Commit</Button>
 *   <Button variant="danger" icon="delete">Discard 3 files</Button>
 */
export function Button(props: ButtonProps): JSX.Element {
  const [local, rest] = splitProps(props, ["variant", "size", "icon", "title", "shortcut", "class", "children", "type"]);
  return (
    <button
      type={local.type ?? "button"}
      {...rest}
      {...tip(local.title, local.shortcut)}
      class={`dg-btn dg-btn-${local.variant ?? "default"}${local.size === "small" ? " dg-btn-small" : ""}${local.class ? " " + local.class : ""}`}
    >
      <Show when={local.icon}>{(i) => <Icon name={i()} size={14} />}</Show>
      {local.children}
    </button>
  );
}

export interface IconButtonProps extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "title"> {
  icon: IconName;
  /** Accessible name and tooltip text (required: icon buttons have no visible label). */
  label: string;
  shortcut?: string;
  /** Toggled-on state (`--dg-toolbar-selected-bg`). */
  active?: boolean;
  /** 18 px for dense places, 22 px (default, DESIGN.md action button), 30 px for toolbars. */
  size?: "small" | "normal" | "large";
  /** Icon size in px (default 16). */
  iconSize?: number;
}

/**
 * Icon-only button with tooltip and aria-label.
 *
 *   <IconButton icon="refresh" label="Refresh" shortcut="Ctrl+R" onClick={reload} />
 *   <IconButton icon="eye" label="Highlight path" active={on()} onClick={() => setOn(!on())} />
 */
export function IconButton(props: IconButtonProps): JSX.Element {
  const [local, rest] = splitProps(props, ["icon", "label", "shortcut", "active", "size", "iconSize", "class", "type"]);
  return (
    <button
      type={local.type ?? "button"}
      {...rest}
      {...tip(local.label, local.shortcut)}
      aria-label={local.label}
      aria-pressed={local.active === undefined ? undefined : local.active}
      class={`dg-iconbtn dg-iconbtn-${local.size ?? "normal"}${local.active ? " is-on" : ""}${local.class ? " " + local.class : ""}`}
    >
      <Icon name={local.icon} size={local.iconSize ?? 16} />
    </button>
  );
}
