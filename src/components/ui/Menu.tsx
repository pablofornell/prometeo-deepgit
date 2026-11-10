/**
 * Context menus and dropdown menus (DESIGN.md 5.20). Mount `<MenuHost />` once (the shell does).
 *
 *   <div onContextMenu={(e) => openContextMenu(e, [
 *     { label: "Checkout", icon: "checkout", shortcut: "Enter", onSelect: () => checkout() },
 *     { separator: true },
 *     { label: "Merge into main", disabled: true, tooltip: "Already merged" },
 *     { label: "Delete", icon: "delete", danger: true, onSelect: remove },
 *     { label: "Compare", submenu: [{ label: "With HEAD", onSelect: cmp }] },
 *     { label: "Show tags", checked: showTags(), onSelect: toggle },
 *   ])} />
 *   openMenu(buttonEl, items);   // dropdown under a button
 *
 * Keyboard: Up/Down/Home/End move, Right opens a submenu, Left closes it, Enter/Space selects, Esc closes.
 * Items are listed top to bottom exactly as given; build the array when the menu opens (`items` may be a function).
 */
import { For, type JSX, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { trackOverlay } from "../../state/keymap";
import { Icon } from "./Icon";
import type { IconName } from "./icons";
import { Kbd } from "./Kbd";

export interface MenuItem {
  label?: string;
  icon?: IconName;
  /** Shortcut text shown at the right ("Ctrl+Shift+C"). */
  shortcut?: string;
  disabled?: boolean;
  /** Red text (destructive action). */
  danger?: boolean;
  /** Horizontal line; all other fields are ignored. */
  separator?: boolean;
  /** Small grey group title (not selectable). */
  heading?: boolean;
  /** Shows a tick; the item still needs `onSelect` to toggle. */
  checked?: boolean;
  /** Nested items; opens on hover (150 ms) or Right. */
  submenu?: MenuItem[];
  /** Tooltip (use it to say why an item is disabled). */
  tooltip?: string;
  onSelect?: () => void;
}

interface Level {
  items: MenuItem[];
  x: number;
  y: number;
  /** Rect of the parent item (submenus) or anchor (dropdowns). */
  parent?: DOMRect;
  active: number;
}

const [levels, setLevels] = createSignal<Level[]>([]);
let openTimer = 0;

const selectable = (it: MenuItem) => !it.separator && !it.heading && !it.disabled;

function firstSelectable(items: MenuItem[], from = 0, dir: 1 | -1 = 1): number {
  const n = items.length;
  if (n === 0) return -1;
  for (let k = 0; k < n; k++) {
    const i = (((from + dir * k) % n) + n) % n;
    if (selectable(items[i])) return i;
  }
  return -1;
}

type PointLike = { clientX: number; clientY: number } | { x: number; y: number };

/** Opens a context menu at the pointer of `e` (calls `preventDefault` on real events). */
export function openContextMenu(e: PointLike | MouseEvent, items: MenuItem[] | (() => MenuItem[])): void {
  if ("preventDefault" in e) (e as MouseEvent).preventDefault();
  const x = "clientX" in e ? e.clientX : e.x;
  const y = "clientY" in e ? e.clientY : e.y;
  const list = typeof items === "function" ? items() : items;
  if (list.length === 0) return;
  setLevels([{ items: list, x, y, active: -1 }]);
}

/** Opens a dropdown menu under `anchor` (a button). */
export function openMenu(anchor: HTMLElement, items: MenuItem[] | (() => MenuItem[])): void {
  const r = anchor.getBoundingClientRect();
  const list = typeof items === "function" ? items() : items;
  if (list.length === 0) return;
  setLevels([{ items: list, x: r.left, y: r.bottom + 2, parent: r, active: -1 }]);
}

export function closeMenu(): void {
  window.clearTimeout(openTimer);
  setLevels([]);
}

export const isMenuOpen = (): boolean => levels().length > 0;

function activate(item: MenuItem): void {
  if (!selectable(item)) return;
  if (item.submenu) return;
  closeMenu();
  item.onSelect?.();
}

function setActive(depth: number, index: number, openSub: boolean, rect?: DOMRect): void {
  setLevels((ls) => {
    const next = ls.slice(0, depth + 1);
    next[depth] = { ...next[depth], active: index };
    const item = next[depth].items[index];
    if (openSub && item?.submenu && rect && selectable(item)) {
      next.push({ items: item.submenu, x: rect.right - 4, y: rect.top - 6, parent: rect, active: firstSelectable(item.submenu) });
    }
    return next;
  });
}

function onKey(e: KeyboardEvent): void {
  const ls = levels();
  if (ls.length === 0) return;
  const depth = ls.length - 1;
  const lvl = ls[depth];
  const stop = () => {
    e.preventDefault();
    e.stopPropagation();
  };
  switch (e.key) {
    case "Escape":
      stop();
      if (depth > 0) setLevels(ls.slice(0, depth));
      else closeMenu();
      break;
    case "ArrowDown":
      stop();
      setActive(depth, firstSelectable(lvl.items, lvl.active < 0 ? 0 : lvl.active + 1, 1), false);
      break;
    case "ArrowUp":
      stop();
      setActive(depth, firstSelectable(lvl.items, lvl.active < 0 ? lvl.items.length - 1 : lvl.active - 1, -1), false);
      break;
    case "Home":
      stop();
      setActive(depth, firstSelectable(lvl.items, 0, 1), false);
      break;
    case "End":
      stop();
      setActive(depth, firstSelectable(lvl.items, lvl.items.length - 1, -1), false);
      break;
    case "ArrowRight": {
      stop();
      const item = lvl.items[lvl.active];
      if (item?.submenu && selectable(item)) {
        const el = document.querySelector<HTMLElement>(`[data-menu-level="${depth}"] [data-menu-index="${lvl.active}"]`);
        if (el) setActive(depth, lvl.active, true, el.getBoundingClientRect());
      }
      break;
    }
    case "ArrowLeft":
      stop();
      if (depth > 0) setLevels(ls.slice(0, depth));
      break;
    case "Enter":
    case " ": {
      stop();
      const item = lvl.items[lvl.active];
      if (!item) break;
      if (item.submenu) {
        const el = document.querySelector<HTMLElement>(`[data-menu-level="${depth}"] [data-menu-index="${lvl.active}"]`);
        if (el) setActive(depth, lvl.active, true, el.getBoundingClientRect());
      } else activate(item);
      break;
    }
    case "Tab":
      stop();
      break;
  }
}

function MenuPanel(props: { level: Level; depth: number }): JSX.Element {
  let box: HTMLDivElement | undefined;
  const [pos, setPos] = createSignal<{ left: number; top: number } | null>(null);

  onMount(() => {
    if (!box) return;
    const r = box.getBoundingClientRect();
    let left = props.level.x;
    let top = props.level.y;
    if (props.depth > 0 && props.level.parent && left + r.width > window.innerWidth - 6) left = props.level.parent.left - r.width + 4;
    left = Math.min(Math.max(6, left), Math.max(6, window.innerWidth - r.width - 6));
    if (top + r.height > window.innerHeight - 6) top = Math.max(6, window.innerHeight - r.height - 6);
    setPos({ left, top });
  });

  return (
    <div
      ref={box}
      class="dg-popup dg-menu"
      role="menu"
      data-menu-level={props.depth}
      style={{ left: (pos()?.left ?? props.level.x) + "px", top: (pos()?.top ?? props.level.y) + "px", visibility: pos() ? "visible" : "hidden" }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <For each={props.level.items}>
        {(item, i) => (
          <Show
            when={!item.separator}
            fallback={<div class="dg-menu-sep" role="separator" />}
          >
            <Show
              when={!item.heading}
              fallback={<div class="dg-menu-heading">{item.label}</div>}
            >
              <div
                class="dg-menu-item"
                classList={{
                  "is-active": props.level.active === i(),
                  "is-disabled": !!item.disabled,
                  "is-danger": !!item.danger,
                }}
                role={item.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
                aria-checked={item.checked}
                aria-disabled={item.disabled}
                aria-haspopup={item.submenu ? "menu" : undefined}
                data-menu-index={i()}
                data-tip={item.tooltip}
                onMouseEnter={(e) => {
                  window.clearTimeout(openTimer);
                  const rect = e.currentTarget.getBoundingClientRect();
                  if (item.submenu && selectable(item)) {
                    setActive(props.depth, i(), false);
                    openTimer = window.setTimeout(() => setActive(props.depth, i(), true, rect), 150);
                  } else {
                    setLevels((ls) => {
                      const next = ls.slice(0, props.depth + 1);
                      next[props.depth] = { ...next[props.depth], active: selectable(item) ? i() : -1 };
                      return next;
                    });
                  }
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (item.submenu) setActive(props.depth, i(), true, e.currentTarget.getBoundingClientRect());
                  else activate(item);
                }}
              >
                <span class="dg-menu-check">
                  <Show when={item.checked}>
                    <Icon name="check" size={14} />
                  </Show>
                </span>
                <span class="dg-menu-icon">
                  <Show when={item.icon}>{(n) => <Icon name={n()} />}</Show>
                </span>
                <span class="dg-menu-label">{item.label}</span>
                <Show when={item.shortcut}>
                  <span class="dg-menu-shortcut">{item.shortcut}</span>
                </Show>
                <Show when={item.submenu}>
                  <Icon name="chevronRight" size={14} class="dg-menu-arrow" />
                </Show>
              </div>
            </Show>
          </Show>
        )}
      </For>
    </div>
  );
}

/** Renders the open menu (and its submenus). Mount once near the root. */
export function MenuHost(): JSX.Element {
  trackOverlay(isMenuOpen);
  onMount(() => {
    const down = (e: PointerEvent) => {
      if (levels().length === 0) return;
      if ((e.target as Element | null)?.closest?.(".dg-menu")) return;
      closeMenu();
    };
    const dismiss = () => closeMenu();
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", down, true);
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
    window.addEventListener("wheel", dismiss, { passive: true });
    onCleanup(() => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", down, true);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("wheel", dismiss);
    });
  });
  return (
    <Show when={levels().length > 0}>
      <Portal>
        <For each={levels()}>{(level, d) => <MenuPanel level={level} depth={d()} />}</For>
      </Portal>
    </Show>
  );
}

// Kbd is re-exported for menus that want keycaps instead of plain shortcut text.
export { Kbd as MenuKbd };
