import { type JSX, splitProps } from "solid-js";
import { type IconName, iconMarkup } from "./icons";

export interface IconProps extends Omit<JSX.SvgSVGAttributes<SVGSVGElement>, "viewBox" | "innerHTML"> {
  name: IconName;
  /** Pixel size (default 16). Stripe icons use 18, ref pills 11. */
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
  const [local, rest] = splitProps(props, ["name", "size", "class"]);
  return (
    <svg
      {...rest}
      class={"dg-icon" + (local.class ? " " + local.class : "")}
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
