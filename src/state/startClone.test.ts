// @vitest-environment node
// A Cancel pressed before `cloneRepo` is invoked (the progress listener is awaited first) must still reach the backend.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloneResult } from "../api/types";

const calls: string[] = [];
let releaseListen: () => void = () => undefined;
let rejectClone: (e: unknown) => void = () => undefined;

vi.mock("../api/tauri", async (orig) => ({
  ...(await orig<typeof import("../api/tauri")>()),
  onCloneProgress: vi.fn(() => {
    calls.push("listen");
    return new Promise<() => void>((resolve) => {
      releaseListen = () => resolve(() => calls.push("unlisten"));
    });
  }),
  cloneRepo: vi.fn(() => {
    calls.push("cloneRepo");
    return new Promise<CloneResult>((_, reject) => {
      rejectClone = reject;
    });
  }),
  cloneCancel: vi.fn(() => {
    calls.push("cloneCancel");
    return Promise.resolve();
  }),
}));
// the UI kit needs a DOM; actions only use these three helpers
vi.mock("../components/ui", () => ({ joinNames: (n: string[]) => n.join(", "), plural: (n: number, w: string) => `${n} ${w}`, toast: vi.fn() }));
vi.mock("./dialogs", () => ({ confirmAction: vi.fn(), showDialog: vi.fn() }));
vi.mock("./workspace", async (orig) => ({
  ...(await orig<typeof import("./workspace")>()),
  activeProject: () => ({ id: "p1", name: "p", path: "/w/p", repos: [] }),
  adoptClonedProject: vi.fn(),
}));

const req = { url: "https://h/r.git", parentDir: "/w/p", dirName: "r", branch: null, depth: null, recurseSubmodules: false, addTo: "current" as const };

beforeEach(() => {
  calls.length = 0;
});

describe("startClone cancel", () => {
  it("sends the cancel again when the clone starts after the user pressed Cancel during setup", async () => {
    const { startClone } = await import("./actions");
    const run = startClone(req, () => undefined);
    // Cancel while the progress listener is still being set up: the backend does not know the clone yet
    run.cancel();
    expect(calls).toEqual(["listen", "cloneCancel"]);
    releaseListen();
    await vi.waitFor(() => expect(calls).toContain("cloneRepo"));
    // ... so the clone start is followed by a second cancel
    expect(calls).toEqual(["listen", "cloneCancel", "cloneRepo", "cloneCancel"]);
    rejectClone({ message: "The operation was cancelled." });
    await expect(run.done).resolves.toEqual({ ok: false, cancelled: true, error: null });
    expect(calls.at(-1)).toBe("unlisten");
  });

  it("does not cancel a clone nobody cancelled", async () => {
    const { startClone } = await import("./actions");
    const run = startClone(req, () => undefined);
    releaseListen();
    await vi.waitFor(() => expect(calls).toContain("cloneRepo"));
    expect(calls).not.toContain("cloneCancel");
    rejectClone({ message: "boom" });
    const out = await run.done;
    expect(out).toMatchObject({ ok: false, cancelled: false, error: { message: "boom" } });
  });
});
