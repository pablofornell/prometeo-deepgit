/**
 * CodeMirror 6 state of one open file. It does not use Solid.
 * Each open tab keeps its own `EditorState`. So each tab keeps its undo history, cursor and selection.
 * The view swaps the states with `view.setState()`.
 *
 * The module uses `@codemirror/state`, `@codemirror/view`, `@codemirror/commands` and `@codemirror/search`.
 * The find and replace widget is in `find/panel.tsx`.
 * The syntax colours come from `features/merge/editor.ts` (`syntaxPlugin`) and `features/diff/syntax.ts`.
 */
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView, type ViewUpdate, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { languageFor } from "../diff/syntax";
import { syntaxPlugin } from "../merge/editor";
import { findExtension, findKeymap } from "./find/panel";
import { crlfInput } from "./lineEnds";
import { lineSeparatorOf } from "./model";

/**
 * Creates the state for the text `doc` of the file `path`. The cursor starts at the start of `line`.
 * `line` is 1-based and the function clamps it to the document. `onUpdate` runs after each transaction of this state.
 */
export function createFileState(doc: string, path: string, onUpdate: (u: ViewUpdate) => void, line = 1): EditorState {
  const extensions: Extension[] = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    drawSelection(),
    history(),
    findExtension(),
    highlightSelectionMatches(),
    keymap.of([...findKeymap, ...searchKeymap.filter((k) => !["Mod-f", "F3", "Mod-g", "Escape"].includes(k.key ?? "")), ...defaultKeymap, ...historyKeymap, indentWithTab]),
    syntaxPlugin(languageFor(path)),
    EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
    EditorView.updateListener.of(onUpdate),
  ];
  // The CRLF facet keeps the line breaks of the file. `sliceDoc()` then writes them back as they were.
  // The filter turns LF text (a paste) into CRLF, so that it splits into lines and saves with CRLF.
  if (lineSeparatorOf(doc) === "\r\n") extensions.push(EditorState.lineSeparator.of("\r\n"), crlfInput);
  const state = EditorState.create({ doc, extensions });
  const n = Math.min(Math.max(1, line), state.doc.lines);
  return state.update({ selection: EditorSelection.cursor(state.doc.line(n).from) }).state;
}

/** Returns the text to write to disk. It is the whole document, with its line separators. */
export function saveText(state: EditorState): string {
  return state.sliceDoc();
}
