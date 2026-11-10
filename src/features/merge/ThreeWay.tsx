/**
 * The three-pane merge editor: Yours | Result | Theirs. The panes at the sides are read only; the Result is a real editor
 * that starts as the common ancestor. Bands between the panes join each change to its place in the Result, with the
 * apply (» «) and ignore (×) buttons. The behaviour (what a button does, which changes can be applied by themselves)
 * is `MergeModel`; this file is the view: editors, scroll sync, bands, toolbar, save.
 *
 * Keys: F7 / Alt+Down next change, Shift+F7 / Alt+Up previous, Alt+Right apply Yours to the current change,
 * Alt+Left apply Theirs, Ctrl+Enter save, Esc cancel.
 */
import { isolateHistory } from "@codemirror/commands";
import type { Transaction } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { For, type JSX, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import type { ConflictVersions } from "../../api/types";
import { Button, Icon, IconButton, plural, tip } from "../../components/ui";
import * as actions from "../../state/actions";
import { confirmAction, type MergeFileResult } from "../../state/dialogs";
import { languageFor } from "../diff/syntax";
import { MAX_WORD_LINE, MAX_WORD_RATIO, wordDiff } from "../diff/wordDiff";
import { LINE_HEIGHT, createPane, fromModel, minimalChange, modelState, refresh, type LineMark, type WordMark } from "./editor";
import { MergeModel, normalizeText, type LineEdit, type Side } from "./model";
import { expectedOids } from "./resolve";
import { COL, anchorsOf, mapLine, type Col } from "./scrollSync";

export interface ThreeWayProps {
  repoId: string;
  path: string;
  versions: ConflictVersions;
  /** Closes the window; `undefined` = cancelled. */
  done: (r?: MergeFileResult) => void;
}

type Pane = "l" | "c" | "r";
/** Column of each pane in the scroll anchors. */
const PANE_COL: Record<Pane, Col> = { c: COL.result, l: COL.left, r: COL.right };
const PANES: Pane[] = ["l", "c", "r"];

const NAME: Record<Side, string> = { left: "Yours", right: "Theirs" };

/** Label shown in a marker line: the branch, without the commit that follows it during a rebase. */
const markerLabel = (label: string): string => label.split(" (")[0];

const ARROW_PATH = { right: "m4 4 4 4-4 4M8 4l4 4-4 4", left: "m12 4-4 4 4 4M8 4 4 8l4 4", x: "m4.5 4.5 7 7M11.5 4.5l-7 7" } as const;

function ArrowIcon(props: { dir: keyof typeof ARROW_PATH }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d={ARROW_PATH[props.dir]} />
    </svg>
  );
}

