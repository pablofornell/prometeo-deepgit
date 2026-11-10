// @vitest-environment node
// The mock must refuse what the backend refuses: merge options, sign-off and clone (crates/gitcore tests mirror these).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockInvoke, mockListen } from "./mock";
import type { CloneProgress, CloneResult, CommitRow, ConsoleEntry, LogSessionInfo, MergeOpts, OpResult, RepoSummary, Workspace, WorkingTree } from "./types";

const call = <T>(cmd: string, args?: Record<string, unknown>) => mockInvoke(cmd, args) as Promise<T>;
const merge = (repoId: string, target: string, opts: Partial<MergeOpts> = {}) => call<OpResult>("merge", { repoId, target, opts });

async function repoIds(): Promise<string[]> {
  const ws = await call<Workspace>("workspace_load");
  return (ws.projects.find((p) => p.name === "payments-platform") as { repos: { id: string }[] }).repos.map((r) => r.id);
}

async function summaryOf(repoId: string): Promise<RepoSummary> {
  return (await call<RepoSummary[]>("repo_summaries", { repoIds: [repoId] }))[0];
}

async function topCommit(repoId: string): Promise<CommitRow> {
  const info = await call<LogSessionInfo>("log_open", { query: { repoIds: [repoId], refs: [] } });
  return (await call<CommitRow[]>("log_rows", { sessionId: info.sessionId, start: 0, count: 1 }))[0];
}

/** A branch `side` that is one commit ahead of main; the repo is back on main. With `diverge`, main has a commit of its own too. */
async function sideBranch(repoId: string, diverge: boolean, name = "side"): Promise<void> {
  await call("branch_create", { repoId, name, startPoint: "main", checkout: true });
  await call("revert", { repoId, oid: "HEAD" });
  await call("checkout", { repoId, target: "main" });
  if (diverge) await call("revert", { repoId, oid: "HEAD" });
}

