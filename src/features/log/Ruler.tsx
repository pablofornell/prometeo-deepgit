/**
 * Overview ruler (DESIGN.md 5.7, 11.5): a 14 px column at the right edge of the log body. It is the scrollbar (thumb
 * inside) and a map of the whole history: marks for HEAD, branch tips, tags, the selected commit and conflicts.
 * Marks closer than 2 px merge; clicking a mark selects that commit, clicking elsewhere scrolls there.
 */
import { For, type JSX, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { Mark, MarkKind } from "./scan";

export interface RulerProps {
  marks: readonly Mark[];
  /** Number of display rows (commits + group rows). */
  count: number;
  rowHeight: number;
  /** Display index of a commit index. */
  displayOf: (ci: number) => number;
  selectedDisplay: number | null;
  /** The log is showing conflicts of these repos (a mark at the top). */
  conflictLabel: string | null;
  scrollTop: number;
  viewHeight: number;
  /** Scrolls the list. */
  scrollTo: (top: number) => void;
  /** Click on a mark. */
  onPickMark: (m: Mark) => void;
}

interface Placed {
  y: number;
  kind: MarkKind | "conflict";
  label: string;
  mark?: Mark;
}

const PRIORITY: Record<Placed["kind"], number> = { conflict: 4, head: 3, branch: 2, tag: 1 };
/** Marks closer than this many px merge into one. */
const MERGE_PX = 2;
/** Distance in px within which a click picks a mark. */
const PICK_PX = 4;

export function Ruler(props: RulerProps): JSX.Element {
  let el: HTMLDivElement | undefined;
  const [height, setHeight] = createSignal(0);

  onMount(() => {
    if (!el) return;
    setHeight(el.clientHeight);
    const ro = new ResizeObserver(() => el && setHeight(el.clientHeight));
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  });

  const y = (display: number) => (props.count > 0 ? ((display + 0.5) / props.count) * height() : 0);

  const placed = createMemo<Placed[]>(() => {
    const h = height();
    if (h <= 0 || props.count === 0) return [];
    const buckets = new Map<number, Placed>();
    for (const m of props.marks) {
      const py = y(props.displayOf(m.row));
      const key = Math.floor(py / MERGE_PX);
      const cur = buckets.get(key);
      if (!cur || PRIORITY[m.kind] > PRIORITY[cur.kind]) buckets.set(key, { y: py, kind: m.kind, label: m.label, mark: m });
    }
    const out = [...buckets.values()];
    if (props.conflictLabel) out.push({ y: 0, kind: "conflict", label: props.conflictLabel });
    return out;
  });

  const scrollH = () => props.count * props.rowHeight;
  const thumb = () => {
    const sh = scrollH();
    const h = height();
    if (sh <= props.viewHeight || h <= 0) return null;
    const ratio = props.viewHeight / sh;
    return { top: (props.scrollTop / sh) * h, height: Math.max(ratio * h, 18) };
  };

  let drag: { startY: number; startTop: number } | null = null;

  const onDown = (e: PointerEvent) => {
    if (!el || e.button !== 0) return;
    const rect = el.getBoundingClientRect();
    const py = e.clientY - rect.top;
    const t = thumb();
    if ((e.target as HTMLElement).closest(".dg-log-ruler-thumb") && t) {
      drag = { startY: e.clientY, startTop: props.scrollTop };
      el.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    let best: Placed | null = null;
    for (const p of placed()) {
      if (p.mark && Math.abs(p.y - py) <= PICK_PX && (!best || Math.abs(p.y - py) < Math.abs(best.y - py))) best = p;
    }
    if (best?.mark) {
      props.onPickMark(best.mark);
      return;
    }
    props.scrollTo((py / Math.max(1, height())) * scrollH() - props.viewHeight / 2);
  };
  const onMove = (e: PointerEvent) => {
    if (!drag) return;
    props.scrollTo(drag.startTop + ((e.clientY - drag.startY) / Math.max(1, height())) * scrollH());
  };
  const onUp = (e: PointerEvent) => {
    if (drag && el?.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    drag = null;
  };

  return (
    <div
      ref={el}
      class="dg-log-ruler"
      aria-hidden="true"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onWheel={(e) => props.scrollTo(props.scrollTop + e.deltaY)}
    >
      <Show when={thumb()}>{(t) => <div class="dg-log-ruler-thumb" style={{ top: t().top + "px", height: t().height + "px" }} />}</Show>
      <For each={placed()}>
        {(p) => <div class={`dg-log-rm is-${p.kind}`} style={{ top: p.y + "px" }} data-tip={p.label} />}
      </For>
      <Show when={props.selectedDisplay !== null}>
        <div class="dg-log-rm is-selection" style={{ top: y(props.selectedDisplay as number) + "px" }} />
      </Show>
    </div>
  );
}
