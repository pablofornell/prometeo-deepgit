// @vitest-environment node
import { describe, expect, it } from "vitest";
import { committerDiffers, pushState } from "./commitText";

describe("committerDiffers", () => {
  const a = { name: "A", email: "a@x.dev", time: 1000 };
  it("is false for the same person within a minute", () => {
    expect(committerDiffers(a, { ...a, time: 1030 })).toBe(false);
    expect(committerDiffers(a, { ...a, email: "A@X.dev" })).toBe(false);
  });
  it("is true for another person or a later commit", () => {
    expect(committerDiffers(a, { ...a, name: "B" })).toBe(true);
    expect(committerDiffers(a, { ...a, time: 2000 })).toBe(true);
  });
});

describe("pushState", () => {
  const base = { remoteBranches: new Set(["origin/main", "origin/x"]), remotes: ["origin"], current: { branch: "feature/a", upstream: "origin/feature/a", ahead: 3 } };
  it("is pushed when a remote branch contains the commit", () => {
    expect(pushState({ ...base, branches: ["main", "origin/main"] })).toEqual({ kind: "pushed", remotes: ["origin/main"] });
  });
  it("counts commits to push when the commit is on the current branch", () => {
    expect(pushState({ ...base, branches: ["feature/a"] })).toEqual({ kind: "unpushed", remote: "origin", ahead: 3 });
  });
  it("does not guess the count for other branches", () => {
    expect(pushState({ ...base, branches: ["other"] })).toEqual({ kind: "unpushed", remote: "origin", ahead: null });
  });
  it("takes the longest remote name from the upstream (remote with a slash)", () => {
    const input = { ...base, remotes: ["origin", "team", "team/fork"], current: { branch: "f", upstream: "team/fork/f", ahead: 1 }, branches: ["f"] };
    expect(pushState(input)).toEqual({ kind: "unpushed", remote: "team/fork", ahead: 1 });
  });
  it("says nothing without remotes", () => {
    expect(pushState({ ...base, remotes: [], branches: ["a"] })).toEqual({ kind: "none" });
  });
});
