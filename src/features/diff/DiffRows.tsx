/** Row renderers of the diff viewer: code with syntax and word highlights, side-by-side halves, unified rows. */
import { For, type JSX, Show, createMemo } from "solid-js";
import { Icon } from "../../components/ui";
import { cellWords, type Cell, type SbsRow, type UniRow } from "./diffModel";
import { segmentsOf, tokenize, type Lang } from "./syntax";

export interface HunkActions {
  stage?: (hunk: number) => void;
  unstage?: (hunk: number) => void;
  discard?: (hunk: number) => void;
}

/** Everything a row needs from the viewer. */
export interface RowCtx {
  lang: () => Lang | null;
  syntax: () => boolean;
  words: () => boolean;
  /** Index of the focused change (-1 = none). */
  active: () => number;
  actions: () => HunkActions;
  /** True while the whole-file diff is loading (a fold was clicked). */
  expanding: () => boolean;
  onFold: (id: string) => void;
}

export function Code(props: { cell: Cell; ctx: RowCtx }): JSX.Element {
  const segs = createMemo(() => {
    const c = props.cell;
    const lang = props.ctx.lang();
    const tokens = lang && props.ctx.syntax() ? tokenize(lang, c.text) : [];
    const spans = props.ctx.words() ? cellWords(c) : [];
    return segmentsOf(c.text, tokens, spans);
  });
  return (
    <For each={segs()}>
      {(s) =>
        s.kind || s.word ? <span class={(s.kind ? "dg-diff-t-" + s.kind : "") + (s.word ? " dg-diff-w" : "")}>{s.text}</span> : s.text
      }
    </For>
  );
}

function HunkButtons(props: { hunk: number; ctx: RowCtx }): JSX.Element {
  const a = () => props.ctx.actions();
  return (
    <span class="dg-diff-hunk-actions">
      <Show when={a().stage}>
        {(f) => (
          <button type="button" class="dg-diff-hbtn" title="Stage this hunk" onClick={() => f()(props.hunk)}>
            <Icon name="plus" size={12} />
            Stage
          </button>
        )}
      </Show>
      <Show when={a().unstage}>
        {(f) => (
          <button type="button" class="dg-diff-hbtn" title="Unstage this hunk" onClick={() => f()(props.hunk)}>
            <Icon name="minus" size={12} />
            Unstage
          </button>
        )}
      </Show>
      <Show when={a().discard}>
        {(f) => (
          <button type="button" class="dg-diff-hbtn is-danger" title="Discard this hunk" onClick={() => f()(props.hunk)}>
            <Icon name="undo" size={12} />
            Discard
          </button>
        )}
      </Show>
    </span>
  );
}

function foldLabel(count: number | null, expanding: boolean): string {
  if (expanding) return "Loading hidden lines…";
  if (count === null) return "Show hidden lines";
  return `Show ${count} hidden ${count === 1 ? "line" : "lines"}`;
}

function Fold(props: { id: string; count: number | null; ctx: RowCtx; label: boolean }): JSX.Element {
  return (
    <div class="dg-diff-row dg-diff-fold" onClick={() => props.ctx.onFold(props.id)} role="button" aria-label={foldLabel(props.count, false)}>
      <span class="dg-diff-ln" />
      <span class="dg-diff-code">
        <Show when={props.label}>
          <Icon name="expand" size={12} />
          {foldLabel(props.count, props.ctx.expanding())}
        </Show>
      </span>
    </div>
  );
}

/** One half (left = old, right = new) of a side-by-side row. */
export function SbsHalf(props: { row: SbsRow; side: "l" | "r"; ctx: RowCtx }): JSX.Element {
  const row = props.row;
  if (row.t === "fold") return <Fold id={row.id} count={row.count} ctx={props.ctx} label={props.side === "l"} />;
  if (row.t === "hunk") {
    return (
      <div class="dg-diff-row dg-diff-hunk">
        <span class="dg-diff-ln" />
        <span class="dg-diff-code">
          <Show when={props.side === "l"}>{row.label}</Show>
          <Show when={props.side === "r"}>
            <HunkButtons hunk={row.hunk} ctx={props.ctx} />
          </Show>
        </span>
      </div>
    );
  }
  const cell = props.side === "l" ? row.l : row.r;
  const no = () => (props.side === "l" ? cell?.oldNo : cell?.newNo);
  return (
    <div
      class="dg-diff-row"
      classList={{
        "is-add": cell?.kind === "add",
        "is-del": cell?.kind === "del",
        "is-fill": !cell,
        "is-focus": props.side === "l" && row.change >= 0 && row.change === props.ctx.active(),
      }}
    >
      <span class="dg-diff-ln">{no() ?? ""}</span>
      <span class="dg-diff-code">
        {cell ? <Code cell={cell} ctx={props.ctx} /> : null}
        <Show when={cell && row.ws}>
          <span class="dg-diff-wsmark">whitespace only</span>
        </Show>
      </span>
    </div>
  );
}

/** A row of the unified layout. */
export function UnifiedRow(props: { row: UniRow; ctx: RowCtx }): JSX.Element {
  const row = props.row;
  if (row.t === "fold") return <Fold id={row.id} count={row.count} ctx={props.ctx} label />;
  if (row.t === "hunk") {
    return (
      <div class="dg-diff-row dg-diff-row-uni dg-diff-hunk">
        <span class="dg-diff-ln" />
        <span class="dg-diff-ln dg-diff-ln-new" />
        <span class="dg-diff-mark" />
        <span class="dg-diff-code">
          {row.label}
          <HunkButtons hunk={row.hunk} ctx={props.ctx} />
        </span>
      </div>
    );
  }
  const c = row.c;
  return (
    <div
      class="dg-diff-row dg-diff-row-uni"
      classList={{ "is-add": c.kind === "add", "is-del": c.kind === "del", "is-focus": row.change >= 0 && row.change === props.ctx.active() }}
    >
      <span class="dg-diff-ln">{c.oldNo ?? ""}</span>
      <span class="dg-diff-ln dg-diff-ln-new">{c.newNo ?? ""}</span>
      <span class="dg-diff-mark">{c.kind === "add" ? "+" : c.kind === "del" ? "−" : ""}</span>
      <span class="dg-diff-code">
        <Code cell={c} ctx={props.ctx} />
        <Show when={row.ws}>
          <span class="dg-diff-wsmark">whitespace only</span>
        </Show>
      </span>
    </div>
  );
}
