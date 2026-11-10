// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { ConsoleEntry } from "../api/types";
import { clearConsole, isBackgroundEntry, markBackgroundFetch, pushConsoleEntry, splitGitArgs } from "./console";

const entry = (...args: string[]): ConsoleEntry => ({ args }) as unknown as ConsoleEntry;
const bg = (...args: string[]) => isBackgroundEntry(entry(...args));

describe("splitGitArgs", () => {
  it("skips global options, -c pairs and -C dirs", () => {
    expect(splitGitArgs(["--literal-pathspecs", "diff", "-U3", "--", "a"])).toEqual({ sub: "diff", rest: ["-U3", "--", "a"] });
    expect(splitGitArgs(["-c", "core.x=y", "commit", "-F", "-"]).sub).toBe("commit");
    expect(splitGitArgs(["--no-pager", "-C", "/tmp/r", "-c", "a=b", "status"]).sub).toBe("status");
    expect(splitGitArgs([])).toEqual({ sub: "", rest: [] });
  });
});

describe("isBackgroundEntry", () => {
  it("treats reads with global options as background", () => {
    expect(bg("--literal-pathspecs", "diff", "-U3", "--", "a")).toBe(true);
    expect(bg("--no-pager", "stash", "list", "-z", "--format=%H")).toBe(true);
    expect(bg("--no-optional-locks", "submodule", "status")).toBe(true);
    expect(bg("-c", "core.quotepath=off", "status", "--porcelain=v2", "-z")).toBe(true);
    expect(bg("log", "--format=x")).toBe(true);
    expect(bg("for-each-ref")).toBe(true);
    expect(bg("config", "--get", "user.name")).toBe(true);
    expect(bg("stash", "show", "-p", "stash@{0}")).toBe(true);
    expect(bg("apply", "--check", "p.patch")).toBe(true);
    expect(bg("remote")).toBe(true);
    expect(bg("remote", "-v")).toBe(true);
    expect(bg()).toBe(true);
  });
  it("treats writes as user commands, whatever precedes them", () => {
    expect(bg("-c", "core.x=y", "commit", "-F", "-")).toBe(false);
    expect(bg("--no-pager", "push", "origin", "main")).toBe(false);
    for (const sub of ["checkout", "switch", "merge", "rebase", "cherry-pick", "revert", "reset", "fetch", "pull", "add", "restore", "rm", "clean"]) {
      expect(bg("-c", "a=b", sub, "x")).toBe(false);
    }
    expect(bg("apply", "--cached", "-")).toBe(false);
    expect(bg("stash", "push", "-m", "wip")).toBe(false);
    expect(bg("stash", "pop", "stash@{0}")).toBe(false);
    expect(bg("stash")).toBe(false);
    expect(bg("submodule", "update", "--init")).toBe(false);
    expect(bg("remote", "add", "up", "url")).toBe(false);
    expect(bg("remote", "remove", "up")).toBe(false);
  });
  it("classifies tag and branch by form", () => {
    expect(bg("tag")).toBe(true);
    expect(bg("tag", "-l")).toBe(true);
    expect(bg("tag", "--contains", "abc")).toBe(true);
    expect(bg("tag", "v1.0", "abc")).toBe(false);
    expect(bg("tag", "-d", "v1.0")).toBe(false);
    expect(bg("tag", "-a", "v1", "-m", "msg")).toBe(false);
    expect(bg("branch")).toBe(true);
    expect(bg("branch", "-a", "-vv")).toBe(true);
    expect(bg("branch", "--contains", "abc")).toBe(true);
    expect(bg("branch", "--show-current")).toBe(true);
    expect(bg("branch", "new", "abc")).toBe(false);
    expect(bg("branch", "-D", "x")).toBe(false);
    expect(bg("branch", "-m", "a", "b")).toBe(false);
    expect(bg("branch", "-M", "a", "b")).toBe(false);
    expect(bg("branch", "--delete", "x")).toBe(false);
    expect(bg("branch", "--set-upstream-to=origin/x")).toBe(false);
  });
});

describe("clone and background fetch", () => {
  it("shows a clone as a user command", () => {
    expect(bg("clone", "--progress", "--", "https://h/r.git", "/work/r")).toBe(false);
  });

  it("classifies the fetch entries of a repo with a background fetch running as background, once and for good", () => {
    const e = (id: number, repoId: string, ...args: string[]): ConsoleEntry => ({ id, repoId, args, startedAt: 0, durationMs: 1, exitCode: 0, stdout: "", stderr: "" });
    vi.useFakeTimers();
    try {
      const release = markBackgroundFetch(["a"]);
      const auto = e(1, "a", "fetch", "--all", "--prune");
      const otherRepo = e(2, "b", "fetch", "--all");
      const read = e(3, "a", "log", "-1");
      pushConsoleEntry(auto);
      pushConsoleEntry(otherRepo);
      pushConsoleEntry(read);
      expect(isBackgroundEntry(auto)).toBe(true);
      expect(isBackgroundEntry(otherRepo)).toBe(false);
      release();
      // the entry may arrive just after the reply: the mark lasts a moment
      vi.advanceTimersByTime(1000);
      const late = e(4, "a", "fetch", "--all");
      pushConsoleEntry(late);
      expect(isBackgroundEntry(late)).toBe(true);
      vi.advanceTimersByTime(2000);
      const user = e(5, "a", "fetch", "origin");
      pushConsoleEntry(user);
      expect(isBackgroundEntry(user)).toBe(false);
      // the earlier verdict does not change
      expect(isBackgroundEntry(auto)).toBe(true);
    } finally {
      clearConsole();
      vi.useRealTimers();
    }
  });
});
