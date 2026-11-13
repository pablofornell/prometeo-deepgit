// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Minimal localStorage and document so the store can run under node. */
let storage: Map<string, string>;
let rootStyle: Map<string, string>;
let rootAttrs: Map<string, string>;
beforeEach(() => {
  storage = new Map();
  rootStyle = new Map();
  rootAttrs = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  });
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {
    documentElement: {
      setAttribute: (k: string, v: string) => void rootAttrs.set(k, v),
      removeAttribute: (k: string) => void rootAttrs.delete(k),
      style: { setProperty: (k: string, v: string) => void rootStyle.set(k, v), removeProperty: (k: string) => void rootStyle.delete(k) },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

const load = async () => {
  vi.resetModules();
  return import("./settings");
};

describe("settings store", () => {
  it("starts with the defaults", async () => {
    const { settings, SETTING_DEFAULTS } = await load();
    expect({ ...settings }).toEqual({ ...SETTING_DEFAULTS });
    expect(settings.fontSize).toBe(13);
    expect(settings.uiScale).toBe(100);
    expect(settings.editorFontSize).toBeNull();
  });

  it("ignores garbage and clamps stored values", async () => {
    storage.set("deepgit.ui.fontSize", "999");
    storage.set("deepgit.ui.uiScale", '"wide"');
    storage.set("deepgit.ui.editorFontSize", "3");
    storage.set("deepgit.ui.theme", '"purple"');
    storage.set("deepgit.ui.showGraph", "42");
    storage.set("deepgit.ui.dateFormat", "{not json");
    const { settings } = await load();
    expect(settings.fontSize).toBe(20);
    expect(settings.uiScale).toBe(100);
    expect(settings.editorFontSize).toBe(10);
    expect(settings.theme).toBe("dark");
    expect(settings.showGraph).toBe(true);
    expect(settings.dateFormat).toBe("iso");
  });

  it("diff pointer scrolling is on by default, and a stored garbage value falls back to on", async () => {
    storage.set("deepgit.ui.diffPointerScroll", "42");
    const { settings } = await load();
    expect(settings.diffPointerScroll).toBe(true);
  });

  it("diff pointer scrolling can be turned off, and garbage set at runtime falls back to on", async () => {
    const { settings, setSetting, resetSettings } = await load();
    expect(settings.diffPointerScroll).toBe(true);
    setSetting("diffPointerScroll", false);
    expect(settings.diffPointerScroll).toBe(false);
    expect(storage.get("deepgit.ui.diffPointerScroll")).toBe("false");
    setSetting("diffPointerScroll", "no" as never);
    expect(settings.diffPointerScroll).toBe(true);
    setSetting("diffPointerScroll", false);
    resetSettings(["diffPointerScroll"]);
    expect(settings.diffPointerScroll).toBe(true);
    expect(storage.has("deepgit.ui.diffPointerScroll")).toBe(false);
  });

  it("loads valid stored values", async () => {
    storage.set("deepgit.ui.fontSize", "16");
    storage.set("deepgit.ui.uiScale", "130");
    storage.set("deepgit.ui.theme", '"light"');
    const { settings } = await load();
    expect([settings.fontSize, settings.uiScale, settings.theme]).toEqual([16, 130, "light"]);
  });

  it("keeps a date format the user chose, even when it is not the default", async () => {
    storage.set("deepgit.ui.dateFormat", '"relative"');
    const { settings } = await load();
    expect(settings.dateFormat).toBe("relative");
  });

  it("setSetting validates, persists and applies the sizes", async () => {
    const { settings, setSetting } = await load();
    setSetting("fontSize", 18);
    expect(settings.fontSize).toBe(18);
    expect(storage.get("deepgit.ui.fontSize")).toBe("18");
    expect(rootStyle.get("--dg-font-base")).toBe("18px");
    setSetting("fontSize", 400);
    expect(settings.fontSize).toBe(20);
    setSetting("uiScale", 150);
    expect(rootStyle.get("--dg-ui-scale")).toBe("1.5");
    expect(rootStyle.get("zoom")).toBe("1.5"); // browser fallback
    setSetting("uiScale", 100);
    expect(rootStyle.has("zoom")).toBe(false);
    setSetting("theme", "nonsense" as never);
    expect(settings.theme).toBe("dark");
  });

  it("drops the stored values of settings that no longer exist (lane colours by repository, repo tint strength)", async () => {
    storage.set("deepgit.ui.laneColors", '"repo"');
    storage.set("deepgit.ui.repoTintStrength", "150");
    storage.set("deepgit.ui.showGraph", "false");
    const { settings, SETTING_DEFAULTS, RETIRED_KEYS } = await load();
    expect([...RETIRED_KEYS]).toEqual(["laneColors", "repoTintStrength"]);
    expect(storage.has("deepgit.ui.laneColors")).toBe(false);
    expect(storage.has("deepgit.ui.repoTintStrength")).toBe(false);
    // the store has no such keys, and the settings that still exist are untouched
    expect(Object.keys(settings).sort()).toEqual(Object.keys(SETTING_DEFAULTS).sort());
    expect("laneColors" in settings || "repoTintStrength" in settings).toBe(false);
    expect(settings.showGraph).toBe(false);
    expect(rootStyle.has("--dg-repo-tint-k")).toBe(false);
    expect(rootAttrs.has("data-repo-tints")).toBe(false);
  });

  it("every Git section key is validated and 'Reset all' puts it back", async () => {
    const { settings, setSetting, resetSettings } = await load();
    setSetting("autoFetchMinutes", 7 as never);
    expect(settings.autoFetchMinutes).toBe(15); // not one of the choices
    setSetting("autoFetchMinutes", 30);
    setSetting("autoFetchPrune", false);
    setSetting("commitSignOff", true);
    setSetting("useCredentialStore", false);
    setSetting("useCredentialStore", "yes" as never);
    expect(settings.useCredentialStore).toBe(true); // garbage falls back to the default
    setSetting("useCredentialStore", false);
    resetSettings();
    expect([settings.autoFetchMinutes, settings.autoFetchPrune, settings.commitSignOff, settings.useCredentialStore]).toEqual([15, true, false, true]);
  });

  it("validates the alert expiry (the choices only, default 24 hours) and 'Reset all' puts it back", async () => {
    const { settings, setSetting, resetSettings, SETTING_DEFAULTS, ALERT_EXPIRY_CHOICES } = await load();
    expect(SETTING_DEFAULTS.alertExpiryHours).toBe(24);
    expect([...ALERT_EXPIRY_CHOICES]).toEqual([1, 4, 24, 72, 168, 0]);
    setSetting("alertExpiryHours", 168);
    expect(settings.alertExpiryHours).toBe(168);
    expect(storage.get("deepgit.ui.alertExpiryHours")).toBe("168");
    setSetting("alertExpiryHours", 0);
    expect(settings.alertExpiryHours).toBe(0); // never
    setSetting("alertExpiryHours", 5 as never);
    expect(settings.alertExpiryHours).toBe(24);
    setSetting("alertExpiryHours", 4);
    resetSettings(["alertExpiryHours"]);
    expect(settings.alertExpiryHours).toBe(24);
    expect(storage.has("deepgit.ui.alertExpiryHours")).toBe(false);
  });

  it("uses the webview zoom instead of CSS zoom in the desktop app", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    const { setSetting } = await load();
    setSetting("uiScale", 140);
    expect(rootStyle.get("--dg-ui-scale")).toBe("1.4");
    expect(rootStyle.has("zoom")).toBe(false);
  });

  it("zoomUi steps by 10 and stops at 80 and 200", async () => {
    const { settings, zoomUi } = await load();
    expect(zoomUi(1)).toBe(110);
    expect(zoomUi(-1)).toBe(100);
    for (let i = 0; i < 20; i++) zoomUi(1);
    expect(settings.uiScale).toBe(200);
    for (let i = 0; i < 20; i++) zoomUi(-1);
    expect(settings.uiScale).toBe(80);
  });

  it("resetSettings puts values back and removes the stored ones", async () => {
    const { settings, setSetting, resetSettings } = await load();
    setSetting("fontSize", 17);
    setSetting("uiScale", 160);
    setSetting("showGraph", false);
    setSetting("editorFontSize", 15);
    resetSettings(["fontSize", "editorFontSize"]);
    expect([settings.fontSize, settings.editorFontSize]).toEqual([13, null]);
    expect(storage.has("deepgit.ui.fontSize")).toBe(false);
    expect(storage.has("deepgit.ui.editorFontSize")).toBe(false);
    expect(settings.uiScale).toBe(160); // not in the list
    expect(settings.showGraph).toBe(false);
    expect(rootStyle.get("--dg-font-base")).toBe("13px");
    resetSettings();
    expect([settings.uiScale, settings.showGraph]).toEqual([100, true]);
    expect(storage.has("deepgit.ui.uiScale")).toBe(false);
    expect(storage.has("deepgit.ui.showGraph")).toBe(false);
  });
});

describe("system theme", () => {
  /** A matchMedia whose answer the test changes, with the listeners the page registers. */
  function stubMedia(initialLight: boolean) {
    let light = initialLight;
    const listeners: (() => void)[] = [];
    vi.stubGlobal("matchMedia", (q: string) => ({
      get matches() {
        return q.includes("light") ? light : !light;
      },
      addEventListener: (_: string, cb: () => void) => void listeners.push(cb),
    }));
    return {
      switchTo(next: "light" | "dark") {
        light = next === "light";
        listeners.forEach((cb) => cb());
      },
    };
  }

  it("is a signal: an OS switch re-runs what reads resolvedTheme, and applies data-theme", async () => {
    const os = stubMedia(false);
    const { initSettings, resolvedTheme, setSetting } = await load();
    // after `load` (it resets the modules): the effect must come from the same solid as the store
    const { createRoot, createEffect } = await import("solid-js");
    setSetting("theme", "system");
    initSettings();
    const seen: string[] = [];
    const dispose = createRoot((d) => {
      createEffect(() => seen.push(resolvedTheme()));
      return d;
    });
    expect(seen).toEqual(["dark"]);
    os.switchTo("light");
    expect(resolvedTheme()).toBe("light");
    expect(rootAttrs.get("data-theme")).toBe("light");
    expect(seen).toEqual(["dark", "light"]);
    os.switchTo("dark");
    expect(seen).toEqual(["dark", "light", "dark"]);
    // an explicit choice does not follow the OS
    setSetting("theme", "light");
    os.switchTo("dark");
    expect(resolvedTheme()).toBe("light");
    dispose();
  });
});

