/**
 * Line breaks of CRLF files. The module uses only `@codemirror/state`, so tests can load it.
 */
import { EditorState, Transaction, type Annotation, type Extension } from "@codemirror/state";

/** Returns `text` with each LF and each CRLF changed to CRLF. A lone CR stays as it is. */
export function toCrlf(text: string): string {
  return text.replace(/\r?\n/g, "\r\n");
}

/** Keeps the annotations that the history and the input handling read. */
function keptAnnotations(tr: Transaction): Annotation<unknown>[] {
  const out: Annotation<unknown>[] = [];
  const userEvent = tr.annotation(Transaction.userEvent);
  if (userEvent !== undefined) out.push(Transaction.userEvent.of(userEvent));
  const addToHistory = tr.annotation(Transaction.addToHistory);
  if (addToHistory !== undefined) out.push(Transaction.addToHistory.of(addToHistory));
  return out;
}

/**
 * Transaction filter for CRLF documents. The editor splits lines only at CRLF. Text with a bare LF, such as a paste,
 * would then stay in one line. The filter rewrites the inserted text to CRLF. Other transactions pass unchanged.
 */
export const crlfInput: Extension = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;
  let rewrite = false;
  const edits: { from: number; to: number; insert: string }[] = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const raw = inserted.toString();
    if (raw.includes("\n")) rewrite = true;
    edits.push({ from: fromA, to: toA, insert: toCrlf(raw) });
  });
  if (!rewrite) return tr;
  // A line break counts as one position, whatever its characters. The selection does not move.
  return {
    changes: edits,
    selection: tr.selection,
    effects: tr.effects,
    scrollIntoView: tr.scrollIntoView,
    annotations: keptAnnotations(tr),
  };
});