describe("mock merge", () => {
  it("fast-forwards by default and with ffOnly when it can", async () => {
    const [, , refunds] = await repoIds();
    await sideBranch(refunds, false, "ff-side");
    const side = (await call<{ local: { name: string; oid: string }[] }>("refs", { repoId: refunds })).local.find((b) => b.name === "ff-side")?.oid;
    const r = await merge(refunds, "ff-side", { mode: "ffOnly" });
    expect(r).toMatchObject({ ok: true, message: "Fast-forward" });
    expect((await call<{ local: { name: string; oid: string }[] }>("refs", { repoId: refunds })).local.find((b) => b.name === "main")?.oid).toBe(side);
  });

  it("noFf makes a merge commit even when it could fast-forward, with the message", async () => {
    const [, , , , shared] = await repoIds();
    await sideBranch(shared, false);
    const r = await merge(shared, "side", { mode: "noFf", message: "Bring in side\n\nwith a body" });
    expect(r.ok).toBe(true);
    const top = await topCommit(shared);
    expect(top.parents).toHaveLength(2);
    expect(top.subject).toBe("Bring in side");
    expect(await call<string>("last_commit_message", { repoId: shared })).toBe("Bring in side\n\nwith a body");
  });

  it("uses git's default subject for a blank message", async () => {
    const [, , , web] = await repoIds();
    await sideBranch(web, true);
    await merge(web, "side", { message: "  " });
    // git leaves " into <branch>" out when the branch is main or master
    expect((await topCommit(web)).subject).toBe("Merge branch 'side'");
  });

  it("does not fast-forward with --no-commit: the branch stays, the merge waits for its commit, and abort undoes it", async () => {
    const [, , refunds] = await repoIds();
    await sideBranch(refunds, false, "nc-side");
    const before = (await summaryOf(refunds)).headOid;
    const seen: ConsoleEntry[] = [];
    const off = mockListen("git-console", (p) => seen.push(p as ConsoleEntry));
    const r = await merge(refunds, "nc-side", { mode: "ff", noCommit: true });
    off();
    expect(r.ok).toBe(true);
    expect(seen.find((e) => e.args[0] === "merge")?.args).toEqual(["merge", "--no-edit", "--no-ff", "--no-commit", "--end-of-options", "nc-side"]);
    const mid = await summaryOf(refunds);
    expect(mid).toMatchObject({ state: "merging", headOid: before });
    expect(mid.staged).toBeGreaterThan(0);
    await call("op_abort", { repoId: refunds });
    expect(await summaryOf(refunds)).toMatchObject({ state: "clean", headOid: before, staged: 0 });
  });

  it("refuses fast-forward only on diverged branches with a clear error, and changes nothing", async () => {
    const [api] = await repoIds();
    await sideBranch(api, true);
    const before = (await summaryOf(api)).headOid;
    await expect(merge(api, "side", { mode: "ffOnly" })).rejects.toMatchObject({
      message: "Cannot fast-forward: the branches have diverged. Choose another merge mode.",
      detail: expect.stringContaining("Not possible to fast-forward"),
    });
    expect((await summaryOf(api)).headOid).toBe(before);
  });

  it("squash stages the changes and leaves the head and the state alone", async () => {
    const [, ledger, refunds] = await repoIds();
    expect(ledger).toBeDefined();
    await sideBranch(refunds, true);
    const before = await summaryOf(refunds);
    expect(before.state).toBe("clean");
    const r = await merge(refunds, "side", { mode: "squash" });
    expect(r.ok).toBe(true);
    const after = await summaryOf(refunds);
    expect(after.headOid).toBe(before.headOid);
    expect(after.state).toBe("clean");
    expect(after.staged).toBeGreaterThan(0);
  });

  it("--no-commit stops in the merging state; the commit box finishes it with two parents", async () => {
    const [, , , , shared] = await repoIds();
    // shared-proto has `side` from the noFf test; make a new diverged one
    await call("branch_create", { repoId: shared, name: "side2", startPoint: "main", checkout: true });
    await call("revert", { repoId: shared, oid: "HEAD" });
    await call("checkout", { repoId: shared, target: "main" });
    await call("revert", { repoId: shared, oid: "HEAD" });
    const before = (await summaryOf(shared)).headOid;
    const r = await merge(shared, "side2", { noCommit: true });
    expect(r.ok).toBe(true);
    const mid = await summaryOf(shared);
    expect(mid).toMatchObject({ state: "merging", headOid: before });
    expect(mid.staged).toBeGreaterThan(0);
    const done = await call<OpResult>("commit", { repoId: shared, message: "Finish the merge", amend: false });
    expect(done.ok).toBe(true);
    expect((await topCommit(shared)).parents).toHaveLength(2);
    expect((await summaryOf(shared)).state).toBe("clean");
  });

  it("refuses the option mixes the backend refuses, before touching the repo", async () => {
    const [api] = await repoIds();
    const before = (await summaryOf(api)).headOid;
    await expect(merge(api, "side", { mode: "ffOnly", message: "m" })).rejects.toMatchObject({ message: expect.stringContaining("needs a merge commit") });
    await expect(merge(api, "side", { mode: "squash", message: "m" })).rejects.toMatchObject({ message: expect.stringContaining("needs a merge commit") });
    await expect(merge(api, "side", { noCommit: true, message: "m" })).rejects.toMatchObject({ message: expect.stringContaining("--no-commit") });
    await expect(merge(api, "side", { mode: "ffOnly", noCommit: true })).rejects.toMatchObject({ message: "--no-commit cannot be used with fast-forward only or squash." });
    await expect(merge(api, "side", { mode: "squash", noCommit: true })).rejects.toMatchObject({ message: expect.stringContaining("--no-commit") });
    await expect(merge(api, "--abort")).rejects.toMatchObject({ message: expect.stringContaining("cannot start with '-'") });
    await expect(call("merge", { repoId: api, target: "side", opts: { mode: "rebase" } })).rejects.toMatchObject({ message: expect.stringContaining("unknown variant") });
    expect((await summaryOf(api)).headOid).toBe(before);
  });

  it("puts the options in the console entry like the backend arguments", async () => {
    const [, , , web] = await repoIds();
    await sideBranch(web, true, "console-side");
    const seen: ConsoleEntry[] = [];
    const off = mockListen("git-console", (p) => seen.push(p as ConsoleEntry));
    await merge(web, "console-side", { mode: "noFf", message: "x y", allowUnrelatedHistories: true });
    off();
    const entry = seen.find((e) => e.args[0] === "merge");
    expect(entry?.args).toEqual(["merge", "--no-edit", "--no-ff", "--allow-unrelated-histories", "-m", "x y", "--end-of-options", "console-side"]);
  });
});

