/**
 * CodeMirror 6 glue of the merge window (no Solid): one editor per pane, chunk highlighting by line classes,
 * light syntax colouring, and the undo link between the Result editor and the merge model.
 *
 * Only `@codemirror/state`, `@codemirror/view` and `@codemirror/commands` are used (the lazy chunk of this window is about
 * 290 kB minified, 96 kB gzip); no language packages: the colours come from `features/diff/syntax.ts`.
 */
import { defaultKeymap, history, historyKeymap, invertedEffects } from "@codemirror/commands";
import { Annotation, EditorState, StateEffect, type Extension, type Transaction } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, keymap, lineNumbers } from "@codemirror/view";
import { tokenize, type Lang } from "../diff/syntax";
import type { Snapshot } from "./model";

/** Height of a line in px (`--dg-line-height-code`); every pane uses it, so scroll positions map to lines. */
export const LINE_HEIGHT = 20;

/** A run of lines (0-based, half-open) that gets a CSS class. An empty run marks the edge between two lines. */
export interface LineMark {
  start: number;
  end: number;
  /** Class of every line of the run (and of the edge, for an empty run). */
  cls: string;
}

/** Marks a transaction that the merge model made itself (the model is already up to date). */
export const fromModel = Annotation.define<boolean>();

/** Carries the model state before and after an action, so the editor's undo history can restore it. */
export interface ModelStates {
  before: Snapshot;
  after: Snapshot;
}
export const modelState = StateEffect.define<ModelStates>();
/** Asks every plugin to rebuild its decorations (the chunk state changed, the text did not). */
export const refresh = StateEffect.define<null>();

