/**
 * Tooltips. Mount `<TooltipHost />` once (the shell does). Then either:
 *
 *   <button use:tooltip={{ text: "Fetch all repositories", shortcut: "Ctrl+T" }} />     // directive
 *   <button {...tip("Fetch all repositories", "Ctrl+T")} />                              // spread attrs
 *   <button title="Fetch  Ctrl+T" />                                                     // native title, adopted
 *
 * Timing: 450 ms on first hover, 60 ms when a tooltip was just closed. Multi-line text with "\n".
 * Pass `text: undefined` or "" to disable (e.g. while a button is enabled).
 */
import { type Accessor, type JSX, createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { Kbd } from "./Kbd";

export interface TooltipValue {
  text?: string;
  shortcut?: string;
}

declare module "solid-js" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface Directives {
      tooltip: TooltipValue | undefined;
    }
  }
}

/** Attribute object for spreading: `<button {...tip("Refresh", "Ctrl+R")} />`. */
export function tip(text?: string, shortcut?: string): Record<string, string | undefined> {
  return { "data-tip": text || undefined, "data-tip-shortcut": shortcut || undefined };
}

/** Directive form: `use:tooltip={{ text, shortcut }}`; the value may change reactively. */
export function tooltip(el: HTMLElement, value: Accessor<TooltipValue | undefined>): void {
  createEffect(() => {
    const v = value();
    if (v?.text) el.dataset.tip = v.text;
    else delete el.dataset.tip;
    if (v?.shortcut) el.dataset.tipShortcut = v.shortcut;
    else delete el.dataset.tipShortcut;
  });
}

const INITIAL_DELAY = 450;
const REUSE_DELAY = 60;
const REUSE_WINDOW = 800;

/** Turns a native `title` into `data-tip` on first hover ("Text  Shortcut" with two spaces splits the shortcut). */
function adoptTitle(t: Element | null): Element | null {
  const title = t?.getAttribute("title");
  if (!t || !title) return null;
  t.removeAttribute("title");
  const m = /^(.*\S) {2,}(\S.*)$/.exec(title);
  const el = t as HTMLElement;
  if (m && !title.includes("\n")) {
    el.dataset.tip = m[1];
    el.dataset.tipShortcut = m[2];
  } else {
    el.dataset.tip = title;
  }
  return t;
}

export function TooltipHost(): JSX.Element {
  const [shown, setShown] = createSignal<{ text: string; shortcut?: string; x: number; y: number } | null>(null);
  const [pos, setPos] = createSignal<{ left: number; top: number } | null>(null);
  let box: HTMLDivElement | undefined;
  let timer = 0;
  let anchor: Element | null = null;
  let mx = 0;
  let my = 0;
  let lastHidden = 0;

  const hide = () => {
    window.clearTimeout(timer);
    if (shown()) lastHidden = performance.now();
    setShown(null);
    setPos(null);
  };

  const over = (e: MouseEvent) => {
    const el = e.target as Element | null;
    const t = el?.closest?.("[data-tip]") ?? adoptTitle(el?.closest?.("[title]") ?? null);
    if (t === anchor) return;
    hide();
    anchor = t;
    if (!t) return;
    const delay = performance.now() - lastHidden < REUSE_WINDOW ? REUSE_DELAY : INITIAL_DELAY;
    timer = window.setTimeout(() => {
      const d = (t as HTMLElement).dataset;
      if (d.tip) setShown({ text: d.tip, shortcut: d.tipShortcut, x: mx, y: my });
    }, delay);
  };
  const move = (e: MouseEvent) => {
    mx = e.clientX;
    my = e.clientY;
  };

  onMount(() => {
    document.addEventListener("mouseover", over, true);
    document.addEventListener("mousemove", move, true);
    document.addEventListener("mousedown", hide, true);
    document.addEventListener("keydown", hide, true);
    document.addEventListener("wheel", hide, true);
    window.addEventListener("blur", hide);
    onCleanup(() => {
      document.removeEventListener("mouseover", over, true);
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("mousedown", hide, true);
      document.removeEventListener("keydown", hide, true);
      document.removeEventListener("wheel", hide, true);
      window.removeEventListener("blur", hide);
      window.clearTimeout(timer);
    });
  });

  // place below-right of the pointer, flip when it would leave the window
  createEffect(() => {
    const s = shown();
    if (!s || !box) return;
    const r = box.getBoundingClientRect();
    let left = s.x + 12;
    let top = s.y + 18;
    if (left + r.width > window.innerWidth - 6) left = Math.max(6, window.innerWidth - r.width - 6);
    if (top + r.height > window.innerHeight - 6) top = Math.max(6, s.y - r.height - 10);
    setPos({ left, top });
  });

  return (
    <Show when={shown()}>
      {(s) => (
        <Portal>
          <div
            ref={box}
            class="dg-tooltip"
            role="tooltip"
            style={{ left: (pos()?.left ?? s().x) + "px", top: (pos()?.top ?? s().y) + "px", visibility: pos() ? "visible" : "hidden" }}
          >
            <span class="dg-tooltip-text">{s().text}</span>
            <Show when={s().shortcut}>
              <Kbd keys={s().shortcut as string} />
            </Show>
          </div>
        </Portal>
      )}
    </Show>
  );
}
