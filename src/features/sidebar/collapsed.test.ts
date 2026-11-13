// @vitest-environment node
import { describe, expect, it } from "vitest";
import { collapsedFor, collapsedKey, pruneCollapsed, type CollapsedState } from "./collapsed";

const state = (projectId: string | null, ...ids: string[]): CollapsedState => ({ projectId, ids: new Set(ids) });

describe("collapsed folders", () => {
  it("keys the saved ids by project", () => {
    expect(collapsedKey("p1")).toBe("sidebar.collapsedFolders.p1");
    expect(collapsedKey(undefined)).toBe("sidebar.collapsedFolders.none");
  });

  it("gives the ids only to the project they were loaded for", () => {
    expect([...collapsedFor(state("A", "dir:x"), "A")]).toEqual(["dir:x"]);
    expect([...collapsedFor(state("A", "dir:x"), "B")]).toEqual([]);
  });

  it("prunes ids of folders that are gone", () => {
    const next = pruneCollapsed(state("A", "dir:IRIS", "dir:old"), "A", ["dir:IRIS", "dir:HAB"]);
    expect(next?.projectId).toBe("A");
    expect([...(next?.ids ?? [])]).toEqual(["dir:IRIS"]);
    expect(pruneCollapsed(state("A", "dir:IRIS"), "A", ["dir:IRIS"])).toBeNull();
  });

  it("never prunes the state of another project against the folders of the active one", () => {
    // project switch A -> B: the folders are B's, the loaded set still A's (or B's before its folders are known)
    expect(pruneCollapsed(state("A", "dir:IRIS"), "B", ["dir:HAB"])).toBeNull();
    expect(pruneCollapsed(state("B", "dir:HAB"), "B", [])).toBeNull();
    expect(pruneCollapsed(state(null), null, ["dir:HAB"])).toBeNull();
  });
});
