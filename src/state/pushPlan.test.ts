// @vitest-environment node
import { describe, expect, it } from "vitest";
import { planPush, remoteOfUpstream, type PushRepoState, type PushRequest } from "./pushPlan";

const req = (o: Partial<PushRequest> = {}): PushRequest => ({ remote: null, branch: null, force: false, setUpstream: false, tags: false, ...o });
const repo = (o: Partial<PushRepoState> = {}): PushRepoState => ({ branch: "main", upstream: "origin/main", ahead: 2, ...o });

describe("planPush", () => {
  it("pushes each repo's own current branch when none is given", () => {
    expect(planPush(repo({ branch: "feature/a" }), req()).branch).toBe("feature/a");
    expect(planPush(repo({ branch: "main" }), req()).branch).toBe("main");
  });
  it("skips detached repos with a reason", () => {
    const p = planPush(repo({ branch: null, upstream: null }), req());
    expect(p.skip).toMatch(/detached/);
    expect(p.branch).toBeNull();
  });
  it("sets the upstream of a branch that has none and never calls it 'nothing to push'", () => {
    const p = planPush(repo({ branch: "new", upstream: null, ahead: 0 }), req());
    expect(p).toMatchObject({ skip: null, branch: "new", setUpstream: true });
  });
  it("skips a tracked branch with nothing ahead, unless force or tags", () => {
    expect(planPush(repo({ ahead: 0 }), req()).skip).toBe("nothing to push");
    expect(planPush(repo({ ahead: 0 }), req({ force: true })).skip).toBeNull();
    expect(planPush(repo({ ahead: 0 }), req({ tags: true })).skip).toBeNull();
    expect(planPush(repo({ ahead: 0 }), req()).setUpstream).toBe(false);
  });
  it("takes the remote from the upstream when none is chosen", () => {
    expect(planPush(repo({ upstream: "fork/main" }), req()).remote).toBe("fork");
    expect(planPush(repo({ upstream: "fork/main" }), req({ remote: "origin" })).remote).toBe("origin");
    expect(remoteOfUpstream(null)).toBeNull();
  });
  it("judges a non-HEAD branch by its own ahead/upstream, not HEAD's", () => {
    const local = [
      { name: "main", upstream: "origin/main", ahead: 0 },
      { name: "topic", upstream: "origin/topic", ahead: 3 },
      { name: "fresh", upstream: null, ahead: 0 },
    ];
    // HEAD (main) has nothing ahead, but `topic` does
    const topic = planPush(repo({ ahead: 0, local }), req({ branch: "topic" }));
    expect(topic).toMatchObject({ skip: null, branch: "topic", ahead: 3 });
    // HEAD is ahead, the requested branch is not
    expect(planPush(repo({ ahead: 5, branch: "main", local: [{ name: "topic", upstream: "origin/topic", ahead: 0 }] }), req({ branch: "topic" })).skip).toBe("nothing to push");
    // HEAD tracks something, `fresh` does not: never skipped, upstream set
    expect(planPush(repo({ ahead: 0, local }), req({ branch: "fresh" }))).toMatchObject({ skip: null, setUpstream: true });
  });
  it("does not skip a branch it knows nothing about", () => {
    expect(planPush(repo({ ahead: 0 }), req({ branch: "ghost" })).skip).toBeNull();
  });
  it("takes the remote from a remote name with a slash (team/fork)", () => {
    const refs = { remote: [{ remote: "team/fork", name: "main", fullName: "team/fork/main", oid: "a" }], remotes: [{ name: "origin", url: "" }, { name: "team/fork", url: "" }] };
    expect(planPush(repo({ upstream: "team/fork/main", refs }), req())).toMatchObject({ remote: "team/fork", target: "team/fork/main", retargetedFrom: null, upstream: "team/fork/main" });
    expect(remoteOfUpstream("team/fork/main", refs)).toBe("team/fork");
    expect(remoteOfUpstream("team/fork/feat/x", { remote: [], remotes: refs.remotes })).toBe("team/fork");
  });
  it("a branch whose upstream has another name goes to <remote>/<branch> with -u, never to the upstream", () => {
    const refs = { remote: [{ remote: "origin", name: "main", fullName: "origin/main", oid: "a" }], remotes: [{ name: "origin", url: "" }] };
    const p = planPush(repo({ branch: "myfix", upstream: "origin/main", ahead: 0, refs }), req());
    expect(p).toMatchObject({ skip: null, branch: "myfix", remote: "origin", setUpstream: true, upstream: null, retargetedFrom: "origin/main", target: "origin/myfix", targetExists: false, ahead: 0 });
  });
  it("never skips such a branch as 'nothing to push', and notes when the target exists", () => {
    const refs = { remote: [{ remote: "origin", name: "myfix", fullName: "origin/myfix", oid: "a" }], remotes: [{ name: "origin", url: "" }] };
    const local = [{ name: "myfix", upstream: "origin/main", ahead: 0 }];
    const p = planPush(repo({ branch: "main", upstream: "origin/main", ahead: 0, local, refs }), req({ branch: "myfix" }));
    expect(p).toMatchObject({ skip: null, retargetedFrom: "origin/main", setUpstream: true, targetExists: true });
  });
  it("keeps the explicitly chosen remote for a retargeted branch", () => {
    const p = planPush(repo({ branch: "myfix", upstream: "origin/main" }), req({ remote: "fork" }));
    expect(p).toMatchObject({ remote: "fork", target: "fork/myfix", retargetedFrom: "origin/main" });
  });
  it("a same-named upstream on a slash remote is not retargeted", () => {
    const refs = { remote: [], remotes: [{ name: "team/fork", url: "" }] };
    expect(planPush(repo({ branch: "feat/x", upstream: "team/fork/feat/x", ahead: 1, refs }), req())).toMatchObject({ retargetedFrom: null, remote: "team/fork", setUpstream: false });
  });
});
