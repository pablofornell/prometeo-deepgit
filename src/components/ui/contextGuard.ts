/**
 * The webview's own context menu never shows (it offers "Reload", "Inspect"... which mean nothing in an app).
 * `installContextMenuGuard()` (called once by `App`) listens on the window, in the bubbling phase, so the component
 * handlers (`openContextMenu`) run first (ITERATION-3.md section 12):
 *
 *   - a right click that a component handled (it called `preventDefault`) is left alone;
 *   - on an editable target (text input, textarea, contenteditable, CodeMirror) it opens the text menu
 *     (Undo, Redo, Cut, Copy, Paste, Select all);
 *   - on selected text that cannot be edited (`dg-selectable`: dialog text, commit message, console output) it opens
 *     Copy and Select all;
 *   - anywhere else it is only cancelled;
 *   - in a development build, Shift+right-click keeps the webview menu ("Inspect element").
 */
import { redo, selectAll, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { type EditActions, type EditState, editMenuItems, readOnlyMenuItems } from "./editMenu";
import { openContextMenu } from "./Menu";
import { copyText } from "./util";

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
        writable: !f.el.readOnly,
        hasSelection: f.el.selectionStart !== f.el.selectionEnd,
        hasText: f.el.value.length > 0,
        noCopy: f.el instanceof HTMLInputElement && f.el.type === "password",
      };
    case "cm":
      return {
        writable: !f.view.state.readOnly && f.view.contentDOM.isContentEditable,
        hasSelection: f.view.state.selection.ranges.some((r) => !r.empty),
        hasText: f.view.state.doc.length > 0,
      };
    case "editable": {
      const sel = window.getSelection();
      return {
        writable: true,
        hasSelection: !!sel && !sel.isCollapsed && f.el.contains(sel.anchorNode),
        hasText: (f.el.textContent ?? "") !== "",
      };
    }
  }
}

/** The clipboard text: the Tauri plugin, or the browser API when the plugin is not there (browser, mock dev mode). */
async function readClipboard(): Promise<string> {
  try {
    const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
    return await readText();
  } catch {
    return navigator.clipboard.readText();
  }
}

/** Writes text to the clipboard: the Tauri plugin first, then the browser way. */
async function writeClipboard(text: string): Promise<void> {
  try {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(text);
  } catch {
    await copyText(text);
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
  // the menu click took the focus: give it back before a command that acts on the focused field, and keep it there
  const focus = () => (f.kind === "cm" ? f.view.focus() : f.el.focus());
  const exec = (command: string) => {
    focus();
    document.execCommand(command);
  };
  return {
    undo: () => {
      if (f.kind === "cm") {
        f.view.focus();
        undo(f.view);
      } else exec("undo");
    },
    redo: () => {
      if (f.kind === "cm") {
        f.view.focus();
        redo(f.view);
      } else exec("redo");
    },
    cut: () => exec("cut"),
    copy: () => exec("copy"),
    paste: () => {
      readClipboard()
        .then((text) => {
          if (text) insert(f, text);
        })
        .catch(() => exec("paste"));
    },
    selectAll: () => {
      focus();
      if (f.kind === "cm") selectAll(f.view);
      else if (!document.execCommand("selectAll") && f.kind === "input") f.el.select();
    },
  };
}

/** Selected text of the page that a right click at `target` is on, with the element to select for "Select all". */
function readOnlySelection(target: EventTarget | null): { text: string; scope: Element } | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !(target instanceof Node)) return null;
  const text = sel.toString();
  if (text.trim() === "") return null;
  const el = target instanceof Element ? target : target.parentElement;
  const scope = el?.closest(".dg-selectable");
  if (scope) return { text, scope };
  // not marked selectable, but the pointer is on the selected text itself
  if (el && sel.containsNode(el, true)) return { text, scope: el };
  return null;
}

function openReadOnlyMenu(e: MouseEvent, sel: { text: string; scope: Element }): void {
  openContextMenu(
    e,
    readOnlyMenuItems({
      copy: () => void writeClipboard(sel.text),
      selectAll: () => {
        const s = window.getSelection();
        if (!s) return;
        const range = document.createRange();
        range.selectNodeContents(sel.scope);
        s.removeAllRanges();
        s.addRange(range);
      },
    }),
  );
}

function onContextMenu(e: MouseEvent): void {
  // development builds: Shift+right-click is the way to "Inspect element"
  if (import.meta.env.DEV && e.shiftKey) return;
  // a component opened its own menu (or wants none): it called `preventDefault` already
  const handled = e.defaultPrevented;
  e.preventDefault();
  if (handled) return;
  const field = fieldAt(e.target);
  if (field) {
    openContextMenu(e, editMenuItems(stateOf(field), actionsFor(field)));
    return;
  }
  const selected = readOnlySelection(e.target);
  if (selected) openReadOnlyMenu(e, selected);
}

/** Cancels the webview's context menu everywhere and offers the text menus. Returns the cleanup. */
export function installContextMenuGuard(): () => void {
  window.addEventListener("contextmenu", onContextMenu);
  return () => window.removeEventListener("contextmenu", onContextMenu);
}