describe("mock sign-off", () => {
  const SIGNOFF = "Signed-off-by: Lucía Martín <lucia.martin@acme.dev>";
  const count = (text: string) => text.split("\n").filter((l) => l.trimEnd() === SIGNOFF).length;

  it("adds the trailer once, on commit and on amend", async () => {
    const [, , , web] = await repoIds();
    const wt = await call<WorkingTree>("working_tree", { repoId: web });
    await call("stage", { repoId: web, paths: wt.unstaged.map((f) => f.path) });
    await call<OpResult>("commit", { repoId: web, message: "Add tests\n\nBody", amend: false, signOff: true });
    expect(await call<string>("last_commit_message", { repoId: web })).toBe(`Add tests\n\nBody\n\n${SIGNOFF}`);
    // `--amend --no-edit --signoff` again: not twice
    await call("commit", { repoId: web, message: "", amend: true, signOff: true });
    expect(count(await call<string>("last_commit_message", { repoId: web }))).toBe(1);
    // a sign-off followed by another trailer stays single, a new message gets one
    await call("commit", { repoId: web, message: `x\n\n${SIGNOFF}\nCo-authored-by: Ann <ann@x.org>`, amend: true, signOff: true });
    expect(count(await call<string>("last_commit_message", { repoId: web }))).toBe(1);
    await call("commit", { repoId: web, message: "plain", amend: true, signOff: true });
    expect(await call<string>("last_commit_message", { repoId: web })).toBe(`plain\n\n${SIGNOFF}`);
    // without the flag nothing is added
    await call("commit", { repoId: web, message: "plain again", amend: true });
    expect(await call<string>("last_commit_message", { repoId: web })).toBe("plain again");
  });
});

