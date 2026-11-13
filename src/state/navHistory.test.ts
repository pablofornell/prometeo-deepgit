// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NAV_LIMIT, createNavHistory, sameLocation, type NavLocation } from "./navHistory";

const log = (oid?: string, repoId = "r1"): NavLocation => ({ view: "log", commit: oid ? { repoId, oid } : undefined });
const file = (path: string, repoId = "r1"): NavLocation => ({ view: "files", file: { repoId, path } });

describe("sameLocation", () => {
  it("compares view, commit and file", () => {
    expect(sameLocation(log("a"), log("a"))).toBe(true);
    expect(sameLocation(log("a"), log("b"))).toBe(false);
    expect(sameLocation(log("a", "r1"), log("a", "r2"))).toBe(false);
    expect(sameLocation(log(), log())).toBe(true);
    expect(sameLocation(log("a"), { view: "changes" })).toBe(false);
    expect(sameLocation(file("x"), file("x"))).toBe(true);
    expect(sameLocation(file("x"), file("y"))).toBe(false);
    expect(sameLocation({ view: "log", commit: { repoId: "r1", oid: "a", stash: 0 } }, log("a"))).toBe(false);
    expect(sameLocation(null, null)).toBe(true);
    expect(sameLocation(null, log())).toBe(false);
  });
});

describe("createNavHistory", () => {
  it("starts empty", () => {
    const h = createNavHistory();
    expect(h.current()).toBeNull();
    expect(h.canBack()).toBe(false);
    expect(h.canForward()).toBe(false);
    expect(h.back()).toBeNull();
    expect(h.forward()).toBeNull();
  });

  it("the first record has nothing to go back to", () => {
    const h = createNavHistory();
    h.record(log("a"));
    expect(h.current()).toEqual(log("a"));
    expect(h.canBack()).toBe(false);
  });

  it("goes back and forward through the locations", () => {
    const h = createNavHistory();
    h.record(log("a"));
    h.record(log("b"));
    h.record(file("x"));
    expect(h.back()).toEqual(log("b"));
    expect(h.back()).toEqual(log("a"));
    expect(h.back()).toBeNull();
    expect(h.current()).toEqual(log("a"));
    expect(h.forward()).toEqual(log("b"));
    expect(h.forward()).toEqual(file("x"));
    expect(h.forward()).toBeNull();
    expect(h.canForward()).toBe(false);
  });

  it("collapses consecutive duplicates", () => {
    const h = createNavHistory();
    h.record(log("a"));
    h.record(log("a"));
    h.record(log("a"));
    expect(h.canBack()).toBe(false);
    h.record(log("b"));
    h.record(log("b"));
    expect(h.back()).toEqual(log("a"));
    expect(h.back()).toBeNull();
  });

  it("a new location after going back drops the forward stack", () => {
    const h = createNavHistory();
    h.record(log("a"));
    h.record(log("b"));
    h.back();
    expect(h.canForward()).toBe(true);
    h.record(log("c"));
    expect(h.canForward()).toBe(false);
    expect(h.back()).toEqual(log("a"));
  });

  it("recording the location that back returned changes nothing", () => {
    const h = createNavHistory();
    h.record(log("a"));
    h.record(log("b"));
    h.back();
    h.record(log("a"));
    expect(h.canForward()).toBe(true);
    expect(h.forward()).toEqual(log("b"));
  });

  it("keeps at most NAV_LIMIT locations on the back stack", () => {
    const h = createNavHistory();
    for (let i = 0; i < NAV_LIMIT + 50; i++) h.record(log(`c${i}`));
    let steps = 0;
    let last: NavLocation | null = null;
    for (let t = h.back(); t; t = h.back()) {
      steps++;
      last = t;
    }
    expect(steps).toBe(NAV_LIMIT);
    expect(last).toEqual(log("c49"));
  });

  it("caps the forward stack as well", () => {
    const h = createNavHistory(3);
    for (let i = 0; i < 10; i++) h.record(log(`c${i}`));
    while (h.back());
    let steps = 0;
    while (h.forward()) steps++;
    expect(steps).toBe(3);
  });

  it("skips and drops locations that are not valid any more", () => {
    const h = createNavHistory();
    h.record(log("a"));
    h.record(log("gone"));
    h.record(log("b"));
    const valid = (l: NavLocation) => l.commit?.oid !== "gone";
    expect(h.back(valid)).toEqual(log("a"));
    expect(h.forward(valid)).toEqual(log("b"));
    expect(h.back(valid)).toEqual(log("a"));
    expect(h.back(valid)).toBeNull();
    expect(h.current()).toEqual(log("a"));
  });

  it("a back with only dead locations keeps the current one", () => {
    const h = createNavHistory();
    h.record(log("gone"));
    h.record(log("b"));
    expect(h.back(() => false)).toBeNull();
    expect(h.current()).toEqual(log("b"));
    expect(h.canBack()).toBe(false);
  });

  it("settle replaces the current location only", () => {
    const h = createNavHistory();
    h.record(log("a"));
    h.record(log());
    h.settle(log("z"));
    expect(h.current()).toEqual(log("z"));
    expect(h.back()).toEqual(log("a"));
  });

  it("clear forgets everything", () => {
    const h = createNavHistory();
    h.record(log("a"));
    h.record(log("b"));
    h.clear();
    expect(h.current()).toBeNull();
    expect(h.canBack()).toBe(false);
    expect(h.canForward()).toBe(false);
  });
});