export function ThreeWay(props: ThreeWayProps): JSX.Element {
  const v = props.versions;
  const text = (b: ConflictVersions["base"]) => normalizeText(b?.text ?? "", v.eol);
  const model = new MergeModel(text(v.base), text(v.ours), text(v.theirs));
  const lang = languageFor(props.path);
  const markers = { left: markerLabel(v.labels.ours), right: markerLabel(v.labels.theirs) };

  const [ver, setVer] = createSignal(0);
  const [geo, setGeo] = createSignal({ l: 0, c: 0, r: 0, h: 480 });
  const [active, setActive] = createSignal(-1);
  const [busy, setBusy] = createSignal(false);
  let dirty = false;

  const views: Partial<Record<Pane, EditorView>> = {};
  const els: Partial<Record<Pane, HTMLDivElement>> = {};

  const info = createMemo(() => {
    ver();
    const counts = model.counts();
    return {
      ...counts,
      total: model.chunks.length,
      left: model.hasNonConflicting("left"),
      right: model.hasNonConflicting("right"),
      all: model.hasNonConflicting("all"),
      magic: model.hasMagicResolvable(),
      current: active() >= 0 ? model.chunks[active()] : undefined,
    };
  });

  // ------------------------------------------------------------ chunk marks of the panes

  const sideMarks = (side: Side) => (): LineMark[] =>
    model.chunks.filter((c) => model.canApply(c, side)).map((c) => ({ start: c[side].start, end: c[side].end, cls: `dg-mg-${c.type}${c.index === active() ? " is-active" : ""}` }));
  const resultMarks = (): LineMark[] =>
    model.chunks.map((c) => ({
      start: c.start,
      end: c.end,
      cls: `dg-mg-${c.type}${model.isResolved(c) ? " is-resolved" : ""}${c.index === active() ? " is-active" : ""}`,
    }));

  /** Words a side changed in a change, against the common ancestor (computed once: the three versions never change). */
  const wordCache = new Map<string, WordMark[]>();
  const wordsOf = (index: number, side: Side): WordMark[] => {
    const key = `${index}${side}`;
    const hit = wordCache.get(key);
    if (hit) return hit;
    const c = model.chunks[index];
    const mine = (side === "left" ? model.leftLines : model.rightLines).slice(c[side].start, c[side].end);
    const base = model.baseLines.slice(c.base.start, c.base.end);
    const out: WordMark[] = [];
    if (mine.length > 0 && base.length > 0 && mine.length + base.length < 400 && ![...mine, ...base].some((l) => l.length > MAX_WORD_LINE)) {
      const r = wordDiff(base.join("\n"), mine.join("\n"));
      if (r.ratio <= MAX_WORD_RATIO) {
        // offsets of the joined text -> line and column
        const starts: number[] = [];
        let at = 0;
        for (const l of mine) {
          starts.push(at);
          at += l.length + 1;
        }
        const lineOf = (o: number) => {
          let i = starts.length - 1;
          while (i > 0 && starts[i] > o) i--;
          return i;
        };
        for (const span of r.b) {
          for (let o = span.start; o < span.end; ) {
            const i = lineOf(o);
            const end = Math.min(span.end, starts[i] + mine[i].length);
            if (end > o) out.push({ line: c[side].start + i, from: o - starts[i], to: end - starts[i] });
            o = Math.max(end, o) + 1; // skip the newline
          }
        }
      }
    }
    wordCache.set(key, out);
    return out;
  };
  const sideWords = (side: Side) => (): WordMark[] =>
    model.chunks.filter((c) => c.type !== "inserted" && model.canApply(c, side)).flatMap((c) => wordsOf(c.index, side));

  const refreshAll = () => {
    for (const p of PANES) views[p]?.dispatch({ effects: refresh.of(null) });
  };

  // ------------------------------------------------------------ geometry (scroll positions for the bands)

  let measureQueued = false;
  const measure = () => {
    if (measureQueued) return;
    measureQueued = true;
    requestAnimationFrame(() => {
      measureQueued = false;
      const c = views.c;
      if (!c) return;
      setGeo({ l: views.l?.scrollDOM.scrollTop ?? 0, c: c.scrollDOM.scrollTop, r: views.r?.scrollDOM.scrollTop ?? 0, h: c.scrollDOM.clientHeight || 480 });
    });
  };

  // ------------------------------------------------------------ scroll sync

  const expected: Partial<Record<Pane, { top: number; until: number }>> = {};
  const onScroll = (from: Pane) => {
    const view = views[from];
    if (!view) return;
    const top = view.scrollDOM.scrollTop;
    const exp = expected[from];
    if (exp && Math.abs(top - exp.top) < 1.5 && performance.now() < exp.until) {
      measure();
      return;
    }
    delete expected[from];
    const a = anchorsOf(model);
    const line = top / LINE_HEIGHT;
    for (const to of PANES) {
      const other = views[to];
      if (to === from || !other) continue;
      const el = other.scrollDOM;
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      const target = Math.max(0, Math.min(max, Math.round(mapLine(a, PANE_COL[from], PANE_COL[to], line) * LINE_HEIGHT)));
      if (Math.abs(el.scrollTop - target) < 1) continue;
      expected[to] = { top: target, until: performance.now() + 150 };
      el.scrollTop = target;
    }
    measure();
  };

  // ------------------------------------------------------------ model <-> Result editor

  /** The user (or undo) changed the Result text: the model follows. */
  const onResultTransactions = (trs: readonly Transaction[]) => {
    for (const tr of trs) {
      if (tr.annotation(fromModel)) continue;
      const restore = tr.effects.find((e) => e.is(modelState));
      if (restore) {
        model.restore(restore.value.after, tr.newDoc.toJSON());
        dirty = true;
        continue;
      }
      if (!tr.docChanged) continue;
      const doc = tr.startState.doc;
      const edits: LineEdit[] = [];
      tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        const first = doc.lineAt(fromA).number;
        const last = doc.lineAt(toA).number;
        edits.push({ oldLine1: first - 1, oldLine2: last, shift: inserted.lines - 1 - (last - first) });
      });
      model.documentEdits(edits.reverse(), tr.newDoc.toJSON());
      dirty = true;
    }
    queueMicrotask(() => setVer((n) => n + 1));
  };

  const chunkAtLine = (line: number): number => model.chunks.findIndex((c) => line >= c.start && (line < c.end || (c.start === c.end && line === c.start)));

  const onResultUpdate = (u: ViewUpdate) => {
    if (u.docChanged || u.geometryChanged) measure();
    if (u.selectionSet || u.docChanged) {
      const line = u.state.doc.lineAt(u.state.selection.main.head).number - 1;
      const i = chunkAtLine(line);
      if (i >= 0 && i !== active()) queueMicrotask(() => setActive(i));
    }
  };

  /** Runs a model action and shows its effect in the Result editor as one undo step. */
  const act = (fn: () => unknown) => {
    const view = views.c;
    if (!view) return;
    const before = model.snapshot();
    fn();
    const change = minimalChange(view.state.doc.toString(), model.resultText());
    view.dispatch({
      changes: change ?? undefined,
      effects: [modelState.of({ before, after: model.snapshot() })],
      annotations: [fromModel.of(true), isolateHistory.of("full")],
    });
    dirty = true;
    setVer((n) => n + 1);
    refreshAll();
    measure();
    // a toolbar button that just became disabled drops the focus: keep the keyboard in the editor
    view.focus();
  };

  createEffect(on(active, () => refreshAll(), { defer: true }));

  const apply = (index: number, side: Side, resolve = false) => act(() => model.applyChange(index, side, resolve));
  const ignore = (index: number, side: Side) => act(() => model.ignoreChange(index, side));

  // ------------------------------------------------------------ navigation

  const goTo = (index: number) => {
    const view = views.c;
    const c = model.chunks[index];
    if (!view || !c) return;
    setActive(index);
    view.scrollDOM.scrollTop = Math.max(0, (c.start - 3) * LINE_HEIGHT);
    const line = view.state.doc.line(Math.min(c.start + 1, view.state.doc.lines));
    view.dispatch({ selection: { anchor: line.from } });
    view.focus();
  };
  const step = (dir: 1 | -1) => {
    const i = model.nextUnresolved(active(), dir);
    if (i >= 0) goTo(i);
  };

  // ------------------------------------------------------------ toolbar actions

  const acceptAll = async (side: Side) => {
    if (dirty) {
      const ok = await confirmAction({
        title: `Accept ${NAME[side]}`,
        message: `Replace the Result with the ${NAME[side]} version? What you did in this window is lost.`,
        confirmLabel: `Accept ${NAME[side]}`,
        danger: true,
      });
      if (!ok) return;
    }
    act(() => model.acceptAll(side));
  };

  const reset = async () => {
    if (dirty) {
      const ok = await confirmAction({
        title: "Reset the Result",
        message: "Go back to the common ancestor with every change open? What you did in this window is lost.",
        confirmLabel: "Reset",
        danger: true,
      });
      if (!ok) return;
    }
    act(() => model.reset());
  };

  const cancel = async () => {
    if (busy()) return;
    if (dirty) {
      const ok = await confirmAction({
        title: "Discard the merge result",
        message: `Close the merge of ${props.path} without saving? What you did in this window is lost.`,
        confirmLabel: "Discard",
        cancelLabel: "Keep editing",
        danger: true,
      });
      if (!ok) return;
    }
    props.done();
  };

  /** Apply: saves the Result. Conflicts that are still open make a file with conflict markers that stays unmerged. */
  const save = async () => {
    if (busy()) return;
    // Changes that only one side made are part of every merge; the ones the user did not ignore are applied now.
    if (model.counts().changes > 0) act(() => model.applyNonConflicting("all"));
    const open = model.counts().conflicts;
    if (open > 0) {
      const ok = await confirmAction({
        title: "Save with unresolved conflicts?",
        message: [
          `${plural(open, "conflict")} ${open === 1 ? "is" : "are"} not resolved in ${props.path}.`,
          "The file is saved with conflict markers (<<<<<<<, =======, >>>>>>>) and stays in the list of conflicts. It is not staged.",
        ],
        confirmLabel: "Save with markers",
        cancelLabel: "Keep editing",
      });
      if (!ok) return;
    }
    setBusy(true);
    const content = open > 0 ? model.resultWithMarkers(markers) : model.resultText();
    const res = await actions.saveResolution(props.repoId, props.path, content, expectedOids(v), open === 0);
    setBusy(false);
    if (res.ok.length > 0) props.done({ resolved: open === 0 });
  };

  // ------------------------------------------------------------ keyboard

  const onKey = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      void cancel();
    } else if (e.key === "F7" || (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp"))) {
      e.preventDefault();
      step(e.key === "ArrowUp" || (e.key === "F7" && e.shiftKey) ? -1 : 1);
    } else if (e.altKey && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      const c = info().current;
      if (!c) return;
      const side: Side = e.key === "ArrowRight" ? "left" : "right";
      if (model.canApply(c, side)) {
        e.preventDefault();
        apply(c.index, side, e.shiftKey);
      }
    } else if (mod && e.key === "Enter") {
      e.preventDefault();
      void save();
    }
  };

  // ------------------------------------------------------------ mount

  onMount(() => {
    const mk = (pane: Pane, o: Parameters<typeof createPane>[1]) => {
      const view = createPane(els[pane] as HTMLDivElement, o);
      view.scrollDOM.addEventListener("scroll", () => onScroll(pane), { passive: true });
      views[pane] = view;
    };
    mk("l", { doc: model.leftLines.join("\n"), label: `Yours: ${props.path}`, readOnly: true, lang, marks: sideMarks("left"), words: sideWords("left") });
    mk("r", { doc: model.rightLines.join("\n"), label: `Theirs: ${props.path}`, readOnly: true, lang, marks: sideMarks("right"), words: sideWords("right") });
    mk("c", { doc: model.resultText(), label: `Result: ${props.path}`, readOnly: false, lang, marks: resultMarks, onTransactions: onResultTransactions, onUpdate: onResultUpdate });
    const ro = new ResizeObserver(measure);
    ro.observe(els.c as HTMLDivElement);
    onCleanup(() => ro.disconnect());
    measure();
    const first = model.nextUnresolved(-1);
    if (first >= 0) queueMicrotask(() => goTo(first));
    else views.c?.focus();
  });
  onCleanup(() => PANES.forEach((p) => views[p]?.destroy()));

  // ------------------------------------------------------------ bands and buttons in the gutters

  const GUTTER = 52;
  interface Band {
    key: string;
    side: Side;
    index: number;
    type: string;
    /** Y of the chunk's top and bottom in the side pane and in the Result. */
    s0: number;
    s1: number;
    c0: number;
    c1: number;
    active: boolean;
    /** Y of the top of the buttons. */
    btn: number;
    /** The conflict has the other side applied already: this side's button appends. */
    append: boolean;
  }

  const bands = createMemo<Band[]>(() => {
    ver();
    active();
    const g = geo();
    const out: Band[] = [];
    const y = (line: number, top: number) => line * LINE_HEIGHT - top;
    for (const c of model.chunks) {
      for (const side of ["left", "right"] as Side[]) {
        if (!model.canApply(c, side)) continue;
        const top = side === "left" ? g.l : g.r;
        const s0 = y(c[side].start, top);
        const s1 = y(c[side].end, top);
        const c0 = y(c.start, g.c);
        const c1 = y(c.end, g.c);
        if (Math.max(s1, c1) < -LINE_HEIGHT || Math.min(s0, c0) > g.h + LINE_HEIGHT) continue;
        const btn = s1 - s0 <= LINE_HEIGHT ? (s0 + s1) / 2 - LINE_HEIGHT / 2 : Math.min(Math.max(s0, 0), s1 - LINE_HEIGHT);
        out.push({ key: `${c.index}${side}`, side, index: c.index, type: c.type, s0, s1, c0, c1, active: c.index === active(), btn, append: c.onesideApplied });
      }
    }
    return out;
  });

  const path = (b: Band): string => {
    // left gutter: side pane on the left edge, Result on the right edge; right gutter: the other way round
    const [x0, y0a, y0b, x1, y1a, y1b] = b.side === "left" ? [0, b.s0, b.s1, GUTTER, b.c0, b.c1] : [GUTTER, b.s0, b.s1, 0, b.c0, b.c1];
    const mid = x0 + (x1 - x0) / 2;
    return `M${x0} ${y0a} C${mid} ${y0a} ${mid} ${y1a} ${x1} ${y1a} L${x1} ${y1b} C${mid} ${y1b} ${mid} ${y0b} ${x0} ${y0b} Z`;
  };
  const edge = (b: Band, which: "top" | "bottom"): string => {
    const [x0, x1] = b.side === "left" ? [0, GUTTER] : [GUTTER, 0];
    const [ya, yb] = which === "top" ? [b.s0, b.c0] : [b.s1, b.c1];
    const mid = x0 + (x1 - x0) / 2;
    return `M${x0} ${ya} C${mid} ${ya} ${mid} ${yb} ${x1} ${yb}`;
  };

  const sideBands = (side: Side) => createMemo(() => bands().filter((b) => b.side === side));
  const leftBands = sideBands("left");
  const rightBands = sideBands("right");

  const Gutter = (gp: { side: Side; list: () => Band[] }): JSX.Element => (
    <div class="dg-mg-gutter" classList={{ "is-left": gp.side === "left", "is-right": gp.side === "right" }}>
      <svg width={GUTTER} height={geo().h} aria-hidden="true">
        <For each={gp.list()}>
          {(b) => (
            <g class={`dg-mg-band dg-mg-${b.type}`} classList={{ "is-active": b.active }}>
              <path class="dg-mg-band-fill" d={path(b)} />
              <path class="dg-mg-band-edge" d={edge(b, "top")} />
              <path class="dg-mg-band-edge" d={edge(b, "bottom")} />
            </g>
          )}
        </For>
      </svg>
      <For each={gp.list()}>
        {(b) => {
          const who = NAME[b.side];
          const applyLabel = b.append ? `Append ${who} after the other side` : `Apply ${who}`;
          const applyBtn = (
            <button
              type="button"
              class="dg-mg-gbtn"
              tabIndex={-1}
              aria-label={`${applyLabel}, change ${b.index + 1}`}
              {...tip(`${applyLabel}. Shift+click: apply it and close the change`, b.side === "left" ? "Alt+Right" : "Alt+Left")}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => apply(b.index, b.side, e.shiftKey)}
            >
              <ArrowIcon dir={b.side === "left" ? "right" : "left"} />
            </button>
          );
          const ignoreBtn = (
            <button
              type="button"
              class="dg-mg-gbtn is-ignore"
              tabIndex={-1}
              aria-label={`Ignore ${who}, change ${b.index + 1}`}
              {...tip(`Ignore ${who}: keep the Result as it is`)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => ignore(b.index, b.side)}
            >
              <ArrowIcon dir="x" />
            </button>
          );
          return (
            <div class={`dg-mg-gbtns dg-mg-${b.type}`} classList={{ "is-active": b.active }} style={{ top: `${b.btn}px` }}>
              {b.side === "left" ? (
                <>
                  {applyBtn}
                  {ignoreBtn}
                </>
              ) : (
                <>
                  {ignoreBtn}
                  {applyBtn}
                </>
              )}
            </div>
          );
        }}
      </For>
    </div>
  );

  // ------------------------------------------------------------ render

  const status = () => {
    const i = info();
    if (i.conflicts > 0) return `${plural(i.conflicts, "conflict")} left${i.changes > 0 ? ` · ${plural(i.changes, "change")}` : ""}`;
    if (i.changes > 0) return `${plural(i.changes, "change")} left`;
    return i.total === 0 ? "No differences" : "All changes processed";
  };

  return (
    <div class="dg-mg-body" onKeyDown={onKey}>
      <div class="dg-mg-toolbar" role="toolbar" aria-label="Merge tools">
        <span class="dg-mg-tgroup" role="group" aria-label="Apply non-conflicting changes">
          <span class="dg-mg-tlabel">Apply non-conflicting</span>
          <Button size="small" disabled={!info().left} title="Apply the changes that only Yours made" onClick={() => act(() => model.applyNonConflicting("left"))}>Yours</Button>
          <Button size="small" disabled={!info().all} title="Apply every change that only one side made" onClick={() => act(() => model.applyNonConflicting("all"))}>All</Button>
          <Button size="small" disabled={!info().right} title="Apply the changes that only Theirs made" onClick={() => act(() => model.applyNonConflicting("right"))}>Theirs</Button>
        </span>
        <span class="dg-mg-vsep" />
        <Button size="small" icon="refresh" disabled={!info().magic} title="Merge the conflicts where the two sides changed different words" onClick={() => act(() => model.magicResolveAll())}>
          Magic resolve
        </Button>
        <span class="dg-mg-vsep" />
        <IconButton icon="arrowUp" label="Previous change" shortcut="Shift+F7" size="large" disabled={info().conflicts + info().changes === 0} onClick={() => step(-1)} />
        <IconButton icon="arrowDown" label="Next change" shortcut="F7" size="large" disabled={info().conflicts + info().changes === 0} onClick={() => step(1)} />
        <span class="dg-mg-status" classList={{ "has-conflicts": info().conflicts > 0, "is-done": info().conflicts + info().changes === 0 }} role="status" aria-live="polite">
          <Icon name={info().conflicts + info().changes === 0 ? "check" : "conflict"} size={14} />
          {status()}
        </span>
        <span class="dg-grow" />
        <Button size="small" title="Replace the Result with the Yours version" onClick={() => void acceptAll("left")}>Accept Yours</Button>
        <Button size="small" title="Replace the Result with the Theirs version" onClick={() => void acceptAll("right")}>Accept Theirs</Button>
        <Button size="small" variant="ghost" icon="undo" title="Back to the common ancestor, every change open" onClick={() => void reset()}>Reset</Button>
      </div>

      <div class="dg-mg-heads">
        <div class="dg-mg-head is-side">
          <b>Yours</b>
          <span class="dg-mg-head-label" title={v.labels.ours}>{v.labels.ours}</span>
          <Show when={v.swapped}>
            <span class="dg-mg-chip" {...tip("During a rebase Yours is your commit that is being replayed, and Theirs is the branch you rebase onto.")}>your commit</span>
          </Show>
        </div>
        <div class="dg-mg-head-gap" />
        <div class="dg-mg-head is-result">
          <b>Result</b>
          <span class="dg-mg-head-label" title={props.path}>{props.path}</span>
          <Show when={v.eol === "crlf"}>
            <span class="dg-mg-chip" {...tip("The file uses CRLF line endings. It is saved the same way.")}>CRLF</span>
          </Show>
        </div>
        <div class="dg-mg-head-gap" />
        <div class="dg-mg-head is-side">
          <b>Theirs</b>
          <span class="dg-mg-head-label" title={v.labels.theirs}>{v.labels.theirs}</span>
          <Show when={v.swapped}>
            <span class="dg-mg-chip" {...tip("The branch the rebase puts your commits onto.")}>upstream</span>
          </Show>
        </div>
      </div>

      <div class="dg-mg-panes">
        <div class="dg-mg-pane" ref={(el) => (els.l = el)} />
        <Gutter side="left" list={leftBands} />
        <div class="dg-mg-pane is-result" ref={(el) => (els.c = el)} />
        <Gutter side="right" list={rightBands} />
        <div class="dg-mg-pane" ref={(el) => (els.r = el)} />
      </div>

      <div class="dg-mg-footer">
        <span class="dg-mg-hint">F7 next change · Alt+Right apply Yours · Alt+Left apply Theirs · Ctrl+Enter apply</span>
        <span class="dg-grow" />
        <Button onClick={() => void cancel()}>Cancel</Button>
        <Button variant="primary" disabled={busy()} onClick={() => void save()}>
          {info().conflicts > 0 ? "Apply with conflicts…" : "Apply"}
        </Button>
      </div>
    </div>
  );
}
