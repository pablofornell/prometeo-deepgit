// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { editMenuItems } from "./editMenu";

const run = () => ({ cut: vi.fn(), copy: vi.fn(), paste: vi.fn(), selectAll: vi.fn() });
const summary = (items: ReturnType<typeof editMenuItems>) => items.map((i) => (i.separator ? "-" : `${i.label}${i.disabled ? " (off)" : ""}`));

describe("editMenuItems", () => {
  it("offers Cut, Copy, Paste, a separator and Select All with their shortcuts", () => {
    const items = editMenuItems({ hasSelection: true, readOnly: false }, run());
    expect(summary(items)).toEqual(["Cut", "Copy", "Paste", "-", "Select All"]);
    expect(items.filter((i) => !i.separator).map((i) => i.shortcut)).toEqual(["Ctrl+X", "Ctrl+C", "Ctrl+V", "Ctrl+A"]);
  });

  it("turns Cut and Copy off when nothing is selected", () => {
    expect(summary(editMenuItems({ hasSelection: false, readOnly: false }, run()))).toEqual(["Cut (off)", "Copy (off)", "Paste", "-", "Select All"]);
  });

  it("turns Cut and Paste off in a read-only field, and keeps Copy", () => {
    expect(summary(editMenuItems({ hasSelection: true, readOnly: true }, run()))).toEqual(["Cut (off)", "Copy", "Paste (off)", "-", "Select All"]);
  });

  it("does not copy out of a password field", () => {
    expect(summary(editMenuItems({ hasSelection: true, readOnly: false, noCopy: true }, run()))).toEqual(["Cut (off)", "Copy (off)", "Paste", "-", "Select All"]);
  });

  it("runs the action of the chosen item", () => {
    const r = run();
    const [cut, copy, paste, , all] = editMenuItems({ hasSelection: true, readOnly: false }, r);
    cut.onSelect?.();
    copy.onSelect?.();
    paste.onSelect?.();
    all.onSelect?.();
    expect([r.cut, r.copy, r.paste, r.selectAll].map((f) => f.mock.calls.length)).toEqual([1, 1, 1, 1]);
  });
});
