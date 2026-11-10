import { type Accessor, For, type JSX, Show, createMemo, createSignal } from "solid-js";
import { Icon } from "./Icon";
import { VirtualList, type VirtualListApi } from "./VirtualList";

export interface TreeRowInfo {
  depth: number;
  expanded: boolean;
  hasChildren: boolean;
  selected: boolean;
  /** Toggle this node's expansion. */
  toggle: () => void;
}

export interface TreeApi {
  scrollToId(id: string, align?: "auto" | "start" | "center" | "end"): void;
  focus(): void;
}

export interface TreeProps<T> {
  roots: readonly T[];
  getId: (node: T) => string;
  /** Children of a node; `undefined` or an empty array makes it a leaf. */
  getChildren: (node: T) => readonly T[] | undefined;
  /** Row content after the chevron: icon, label, badges... */
  renderNode: (node: T, info: TreeRowInfo) => JSX.Element;
  /** Ids of expanded nodes (controlled). Use `createExpanded()`. */
  expanded: ReadonlySet<string>;
  onExpandedChange: (next: Set<string>) => void;
  selectedId?: string | null;
  /** Row clicked or selected with the keyboard. */
  onSelect?: (node: T, id: string) => void;
  /** Double-click or Enter. Without it, Enter / double-click toggles folders. */
  onActivate?: (node: T, id: string) => void;
  onContextMenu?: (node: T, e: MouseEvent) => void;
  /** Row height in px (default 24 = `--dg-tree-row-height`). */
  rowHeight?: number;
  /** Indent per level in px (default 16). */
  indent?: number;
  /** Vertical indent guides (default true). */
  guides?: boolean;
  class?: string;
  ariaLabel?: string;
  apiRef?: (api: TreeApi) => void;
}

interface Flat<T> {
  node: T;
  id: string;
  depth: number;
  hasChildren: boolean;
  parent: number;
}

/**
 * Generic virtualized tree: expand/collapse, keyboard (Up/Down/Home/End/PageUp/PageDown, Left collapses or
 * goes to the parent, Right expands or goes to the first child, Enter activates), indent guides.
 *
 *   const [expanded, ex] = createExpanded(["root"]);
 *   <Tree roots={repos()} getId={(r) => r.id} getChildren={(r) => r.children}
 *     expanded={expanded()} onExpandedChange={ex.set} selectedId={sel()} onSelect={(_, id) => setSel(id)}
 *     renderNode={(r, info) => <><Icon name="repo" /> <span>{r.name}</span></>} />
 */
export function Tree<T>(props: TreeProps<T>): JSX.Element {
  const rowH = () => props.rowHeight ?? 24;
  const indent = () => props.indent ?? 16;
  let listApi: VirtualListApi | undefined;

  const flat = createMemo<Flat<T>[]>(() => {
    const out: Flat<T>[] = [];
    const walk = (nodes: readonly T[], depth: number, parent: number) => {
      for (const node of nodes) {
        const id = props.getId(node);
        const kids = props.getChildren(node);
        const hasChildren = !!kids && kids.length > 0;
        const idx = out.length;
        out.push({ node, id, depth, hasChildren, parent });
        if (hasChildren && props.expanded.has(id)) walk(kids as readonly T[], depth + 1, idx);
      }
    };
    walk(props.roots, 0, -1);
    return out;
  });

  const indexOfSelected = () => {
    const id = props.selectedId;
    return id == null ? -1 : flat().findIndex((f) => f.id === id);
  };

  const setExpanded = (id: string, on: boolean) => {
    const next = new Set(props.expanded);
    if (on) next.add(id);
    else next.delete(id);
    props.onExpandedChange(next);
  };

  const selectAt = (i: number) => {
    const f = flat()[i];
    if (f) props.onSelect?.(f.node, f.id);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const i = indexOfSelected();
    const f = i >= 0 ? flat()[i] : undefined;
    if (!f) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      if (f.hasChildren && !props.expanded.has(f.id)) setExpanded(f.id, true);
      else if (f.hasChildren) {
        selectAt(i + 1);
        listApi?.scrollToIndex(i + 1);
      }
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (f.hasChildren && props.expanded.has(f.id)) setExpanded(f.id, false);
      else if (f.parent >= 0) {
        selectAt(f.parent);
        listApi?.scrollToIndex(f.parent);
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (props.onActivate) props.onActivate(f.node, f.id);
      else if (f.hasChildren) setExpanded(f.id, !props.expanded.has(f.id));
    }
  };

  return (
    <VirtualList
      class={"dg-tree" + (props.class ? " " + props.class : "")}
      role="tree"
      ariaLabel={props.ariaLabel}
      count={flat().length}
      rowHeight={rowH()}
      selectedIndex={indexOfSelected()}
      onSelect={selectAt}
      onKeyDown={onKeyDown}
      apiRef={(api) => {
        listApi = api;
        props.apiRef?.({
          focus: api.focus,
          scrollToId: (id, align) => {
            const i = flat().findIndex((x) => x.id === id);
            if (i >= 0) api.scrollToIndex(i, align);
          },
        });
      }}
      renderRow={(i) => {
        const f = () => flat()[i];
        return (
          <Show when={f()}>
            {(row) => {
              const selected = () => props.selectedId === row().id;
              const isExpanded = () => props.expanded.has(row().id);
              const toggle = () => row().hasChildren && setExpanded(row().id, !isExpanded());
              return (
                <div
                  class="dg-tree-row"
                  classList={{ "is-selected": selected() }}
                  role="treeitem"
                  aria-level={row().depth + 1}
                  aria-expanded={row().hasChildren ? isExpanded() : undefined}
                  aria-selected={selected()}
                  style={{ "padding-left": 4 + row().depth * indent() + "px" }}
                  onClick={() => props.onSelect?.(row().node, row().id)}
                  onDblClick={() => (props.onActivate ? props.onActivate(row().node, row().id) : toggle())}
                  onContextMenu={(e) => props.onContextMenu?.(row().node, e)}
                >
                  <Show when={(props.guides ?? true) && row().depth > 0}>
                    <For each={Array.from({ length: row().depth }, (_, k) => k)}>
                      {(k) => <i class="dg-tree-guide" style={{ left: 4 + k * indent() + 7 + "px" }} />}
                    </For>
                  </Show>
                  <Show when={row().hasChildren} fallback={<span class="dg-tree-spacer" />}>
                    <span
                      class="dg-tree-chev"
                      classList={{ "is-open": isExpanded() }}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle();
                      }}
                    >
                      <Icon name="chevronRight" size={14} />
                    </span>
                  </Show>
                  {props.renderNode(row().node, { depth: row().depth, expanded: isExpanded(), hasChildren: row().hasChildren, selected: selected(), toggle })}
                </div>
              );
            }}
          </Show>
        );
      }}
    />
  );
}

/** Controlled-state helper for `Tree`: `const [expanded, ex] = createExpanded(["a"])`. */
export function createExpanded(initial: Iterable<string> = []): [
  Accessor<Set<string>>,
  { set: (next: Set<string>) => void; toggle: (id: string) => void; expand: (id: string) => void; collapse: (id: string) => void; clear: () => void },
] {
  const [set, setSet] = createSignal(new Set<string>(initial));
  return [
    set,
    {
      set: (next) => setSet(new Set(next)),
      toggle: (id) => setSet((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id]))),
      expand: (id) => setSet((s) => new Set([...s, id])),
      collapse: (id) => setSet((s) => new Set([...s].filter((x) => x !== id))),
      clear: () => setSet(new Set()),
    },
  ];
}
