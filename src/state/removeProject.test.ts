// Removing the active project: the next project in the sorted list opens, the selection resets before any await, and a
// failure to save the new active project is not a failed removal (ITERATION-3.md section 5.3).
import { describe, expect, it, vi } from "vitest";

const setActive = vi.fn();
vi.mock("../api/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/tauri")>()),
  projectSetActive: (...args: unknown[]) => setActive(...args),
}));

import { loadWorkspace, onActiveProjectChanged, removeProject, sortedProjects, workspace } from "./workspace";

describe("removeProject", () => {
  it("opens the next project of the sorted list, resets the selection first, and ignores a failed save of the active id", async () => {
    await loadWorkspace();
    const sorted = sortedProjects();
    expect(sorted.length).toBeGreaterThan(1);
    expect(workspace.activeProjectId).not.toBeNull();
    const active = workspace.activeProjectId as string;
    const at = sorted.findIndex((p) => p.id === active);
    const expected = (sorted[at + 1] ?? sorted[at - 1]).id;

    setActive.mockRejectedValue(new Error("disk full"));
    const calls: number[] = [];
    const off = onActiveProjectChanged(() => calls.push(setActive.mock.calls.length));
    await expect(removeProject(active)).resolves.toBeUndefined();
    off();

    expect(workspace.projects.some((p) => p.id === active)).toBe(false);
    expect(workspace.activeProjectId).toBe(expected);
    // the selection was reset before the backend was asked to save the new active project
    expect(calls).toEqual([0]);
    expect(setActive).toHaveBeenCalledWith(expected);
  });
});
