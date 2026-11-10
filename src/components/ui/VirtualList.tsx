import { type JSX, For, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";

export interface VirtualListApi {
  /** Scrolls so that row `index` is visible. `align` "auto" only scrolls when it is outside the viewport. */
  scrollToIndex(index: number, align?: "auto" | "start" | "center" | "end"): void;
  /** Focuses the list (keyboard navigation starts working). */
  focus(): void;
  /** The scrolling element. */
  element(): HTMLElement | undefined;
}

export interface VirtualListProps {
  /** Total number of rows (may be 100 000+). */
  count: number;
  /** Fixed row height in px. */
  rowHeight: number;
  /** Renders one row. Called once per index while the row is mounted; read signals inside to stay reactive. */
  renderRow: (index: number) => JSX.Element;
  /** Extra rows rendered above and below the viewport (default 20). */
  overscan?: number;
  /** Called with the rendered window `[start, end)` (including overscan) when it changes: load data pages here. */
  onRangeChange?: (start: number, end: number) => void;
  /** Index of the selected row. Only used as the starting point of keyboard navigation. */
  selectedIndex?: number | null;
  /** Keyboard navigation asks to select `index` (Up/Down/PageUp/PageDown/Home/End). */
  onSelect?: (index: number) => void;
  /** Called before the built-in keys; `preventDefault()` to take over a key (Tree does this for Left/Right). */
  onKeyDown?: (e: KeyboardEvent) => void;
  /** Receives the imperative API once mounted. */
  apiRef?: (api: VirtualListApi) => void;
  class?: string;
  /** ARIA role of the container (default "listbox"). */
  role?: string;
  ariaLabel?: string;
}

/**
 * Fixed-row-height virtual list: only the rows in (and around) the viewport exist in the DOM, so
 * 100 000 rows scroll smoothly. Selection is owned by the caller; this component only reports keyboard
 * requests through `onSelect`.
 *
 *   <VirtualList count={total()} rowHeight={24} selectedIndex={sel()} onSelect={setSel}
 *     onRangeChange={(a, b) => loadPages(a, b)} renderRow={(i) => <LogRow row={rows()[i]} />} apiRef={(a) => (api = a)} />
 *   api.scrollToIndex(1200, "center");
 */
export function VirtualList(props: VirtualListProps): JSX.Element {
  let el: HTMLDivElement | undefined;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewH, setViewH] = createSignal(0);
  const overscan = () => props.overscan ?? 20;

  const first = createMemo(() => Math.floor(scrollTop() / props.rowHeight));
  const start = createMemo(() => Math.max(0, first() - overscan()));
  const end = createMemo(() => Math.min(props.count, first() + Math.ceil(viewH() / props.rowHeight) + 1 + overscan()));
  const indexes = createMemo<number[]>(() => {
    const out: number[] = [];
    for (let i = start(); i < end(); i++) out.push(i);
    return out;
  });

  createEffect(on([start, end, () => props.count], ([s, e]) => props.onRangeChange?.(s, e)));

  const scrollToIndex: VirtualListApi["scrollToIndex"] = (index, align = "auto") => {
    if (!el) return;
    const h = props.rowHeight;
    const top = index * h;
    const vh = el.clientHeight;
    if (align === "start") el.scrollTop = top;
    else if (align === "end") el.scrollTop = top - vh + h;
    else if (align === "center") el.scrollTop = top - (vh - h) / 2;
    else if (top < el.scrollTop) el.scrollTop = top;
    else if (top + h > el.scrollTop + vh) el.scrollTop = top + h - vh;
  };

  onMount(() => {
    if (!el) return;
    setViewH(el.clientHeight);
    const ro = new ResizeObserver(() => el && setViewH(el.clientHeight));
    ro.observe(el);
    onCleanup(() => ro.disconnect());
    props.apiRef?.({ scrollToIndex, focus: () => el?.focus({ preventScroll: true }), element: () => el });
  });

  const onKeyDown = (e: KeyboardEvent) => {
    props.onKeyDown?.(e);
    if (e.defaultPrevented || props.count === 0 || !props.onSelect) return;
    const cur = props.selectedIndex ?? -1;
    const page = Math.max(1, Math.floor((el?.clientHeight ?? 0) / props.rowHeight) - 1);
    let next: number | null = null;
    switch (e.key) {
      case "ArrowDown": next = cur + 1; break;
      case "ArrowUp": next = cur < 0 ? props.count - 1 : cur - 1; break;
      case "PageDown": next = cur + page; break;
      case "PageUp": next = cur - page; break;
      case "Home": next = 0; break;
      case "End": next = props.count - 1; break;
    }
    if (next === null) return;
    e.preventDefault();
    next = Math.max(0, Math.min(props.count - 1, next));
    scrollToIndex(next, "auto");
    props.onSelect(next);
  };

  return (
    <div
      ref={el}
      class={"dg-vlist" + (props.class ? " " + props.class : "")}
      tabindex={0}
      role={(props.role ?? "listbox") as "listbox"}
      aria-label={props.ariaLabel}
      aria-rowcount={props.count}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      onKeyDown={onKeyDown}
    >
      <div class="dg-vlist-spacer" style={{ height: props.count * props.rowHeight + "px" }}>
        <For each={indexes()}>
          {(i) => (
            <div class="dg-vlist-row" data-index={i} style={{ top: i * props.rowHeight + "px", height: props.rowHeight + "px" }}>
              {props.renderRow(i)}
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