describe("mock clone", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const opts = { branch: null, depth: null, recurseSubmodules: false };
  const clone = (extra: Record<string, unknown>) =>
    call<CloneResult>("clone_repo", { operationId: "op-" + Math.random(), url: "https://github.com/acme/widgets.git", parentDir: "~/work/payments-platform", dirName: "widgets", opts, target: { kind: "newProject" }, ...extra });
  /** Runs the promise to its end while the fake clock moves. */
  const settle = async <T>(p: Promise<T>): Promise<T> => {
    const guarded = p.then(
      (v) => ({ v }),
      (e) => ({ e }),
    );
    await vi.advanceTimersByTimeAsync(8000);
    const r = await guarded;
    if ("e" in r) throw r.e;
    return r.v;
  };

  it("refuses bad input like the backend, without starting", async () => {
    const bad = async (extra: Record<string, unknown>, message: string) => {
      const p = clone(extra);
      p.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(500);
      await expect(p).rejects.toMatchObject({ message: expect.stringContaining(message) });
    };
    await bad({ url: "" }, "Enter the URL");
    await bad({ url: "--upload-pack=x" }, "cannot start with '-'");
    await bad({ url: "ext::sh -c id" }, "runs commands");
    await bad({ dirName: "../x" }, "cannot contain");
    await bad({ dirName: "a/b" }, "cannot contain");
    await bad({ parentDir: "relative/dir" }, "absolute");
    await bad({ parentDir: "/srv/missing/work" }, "does not exist");
    await bad({ opts: { ...opts, depth: 0 } }, "at least 1");
    await bad({ opts: { ...opts, branch: "-x" } }, "cannot start with '-'");
    await bad({ dirName: "api-gateway", parentDir: "~/work/payments-platform" }, "not empty");
    await bad({ target: { kind: "project", projectId: "p-deepgit" }, parentDir: "~/elsewhere" }, "outside the project folder");
  });

  it("emits progress, adds a repo to the project and logs the clone without a repo", async () => {
    const events: CloneProgress[] = [];
    const entries: ConsoleEntry[] = [];
    const off1 = mockListen("clone-progress", (p) => events.push(p as CloneProgress));
    const off2 = mockListen("git-console", (p) => entries.push(p as ConsoleEntry));
    const result = await settle(clone({ operationId: "op-a", dirName: "widgets", target: { kind: "project", projectId: "p-payments" }, opts: { ...opts, branch: "dev", depth: 1 } }));
    off1();
    off2();
    expect(result.createdProject).toBe(false);
    expect(result.path).toBe("~/work/payments-platform/widgets");
    expect(result.project.repos.map((r) => r.name)).toContain("widgets");
    expect(events.every((e) => e.operationId === "op-a")).toBe(true);
    expect(events.map((e) => e.phase)).toEqual(expect.arrayContaining(["Counting objects", "Receiving objects", "Resolving deltas"]));
    expect(events.at(-1)).toMatchObject({ phase: "Updating files", percent: 100 });
    const entry = entries.find((e) => e.args[0] === "clone");
    expect(entry).toMatchObject({ repoId: null, exitCode: 0 });
    expect(entry?.args).toEqual(["clone", "--progress", "--branch", "dev", "--depth", "1", "--", "https://github.com/acme/widgets.git", "~/work/payments-platform/widgets"]);
    // the repo is usable
    const id = result.project.repos.find((r) => r.name === "widgets")?.id as string;
    expect((await settle(call<RepoSummary[]>("repo_summaries", { repoIds: [id] })))[0].repoId).toBe(id);
    // the same folder again: not empty now
    const again = clone({ dirName: "widgets" });
    again.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(500);
    await expect(again).rejects.toMatchObject({ message: expect.stringContaining("already exists and is not empty") });
  });

  it("makes a new project for the clone", async () => {
    const result = await settle(clone({ dirName: "gadgets", parentDir: "~/elsewhere/", url: "git@github.com:acme/gadgets.git" }));
    expect(result.createdProject).toBe(true);
    expect(result.project).toMatchObject({ name: "gadgets", path: "~/elsewhere/gadgets" });
    expect(result.project.repos).toHaveLength(1);
    const ws = await settle(call<Workspace>("workspace_load"));
    expect(ws.projects.some((p) => p.id === result.project.id)).toBe(true);
  });

  it("fails like a missing remote repository", async () => {
    await expect(settle(clone({ dirName: "nope", url: "https://github.com/acme/does-not-exist.git" }))).rejects.toMatchObject({ message: expect.stringContaining("does not exist") });
    const ws = await settle(call<Workspace>("workspace_load"));
    expect(ws.projects.some((p) => p.path.endsWith("/nope"))).toBe(false);
  });

  it("can be cancelled and then leaves nothing", async () => {
    const events: CloneProgress[] = [];
    const off = mockListen("clone-progress", (p) => events.push(p as CloneProgress));
    const p = clone({ operationId: "op-cancel", dirName: "cancelled" });
    p.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(600);
    expect(events.length).toBeGreaterThan(0);
    await settle(call("clone_cancel", { operationId: "op-cancel" }));
    await vi.advanceTimersByTimeAsync(500);
    await expect(p).rejects.toMatchObject({ message: "The operation was cancelled." });
    off();
    const ws = await settle(call<Workspace>("workspace_load"));
    expect(ws.projects.some((x) => x.path.endsWith("/cancelled"))).toBe(false);
    // the same folder can be cloned again
    const again = await settle(clone({ operationId: "op-cancel-2", dirName: "cancelled" }));
    expect(again.path.endsWith("/cancelled")).toBe(true);
  });

  it("ends a clone at once when its cancel came first, once, like `begin_clone`", async () => {
    await settle(call("clone_cancel", { operationId: "op-early" }));
    const events: CloneProgress[] = [];
    const off = mockListen("clone-progress", (p) => events.push(p as CloneProgress));
    await expect(settle(clone({ operationId: "op-early", dirName: "early" }))).rejects.toMatchObject({ message: "The operation was cancelled." });
    off();
    expect(events).toEqual([]);
    const ws = await settle(call<Workspace>("workspace_load"));
    expect(ws.projects.some((x) => x.path.endsWith("/early"))).toBe(false);
    // the remembered cancel is used up; other ids were never affected
    const again = await settle(clone({ operationId: "op-early", dirName: "early" }));
    expect(again.path.endsWith("/early")).toBe(true);
    // a cancel older than a minute is forgotten
    await settle(call("clone_cancel", { operationId: "op-stale" }));
    await vi.advanceTimersByTimeAsync(61_000);
    expect((await settle(clone({ operationId: "op-stale", dirName: "stale" }))).path.endsWith("/stale")).toBe(true);
  });

  it("refuses before cloning a folder that a rescan of the project would skip", async () => {
    const into = (parentDir: string, dirName = "found") => clone({ target: { kind: "project", projectId: "p-payments" }, parentDir, dirName });
    const refused = async (parentDir: string, dirName: string | undefined, message: string) => {
      const p = into(parentDir, dirName);
      p.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(500);
      await expect(p).rejects.toMatchObject({ message: expect.stringContaining(message) });
    };
    const root = "~/work/payments-platform";
    await refused(`${root}/node_modules`, undefined, 'skips folders named "node_modules"');
    await refused(`${root}/.hidden`, undefined, 'skips folders named ".hidden"');
    await refused(root, ".dotclone", 'skips folders named ".dotclone"');
    await refused(`${root}/a/b/c/d`, undefined, "5 levels below");
    const ws = await settle(call<Workspace>("workspace_load"));
    expect(ws.projects.flatMap((p) => p.repos).some((r) => r.name === "found")).toBe(false);
    // 4 levels deep is found again
    const ok = await settle(into(`${root}/a/b/c`, "deep"));
    expect(ok.project.repos.map((r) => r.name)).toContain("a/b/c/deep");
    // the same folder for a new project has no such limit
    const alone = await settle(clone({ parentDir: `${root}/node_modules`, dirName: "alone" }));
    expect(alone.createdProject).toBe(true);
  });

  it("refuses a second clone into a folder that a running clone uses", async () => {
    const first = clone({ operationId: "op-t1", dirName: "twin" });
    first.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(400);
    const second = clone({ operationId: "op-t2", dirName: "twin" });
    second.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(300);
    await expect(second).rejects.toMatchObject({ message: expect.stringContaining("Another clone into ~/work/payments-platform/twin is already running.") });
    await settle(first);
  });

  it("refuses a second clone with the same operation id while it runs", async () => {
    const first = clone({ operationId: "op-dup", dirName: "dup1" });
    first.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(400);
    const second = clone({ operationId: "op-dup", dirName: "dup2" });
    second.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(300);
    await expect(second).rejects.toMatchObject({ message: "This clone is already running." });
    await settle(first);
  });
});

describe("mock console background flag", () => {
  it("tags a fetch run with `background` (also when it fails fast), and nothing else", async () => {
    const [api, , , , , docs] = await repoIds();
    const seen: ConsoleEntry[] = [];
    const off = mockListen("git-console", (p) => seen.push(p as ConsoleEntry));
    try {
      await call("fetch", { repoId: api, remote: null, prune: true, background: true });
      await call("fetch", { repoId: api, remote: null, prune: true });
      await call("working_tree", { repoId: api });
      // docs-site needs a login: the background fetch fails fast, and its console entry is still a background one
      await expect(call("fetch", { repoId: docs, remote: null, prune: false, background: true })).rejects.toBeDefined();
    } finally {
      off();
    }
    const fetches = seen.filter((e) => e.args[0] === "fetch");
    expect(fetches.map((e) => e.background)).toEqual([true, false, true]);
    expect(seen.filter((e) => e.args[0] !== "fetch").every((e) => e.background === false)).toBe(true);
  });
});
