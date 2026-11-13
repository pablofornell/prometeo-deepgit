import { describe, expect, it, vi } from "vitest";
import { ignorable, ignoreMenuItems, type IgnoreRef } from "./ignoreMenu";

const file = (path: string, repoId = "r1"): IgnoreRef => ({ repoId, path, isDir: false });
const noop = () => {};
const dir = (path: string, repoId = "r1"): IgnoreRef => ({ repoId, path, isDir: true });

describe("ignore menu item", () => {
  it("adds a separator and one item for a file", () => {
    const items = ignoreMenuItems([file("src/a.ts")], noop);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ separator: true });
    expect(items[1]).toMatchObject({ label: "Add to .gitignore…", disabled: false });
    expect(items[1].icon).toBeUndefined();
  });

  it("gives no items for a repo root row or a .gitignore file", () => {
    expect(ignoreMenuItems([dir("")], noop)).toEqual([]);
    expect(ignoreMenuItems([file(".gitignore")], noop)).toEqual([]);
    expect(ignoreMenuItems([file("web/.gitignore")], noop)).toEqual([]);
    expect(ignoreMenuItems([], noop)).toEqual([]);
  });

  it("keeps a folder that is named .gitignore", () => {
    expect(ignorable([dir("a/.gitignore")])).toHaveLength(1);
  });

  it("counts the files of a selection and skips its .gitignore", () => {
    const items = ignoreMenuItems([file("a.ts"), file("b.ts"), file(".gitignore"), dir("out")], noop);
    expect(items[1].label).toBe("Add 3 files to .gitignore…");
    expect(items[1].disabled).toBe(false);
  });

  it("is disabled with a hint for rows of different repositories", () => {
    const items = ignoreMenuItems([file("a.ts", "r1"), file("b.ts", "r2")], noop);
    expect(items[1]).toMatchObject({ label: "Add 2 files to .gitignore…", disabled: true, tooltip: "Select files of one repository." });
  });

  it("opens the dialog for the repo with the paths and the folder flags", () => {
    const open = vi.fn(async () => {});
    ignoreMenuItems([file("a.ts"), dir("out")], open)[1].onSelect?.();
    expect(open).toHaveBeenCalledWith("r1", [
      { path: "a.ts", isDir: false },
      { path: "out", isDir: true },
    ]);
  });
});
