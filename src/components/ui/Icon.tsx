import { type JSX, splitProps } from "solid-js";
import { type IconName, iconMarkup } from "./icons";

export interface IconProps extends Omit<JSX.SvgSVGAttributes<SVGSVGElement>, "viewBox" | "innerHTML"> {
  name: IconName;
  /** Pixel size at the default 13 px font (default 16). Stripe icons use 18, ref pills 11. The icon grows with the UI font size (`.dg-icon` in ui.css). */
  size?: number;
}

/**
 * Inline SVG icon, 16x16 viewBox, 1 px stroke, `currentColor`. Set the colour with CSS `color`
 * (default `--dg-icon`).
 *
 *   <Icon name="branch" />
 *   <Icon name="chevronDown" size={14} style={{ color: "var(--dg-icon-secondary)" }} />
 */
export function Icon(props: IconProps): JSX.Element {
  const [local, rest] = splitProps(props, ["name", "size", "class", "style"]);
  // `--dg-i` is the size at the default font; ui.css multiplies it with `--dg-u` (the width/height attributes are the fallback).
  const style = (): JSX.CSSProperties | string => {
    const size = String(local.size ?? 16);
    return typeof local.style === "string" ? `--dg-i:${size};${local.style}` : { "--dg-i": size, ...local.style };
  };
  return (
    <svg
      {...rest}
      class={"dg-icon" + (local.class ? " " + local.class : "")}
      style={style()}
      viewBox="0 0 16 16"
      width={local.size ?? 16}
      height={local.size ?? 16}
      fill="none"
      stroke="currentColor"
      stroke-width="1"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      innerHTML={iconMarkup(local.name)}
    />
  );
}
