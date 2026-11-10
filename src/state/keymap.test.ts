// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A minimal window/navigator so keymap.ts can run under node.
type Listener = (e: unknown) => void;
const listeners: Listener[] = [];
beforeEach(() => {
  listeners.length = 0;
  vi.stubGlobal("window", { addEventListener: (_: string, l: Listener) => listeners.push(l), removeEventListener: () => {} });
  vi.stubGlobal("navigator", { platform: "Linux" });
});
afterEach(() => vi.unstubAllGlobals());

function key(init: { key: string; code?: string; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; target?: unknown }) {
  let prevented = false;
  const e = { repeat: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, code: "", target: { tagName: "DIV", isContentEditable: false }, ...init, preventDefault: () => { prevented = true; } };
  listeners.forEach((l) => l(e));
  return prevented;
}

describe("keymap", () => {
  it("matches chords, Alt+digit and the backtick chord", async () => {
    vi.resetModules();
    const km = await import("./keymap");
    km.installKeymap();
    const hits: string[] = [];
    km.register("a", "Ctrl+K", () => void hits.push("palette"));
    km.register("b", "Alt+9", () => void hits.push("console"));
    km.register("c", "Ctrl+Shift+`", () => void hits.push("branch"));
    expect(key({ key: "k", code: "KeyK", ctrlKey: true })).toBe(true);
    key({ key: "9", code: "Digit9", altKey: true });
    key({ key: "~", code: "Backquote", ctrlKey: true, shiftKey: true });
    expect(hits).toEqual(["palette", "console", "branch"]);
  });

  it("detects Shift Shift within 300 ms but not Shift+letter typing", async () => {
    vi.resetModules();
    const km = await import("./keymap");
    km.installKeymap();
    let n = 0;
    km.register("p", "Shift Shift", () => void n++);
    key({ key: "Shift", code: "ShiftLeft", shiftKey: true });
    key({ key: "A", code: "KeyA", shiftKey: true });
    key({ key: "Shift", code: "ShiftLeft", shiftKey: true });
    expect(n).toBe(0);
    key({ key: "Shift", code: "ShiftLeft", shiftKey: true });
    expect(n).toBe(1);
  });

  it("skips plain keys inside text fields and honours `when`", async () => {
    vi.resetModules();
    const km = await import("./keymap");
    km.installKeymap();
    let plain = 0;
    let gated = 0;
    km.register("space", "Space", () => void plain++);
    km.register("gated", "Alt+1", () => void gated++, () => false);
    key({ key: " ", code: "Space", target: { tagName: "INPUT", isContentEditable: false } });
    key({ key: "1", code: "Digit1", altKey: true });
    expect(plain).toBe(0);
    expect(gated).toBe(0);
    key({ key: " ", code: "Space" });
    expect(plain).toBe(1);
  });

  it("lists bindings and replaces on re-register", async () => {
    vi.resetModules();
    const km = await import("./keymap");
    km.register("x", "F7", () => {}, { title: "Next change", group: "Diff" });
    km.register("x", "Shift+F7", () => {}, { title: "Previous change", group: "Diff" });
    expect(km.bindings()).toEqual([{ id: "x", keys: ["Shift+F7"], title: "Previous change", group: "Diff" }]);
    expect(km.keysFor("x")).toEqual(["Shift+F7"]);
  });

  it("stays quiet while an overlay is open unless the binding opts in", async () => {
    vi.resetModules();
    const km = await import("./keymap");
    km.installKeymap();
    const hits: string[] = [];
    km.register("plain", "Space", () => void hits.push("plain"));
    km.register("chord", "Ctrl+K", () => void hits.push("chord"));
    km.register("open", "Alt+9", () => void hits.push("opt-in"), { allowInOverlay: true });
    expect(km.isOverlayOpen()).toBe(false);
    const release = km.openOverlay();
    const release2 = km.openOverlay();
    expect(km.isOverlayOpen()).toBe(true);
    expect(key({ key: " ", code: "Space" })).toBe(false);
    expect(key({ key: "k", code: "KeyK", ctrlKey: true })).toBe(false);
    key({ key: "9", code: "Digit9", altKey: true });
    expect(hits).toEqual(["opt-in"]);
    release();
    release(); // idempotent
    expect(km.isOverlayOpen()).toBe(true);
    release2();
    expect(km.isOverlayOpen()).toBe(false);
    expect(key({ key: " ", code: "Space" })).toBe(true);
    expect(hits).toEqual(["opt-in", "plain"]);
  });

  it("blocks Ctrl chords in text fields unless allowInInput, but not Alt chords", async () => {
    vi.resetModules();
    const km = await import("./keymap");
    km.installKeymap();
    const hits: string[] = [];
    km.register("sel", "Ctrl+A", () => void hits.push("selectAll"));
    km.register("commit", "Ctrl+Enter", () => void hits.push("commit"), { allowInInput: true });
    km.register("alt", "Alt+1", () => void hits.push("alt"));
    const input = { tagName: "TEXTAREA", isContentEditable: false };
    key({ key: "a", code: "KeyA", ctrlKey: true, target: input });
    key({ key: "Enter", code: "Enter", ctrlKey: true, target: input });
    key({ key: "1", code: "Digit1", altKey: true, target: input });
    expect(hits).toEqual(["commit", "alt"]);
    key({ key: "a", code: "KeyA", ctrlKey: true });
    expect(hits).toEqual(["commit", "alt", "selectAll"]);
  });

  it("blockedInInput: plain and Ctrl/Meta sequences yes, Alt chords and modifier taps no", async () => {
    vi.resetModules();
    const { blockedInInput } = await import("./keymap");
    expect(blockedInInput(["Space"])).toBe(true);
    expect(blockedInInput(["Shift+F7"])).toBe(true);
    expect(blockedInInput(["Ctrl+K"])).toBe(true);
    expect(blockedInInput(["Ctrl+Alt+N"])).toBe(true);
    expect(blockedInInput(["Alt+Left"])).toBe(false);
    expect(blockedInInput(["Shift", "Shift"])).toBe(false);
  });

  it("maps only Cmd to Ctrl on macOS, Ctrl stays Ctrl elsewhere", async () => {
    vi.resetModules();
    const { eventToken } = await import("./keymap");
    const k = { key: "k", code: "KeyK", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
    expect(eventToken({ ...k, metaKey: true }, true)).toBe("Ctrl+K");
    expect(eventToken({ ...k, ctrlKey: true }, true)).toBe("Meta+K"); // physical Ctrl on a Mac is not Cmd
    expect(eventToken({ ...k, ctrlKey: true }, false)).toBe("Ctrl+K");
    expect(eventToken({ ...k, metaKey: true }, false)).toBe("Meta+K");
    expect(eventToken({ ...k, key: "Meta", code: "MetaLeft", metaKey: true }, true)).toBe("Ctrl");
    expect(eventToken({ ...k, key: "Control", code: "ControlLeft", ctrlKey: true }, false)).toBe("Ctrl");
  });
});
