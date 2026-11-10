// @vitest-environment node
import { describe, expect, it } from "vitest";
import { type RenameInput, renameStep, renamingAfterSwitch } from "./rename";

const base: RenameInput = { projectId: "a", original: "api", shownId: "a", value: "Work", error: null, leaving: false };

describe("renameStep", () => {
  it("saves under the id the editor was opened for", () => {
    expect(renameStep(base)).toEqual({ kind: "save", projectId: "a", name: "Work" });
    expect(renameStep({ ...base, leaving: true })).toEqual({ kind: "save", projectId: "a", name: "Work" });
  });

  it("closes without saving when the card shows another project (Enter or blur)", () => {
    for (const leaving of [false, true]) {
      expect(renameStep({ ...base, shownId: "b", leaving })).toEqual({ kind: "close" });
      expect(renameStep({ ...base, shownId: undefined, leaving })).toEqual({ kind: "close" });
    }
  });

  it("closes for the unchanged name, keeps an invalid one open on Enter and drops it on blur", () => {
    expect(renameStep({ ...base, value: " api " })).toEqual({ kind: "close" });
    expect(renameStep({ ...base, error: "taken" })).toEqual({ kind: "keep" });
    expect(renameStep({ ...base, error: "taken", leaving: true })).toEqual({ kind: "close" });
  });
});

describe("renamingAfterSwitch", () => {
  it("keeps the editor only for the project that is still shown", () => {
    expect(renamingAfterSwitch("a", "a")).toBe("a");
    expect(renamingAfterSwitch("a", "b")).toBeNull();
    expect(renamingAfterSwitch("a", undefined)).toBeNull();
    expect(renamingAfterSwitch(null, "a")).toBeNull();
  });
});
