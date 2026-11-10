// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { LocalBranch, Refs, RemoteBranch } from "../api/types";
import { remoteCounterpart, splitRemoteRef, splitRemoteRefLoose } from "./remoteRefs";

const rb = (remote: string, name: string): RemoteBranch => ({ remote, name, fullName: `${remote}/${name}`, oid: "a".repeat(40) });
const lb = (name: string, upstream: string | null): LocalBranch => ({ name, oid: "a".repeat(40), upstream, ahead: 0, behind: 0, isHead: false, gone: false });
const refs = (local: LocalBranch[], remote: RemoteBranch[], remotes: string[] = ["origin"]): Pick<Refs, "local" | "remote" | "remotes"> => ({
  local, remote, remotes: remotes.map((name) => ({ name, url: "" })),
});

describe("splitRemoteRef", () => {
  it("uses the remote of the matching remote branch, even when it contains a slash", () => {
    const r = refs([], [rb("team/fork", "main"), rb("origin", "x/y")], ["origin", "team/fork"]);
    expect(splitRemoteRef("team/fork/main", r)).toEqual({ remote: "team/fork", branch: "main" });
    expect(splitRemoteRef("origin/x/y", r)).toEqual({ remote: "origin", branch: "x/y" });
  });
  it("falls back to the longest configured remote name", () => {
    const r = refs([], [], ["team", "team/fork"]);
    expect(splitRemoteRef("team/fork/feat/a", r)).toEqual({ remote: "team/fork", branch: "feat/a" });
    expect(splitRemoteRef("team/other", r)).toEqual({ remote: "team", branch: "other" });
    expect(splitRemoteRef("nope/main", r)).toBeNull();
  });
  it("the loose variant guesses the first segment only while no remotes are known", () => {
    expect(splitRemoteRefLoose("origin/main", undefined)).toEqual({ remote: "origin", branch: "main" });
    expect(splitRemoteRefLoose("nope/main", refs([], [], ["origin"]))).toBeNull();
  });
});

describe("remoteCounterpart", () => {
  it("is the upstream when it has the branch's own name", () => {
    const r = refs([lb("feature", "origin/feature")], [rb("origin", "feature"), rb("origin", "develop")]);
    expect(remoteCounterpart(r, "feature")).toBe("origin/feature");
  });
  it("never is a differently named upstream (feature tracking origin/develop)", () => {
    const r = refs([lb("feature", "origin/develop")], [rb("origin", "develop")]);
    expect(remoteCounterpart(r, "feature")).toBeUndefined();
  });
  it("falls back to origin/<name> only when that remote branch exists", () => {
    const r = refs([lb("feature", "origin/develop")], [rb("origin", "develop"), rb("origin", "feature")]);
    expect(remoteCounterpart(r, "feature")).toBe("origin/feature");
    expect(remoteCounterpart(refs([lb("topic", null)], [rb("origin", "main")]), "topic")).toBeUndefined();
  });
  it("does not pick another remote's branch of the same name as a fallback", () => {
    expect(remoteCounterpart(refs([lb("feature", null)], [rb("fork", "feature")], ["origin", "fork"]), "feature")).toBeUndefined();
  });
  it("keeps an upstream on a remote with a slash in its name", () => {
    const r = refs([lb("a/b", "team/fork/a/b")], [rb("team/fork", "a/b")], ["origin", "team/fork"]);
    expect(remoteCounterpart(r, "a/b")).toBe("team/fork/a/b");
  });
  it("ignores an upstream whose remote branch is gone", () => {
    expect(remoteCounterpart(refs([lb("feature", "origin/feature")], []), "feature")).toBeUndefined();
  });
  it("is undefined while the refs are not loaded", () => {
    expect(remoteCounterpart(undefined, "feature")).toBeUndefined();
  });
});
