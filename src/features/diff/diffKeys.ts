/**
 * Diff shortcuts (DESIGN.md section 8). Several viewers can be mounted at once (diff island, Local changes);
 * the shortcuts act on the one the user touched last.
 */
import { register } from "../../state/keymap";
import { setSetting, settings } from "../../state/settings";

export interface DiffController {
  /** Moves to the next change; false when there is none (the key then passes through). */
  next(): boolean;
  prev(): boolean;
  toggleIgnoreWhitespace(): void;
}

const stack: DiffController[] = [];
let offs: (() => void)[] = [];

const top = (): DiffController | undefined => stack[stack.length - 1];

function ensureBindings(): void {
  if (offs.length > 0) return;
  const when = () => stack.length > 0;
  offs = [
    register("diff.nextChange", "F7", () => top()?.next() ?? false, { title: "Next change", group: "Diff", when }),
    register("diff.prevChange", "Shift+F7", () => top()?.prev() ?? false, { title: "Previous change", group: "Diff", when }),
    register(
      "diff.toggleMode",
      "Ctrl+Alt+D",
      () => setSetting("diffMode", settings.diffMode === "sideBySide" ? "unified" : "sideBySide"),
      { title: "Diff: side by side / unified", group: "Diff", when },
    ),
    register("diff.toggleWhitespace", "Ctrl+Alt+W", () => top()?.toggleIgnoreWhitespace(), { title: "Diff: toggle ignore whitespace", group: "Diff", when }),
  ];
}

/** Makes `c` the controller the shortcuts act on (call on mount and on pointer / focus). */
export function activateDiff(c: DiffController): void {
  const i = stack.indexOf(c);
  if (i >= 0 && i === stack.length - 1) return;
  if (i >= 0) stack.splice(i, 1);
  stack.push(c);
  ensureBindings();
}

/** Call on cleanup. */
export function releaseDiff(c: DiffController): void {
  const i = stack.indexOf(c);
  if (i >= 0) stack.splice(i, 1);
  if (stack.length === 0) {
    offs.forEach((off) => off());
    offs = [];
  }
}
