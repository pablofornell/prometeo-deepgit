/**
 * The webview's own context menu never shows (it offers "Reload", "Inspect"... which mean nothing in an app).
 * `installContextMenuGuard()` (called once by `App`) listens on the window, in the bubbling phase, so the component
 * handlers (`openContextMenu`) run first:
 *
 *   - a right click that a component handled (it called `preventDefault`) is left alone;
 *   - on an editable target (text input, textarea, contenteditable, CodeMirror) it opens a small menu:
 *     Cut, Copy, Paste, Select All;
 *   - anywhere else it is only cancelled.
 */
import { EditorView } from "@codemirror/view";
import { type EditActions, type EditState, editMenuItems } from "./editMenu";
import { openContextMenu } from "./Menu";

/** `<input>` types that hold text (the others are buttons, checkboxes, colours...). */
const TEXT_INPUTS = new Set(["", "text", "search", "url", "tel", "email", "password", "number"]);

type Field =
  | { kind: "input"; el: HTMLInputElement | HTMLTextAreaElement }
  | { kind: "cm"; view: EditorView; el: HTMLElement }
  | { kind: "editable"; el: HTMLElement };

/** The editable field a right click at `target` landed on, or null. */
function fieldAt(target: EventTarget | null): Field | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest<HTMLElement>("input, textarea, [contenteditable], .cm-content");
  if (!el) return null;
  if (el instanceof HTMLInputElement) return TEXT_INPUTS.has(el.type) && !el.disabled ? { kind: "input", el } : null;
  if (el instanceof HTMLTextAreaElement) return el.disabled ? null : { kind: "input", el };
  const cm = el.classList.contains("cm-content") ? el : el.closest<HTMLElement>(".cm-content");
  if (cm) {
    const view = EditorView.findFromDOM(cm);
    return view ? { kind: "cm", view, el: cm } : null;
  }
  return el.isContentEditable ? { kind: "editable", el } : null;
}

function stateOf(f: Field): EditState {
  switch (f.kind) {
    case "input":
      return {
        hasSelection: f.el.selectionStart !== f.el.selectionEnd,
        readOnly: f.el.readOnly,
        noCopy: f.el instanceof HTMLInputElement && f.el.type === "password",
      };
    case "cm":
      return { hasSelection: f.view.state.selection.ranges.some((r) => !r.empty), readOnly: f.view.state.readOnly || !f.view.contentDOM.isContentEditable };
    case "editable": {
      const sel = window.getSelection();
      return { hasSelection: !!sel && !sel.isCollapsed && f.el.contains(sel.anchorNode), readOnly: false };
    }
  }
}

/** Puts `text` at the selection of the field, as typing would (the `input` event fires, so the app's state follows). */
function insert(f: Field, text: string): void {
  if (f.kind === "cm") {
    f.view.focus();
    f.view.dispatch({ ...f.view.state.replaceSelection(text), scrollIntoView: true, userEvent: "input.paste" });
    return;
  }
  f.el.focus();
  if (document.execCommand("insertText", false, text)) return;
  if (f.kind === "input") {
    f.el.setRangeText(text, f.el.selectionStart ?? 0, f.el.selectionEnd ?? 0, "end");
    f.el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: text }));
  }
}

function actionsFor(f: Field): EditActions {
  // the menu click took the focus: give it back before a command that acts on the focused field
  const focus = () => (f.kind === "cm" ? f.view.focus() : f.el.focus());
  return {
    cut: () => {
      focus();
      document.execCommand("cut");
    },
    copy: () => {
      focus();
      document.execCommand("copy");
    },
    paste: () => {
      navigator.clipboard
        .readText()
        .then((text) => {
          if (text) insert(f, text);
        })
        .catch(() => {
          // the webview refused to read the clipboard: let the field paste by itself
          focus();
          document.execCommand("paste");
        });
    },
    selectAll: () => {
      focus();
      if (f.kind === "input") f.el.select();
      else if (f.kind === "cm") f.view.dispatch({ selection: { anchor: 0, head: f.view.state.doc.length } });
      else document.execCommand("selectAll");
    },
  };
}

function onContextMenu(e: MouseEvent): void {
  // a component opened its own menu (or wants none): it called `preventDefault` already
  const handled = e.defaultPrevented;
  e.preventDefault();
  if (handled) return;
  const field = fieldAt(e.target);
  if (field) openContextMenu(e, editMenuItems(stateOf(field), actionsFor(field)));
}

/** Cancels the webview's context menu everywhere and offers Cut / Copy / Paste / Select All on editable fields. Returns the cleanup. */
export function installContextMenuGuard(): () => void {
  window.addEventListener("contextmenu", onContextMenu);
  return () => window.removeEventListener("contextmenu", onContextMenu);
}
