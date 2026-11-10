/**
 * The one place that answers "what colour is repo X" (and project Y).
 *
 *   <i style={{ background: repoColor(repo) }} />      // fill: spine, square, dot
 *   <div class="dg-tint" style={repoVars(repo)} />     // tint, chip text: sets --rc, --rc-fg, --rc-tint
 *
 * A repo or project has a palette index (`color`, automatic) and an optional `customColor` (`#RRGGBB`)
 * the user picked; the custom colour wins. Pass `undefined` for an unknown repo: you get palette colour 0.
 */
import type { JSX } from "solid-js";
import { type ColorChoice, colorFg, colorFill, colorVars } from "../theme/palette";
import { resolvedTheme } from "./settings";

/** CSS fill colour: `#RRGGBB` or `var(--dg-repo-N)`. */
export function repoColor(c: ColorChoice | undefined): string {
  return colorFill(c);
}

/** CSS text colour that reads on the repo's tint in the current theme. */
export function repoTextColor(c: ColorChoice | undefined): string {
  return colorFg(c, resolvedTheme());
}

/** Inline style that sets `--rc`, `--rc-fg` (and `--rc-tint` when needed). Reactive to the theme. */
export function repoVars(c: ColorChoice | undefined): JSX.CSSProperties {
  return colorVars(c, resolvedTheme()) as JSX.CSSProperties;
}
