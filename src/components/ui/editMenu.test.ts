// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { type EditState, editMenuItems, readOnlyMenuItems } from "./editMenu";

const run = () => ({ undo: vi.fn(), redo: vi.fn(), cut: vi.fn(), copy: vi.fn(), paste: vi.fn(), selectAll: vi.fn() });
const summary = (items: ReturnType<typeof editMenuItems>) => items.map((i) => (i.separator ? "-" : `${i.label}${i.disabled ? " (off)" : ""}`));
const state = (o: Partial<EditState> = {}): EditState => ({ writable: true, hasSelection: true, hasText: true, ...o });

describe("editMenuItems", () => {
  it("follows the table: Undo, Redo, Cut, Copy, Paste, Select all with their shortcuts", () => {
    const items = editMenuItems(state(), run());
    expect(summary(items)).toEqual(["Undo", "Redo", "-", "Cut", "Copy", "Paste", "-", "Select all"]);
    expect(items.filter((i) => !i.separator).map((i) => i.shortcut)).toEqual(["Ctrl+Z", "Ctrl+Shift+Z", "Ctrl+X", "Ctrl+C", "Ctrl+V", "Ctrl+A"]);
  });

  it("turns Cut and Copy off when nothing is selected", () => {
    expect(summary(editMenuItems(state({ hasSelection: false }), run()))).toEqual(["Undo", "Redo", "-", "Cut (off)", "Copy (off)", "Paste", "-", "Select all"]);
  });

  it("turns Undo, Redo, Cut and Paste off in a read-only field, and keeps Copy", () => {
    expect(summary(editMenuItems(state({ writable: false }), run()))).toEqual(["Undo (off)", "Redo (off)", "-", "Cut (off)", "Copy", "Paste (off)", "-", "Select all"]);
  });

  it("turns Select all off in an empty field", () => {
    expect(summary(editMenuItems(state({ hasSelection: false, hasText: false }), run())).at(-1)).toBe("Select all (off)");
  });

  it("never cuts or copies out of a password field", () => {
    expect(summary(editMenuItems(state({ noCopy: true }), run()))).toEqual(["Undo", "Redo", "-", "Cut (off)", "Copy (off)", "Paste", "-", "Select all"]);
  });

  it("runs the action of the chosen item", () => {
    const r = run();
    const items = editMenuItems(state(), r);
    for (const i of items) i.onSelect?.();
    expect([r.undo, r.redo, r.cut, r.copy, r.paste, r.selectAll].map((f) => f.mock.calls.length)).toEqual([1, 1, 1, 1, 1, 1]);
  });
});

describe("readOnlyMenuItems", () => {
  it("is Copy, a separator and Select all", () => {
    const r = run();
    const items = readOnlyMenuItems(r);
    expect(items.map((i) => (i.separator ? "-" : i.label))).toEqual(["Copy", "-", "Select all"]);
    expect(items.filter((i) => !i.separator).map((i) => [i.shortcut, i.disabled])).toEqual([["Ctrl+C", undefined], ["Ctrl+A", undefined]]);
    items[0].onSelect?.();
    items[2].onSelect?.();
    expect([r.copy.mock.calls.length, r.selectAll.mock.calls.length]).toEqual([1, 1]);
  });
});