function marksPlugin(getMarks: () => readonly LineMark[]): Extension {
  const build = (view: EditorView): DecorationSet => {
    const doc = view.state.doc;
    const first = doc.lineAt(view.viewport.from).number - 1;
    const last = doc.lineAt(view.viewport.to).number; // exclusive, 0-based
    // several marks can hit one line (an edge of one chunk and the first line of the next): their classes are joined
    const byLine = new Map<number, string[]>();
    const add = (line: number, cls: string) => byLine.set(line, [...(byLine.get(line) ?? []), cls]);
    for (const m of getMarks()) {
      if (m.end < first - 1 || m.start > last + 1) continue;
      if (m.start === m.end) {
        // an empty run: the line below the edge carries the marker (the last line carries it at the end of the text)
        if (m.start < doc.lines) add(m.start + 1, `${m.cls} is-edge-top`);
        else if (doc.lines > 0) add(doc.lines, `${m.cls} is-edge-bottom`);
        continue;
      }
      for (let l = Math.max(m.start, first); l < Math.min(m.end, last, doc.lines); l++) {
        add(l + 1, m.cls + (l === m.start ? " is-first" : "") + (l === m.end - 1 ? " is-last" : ""));
      }
    }
    return Decoration.set(
      [...byLine.entries()].sort((a, b) => a[0] - b[0]).map(([n, cls]) => Decoration.line({ class: cls.join(" ") }).range(doc.line(n).from)),
    );
  };
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate) {
        this.decorations = build(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/** A changed word inside a line: 0-based line, columns `[from, to)`. */
export interface WordMark {
  line: number;
  from: number;
  to: number;
}

function wordsPlugin(getWords: () => readonly WordMark[]): Extension {
  const build = (view: EditorView): DecorationSet => {
    const doc = view.state.doc;
    const first = doc.lineAt(view.viewport.from).number - 1;
    const last = doc.lineAt(view.viewport.to).number;
    const marks: ReturnType<ReturnType<typeof Decoration.mark>["range"]>[] = [];
    for (const w of getWords()) {
      if (w.line < first || w.line >= last || w.line >= doc.lines) continue;
      const line = doc.line(w.line + 1);
      const to = Math.min(w.to, line.length);
      if (w.from < to) marks.push(Decoration.mark({ class: "dg-mg-w" }).range(line.from + w.from, line.from + to));
    }
    return Decoration.set(marks, true);
  };
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate) {
        this.decorations = build(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/** Colours the tokens of `lang` with `dg-mg-t-*` classes. The Files editor uses it too. */
export function syntaxPlugin(lang: Lang | null): Extension {
  if (!lang) return [];
  const build = (view: EditorView): DecorationSet => {
    const doc = view.state.doc;
    const marks: ReturnType<ReturnType<typeof Decoration.mark>["range"]>[] = [];
    const first = doc.lineAt(view.viewport.from).number;
    const last = doc.lineAt(view.viewport.to).number;
    for (let n = first; n <= last; n++) {
      const line = doc.line(n);
      for (const t of tokenize(lang, line.text)) marks.push(Decoration.mark({ class: `dg-mg-t-${t.kind}` }).range(line.from + t.start, line.from + t.end));
    }
    return Decoration.set(marks, true);
  };
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) this.decorations = build(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

export interface PaneOptions {
  doc: string;
  label: string;
  readOnly: boolean;
  lang: Lang | null;
  marks: () => readonly LineMark[];
  /** Changed words inside the marked lines (optional). */
  words?: () => readonly WordMark[];
  /** Called for every batch of transactions before the view updates (the Result pane feeds the model here). */
  onTransactions?: (trs: readonly Transaction[], view: EditorView) => void;
  /** Called after every update (selection moved, document changed). */
  onUpdate?: (u: ViewUpdate) => void;
}

/**
 * CodeMirror binds Alt+Up / Alt+Down (move line), Alt+Left / Alt+Right (syntax moves) and Ctrl+Enter (blank line): the merge window
 * uses them for its own commands (next change, apply a side, save).
 */
const keys = defaultKeymap.filter(
  (b) => !/^(Shift-)?Alt-Arrow(Up|Down|Left|Right)$/.test(b.key ?? "") && !/^Ctrl-Arrow(Left|Right)$/.test(b.mac ?? "") && b.key !== "Mod-Enter",
);

/** One pane: an editor with line numbers, no wrapping, the chunk marks and the syntax colours. */
export function createPane(parent: HTMLElement, o: PaneOptions): EditorView {
  const extensions: Extension[] = [
    lineNumbers(),
    EditorState.lineSeparator.of("\n"),
    EditorView.contentAttributes.of({ "aria-label": o.label, spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
    marksPlugin(o.marks),
    o.words ? wordsPlugin(o.words) : [],
    syntaxPlugin(o.lang),
    EditorView.updateListener.of((u) => o.onUpdate?.(u)),
  ];
  if (o.readOnly) extensions.push(EditorState.readOnly.of(true), keymap.of(keys.filter((b) => !/^(Mod|Ctrl)-[xX]$/.test(b.key ?? ""))));
  else {
    extensions.push(
      history(),
      keymap.of([...historyKeymap, ...keys]),
      // undo / redo of a model action also restores the chunk state: the inverse of "before -> after" is "after -> before"
      invertedEffects.of((tr) => tr.effects.filter((e) => e.is(modelState)).map((e) => modelState.of({ before: e.value.after, after: e.value.before }))),
    );
  }
  return new EditorView({
    parent,
    state: EditorState.create({ doc: o.doc, extensions }),
    dispatchTransactions: (trs, view) => {
      o.onTransactions?.(trs, view);
      view.update(trs);
    },
  });
}

/** Replaces the text of a pane by `text` with the smallest change (keeps the caret and the scroll where they can stay). */
export function minimalChange(oldText: string, newText: string): { from: number; to: number; insert: string } | null {
  if (oldText === newText) return null;
  let from = 0;
  const max = Math.min(oldText.length, newText.length);
  while (from < max && oldText.charCodeAt(from) === newText.charCodeAt(from)) from++;
  let endOld = oldText.length;
  let endNew = newText.length;
  while (endOld > from && endNew > from && oldText.charCodeAt(endOld - 1) === newText.charCodeAt(endNew - 1)) {
    endOld--;
    endNew--;
  }
  return { from, to: endOld, insert: newText.slice(from, endNew) };
}
