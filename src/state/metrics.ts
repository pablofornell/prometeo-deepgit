/**
 * Reads resolved pixel values of CSS tokens (`--dg-log-row-height`...). Tokens are `round(calc(24 * var(--dg-u)), 1px)`
 * expressions, so `getPropertyValue` would return the expression text; a hidden probe element resolves it.
 * `cssPx` reads `appearanceRev()`, so a memo or effect that calls it re-runs when the font size changes.
 */
import { createSignal } from "solid-js";

const [rev, setRev] = createSignal(0);

/** Counter bumped every time the font size, editor font size or UI scale is applied (reactive). */
export const appearanceRev = rev;
export const bumpAppearance = (): void => {
  setRev((n) => n + 1);
};

let probe: HTMLElement | null = null;
let cache = new Map<string, number>();
let cacheRev = -1;

/** Pixel value of a length token on `<html>`, or `fallback` when the token is missing or not a length. */
export function cssPx(name: string, fallback: number): number {
  const r = rev();
  if (typeof document === "undefined") return fallback;
  if (r !== cacheRev) {
    cache = new Map();
    cacheRev = r;
  }
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  if (getComputedStyle(document.documentElement).getPropertyValue(name).trim() === "") return fallback;
  if (!probe || !probe.isConnected) {
    probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;width:0;overflow:hidden;";
    document.documentElement.appendChild(probe);
  }
  probe.style.height = `var(${name})`;
  const v = parseFloat(getComputedStyle(probe).height);
  probe.style.height = "";
  const out = Number.isFinite(v) ? v : fallback;
  cache.set(name, out);
  return out;
}
