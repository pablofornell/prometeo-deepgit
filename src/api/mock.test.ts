// @vitest-environment node
import { describe, expect, it } from "vitest";
import { mockInvoke, mockListen } from "./mock";
import type { CommitRow, ConsoleEntry, FileDiff, LogSessionInfo, OpResult, RepoSummary, Workspace, WorkingTree } from "./types";

const call = <T>(cmd: string, args?: Record<string, unknown>) => mockInvoke(cmd, args) as Promise<T>;

async function setup() {
  const ws = await call<Workspace>("workspace_load");
  const project = ws.projects.find((p) => p.name === "payments-platform");
  if (!project) throw new Error("project missing");
  return { ws, project, ids: project.repos.map((r) => r.id) };
}

describe("mock backend", () => {
  it("has the payments-platform project with 6 repos and a single-repo deepgit project", async () => {
    const { ws, project } = await setup();
    expect(project.repos.map((r) => r.name)).toEqual(["api-gateway", "ledger-service", "refunds-worker", "web-checkout", "shared-proto", "docs-site"]);
    expect(ws.projects.find((p) => p.name === "deepgit")?.repos).toHaveLength(1);
    expect(ws.activeProjectId).toBe(project.id);
  });

  it("opens a combined log with thousands of commits, a valid graph and refs", async () => {
    const { ids } = await setup();
    const info = await call<LogSessionInfo>("log_open", { query: { repoIds: ids, refs: [] } });
    expect(info.total).toBeGreaterThan(10000);
    expect(info.maxLanes).toBeGreaterThan(3);
    const rows = await call<CommitRow[]>("log_rows", { sessionId: info.sessionId, start: 0, count: 200 });
    expect(rows).toHaveLength(200);
    // committer time never increases down the list (k-way merge)
    for (let i = 1; i < rows.length; i++) expect(rows[i].committerTime).toBeLessThanOrEqual(rows[i - 1].committerTime);
    expect(rows.some((r) => r.refs.length > 0)).toBe(true);
    for (const r of rows) {
      expect(r.graph.node).toBeLessThan(r.graph.width);
      for (const s of r.graph.segments) expect(Math.max(s.x1, s.x2)).toBeLessThan(r.graph.width);
    }
    // a merge commit exists in the first big page
    const page = await call<CommitRow[]>("log_rows", { sessionId: info.sessionId, start: 500, count: 500 });
    expect(page.some((r) => r.parents.length > 1)).toBe(true);
    const idx = await call<number | null>("log_find", { sessionId: info.sessionId, oid: page[3].oid.slice(0, 8) });
    expect(idx).toBe(503);
  });

  it("filters the log by text and author", async () => {
    const { ids } = await setup();
    const info = await call<LogSessionInfo>("log_open", { query: { repoIds: [ids[0]], refs: [], text: "idempotency" } });
    const rows = await call<CommitRow[]>("log_rows", { sessionId: info.sessionId, start: 0, count: 50 });
    expect(rows.length).toBeGreaterThan(0);
    const byAuthor = await call<LogSessionInfo>("log_open", { query: { repoIds: [ids[0]], refs: [], author: "Priya" } });
    const all = await call<LogSessionInfo>("log_open", { query: { repoIds: [ids[0]], refs: [] } });
    expect(byAuthor.total).toBeGreaterThan(0);
    expect(byAuthor.total).toBeLessThan(all.total);
  });

  it("reports the demo scenarios in the summaries", async () => {
    const { ids } = await setup();
    const s = await call<RepoSummary[]>("repo_summaries", { repoIds: ids });
    const by = (i: number) => s[i];
    expect(by(0).branch).toBe("feature/PAY-2318-refunds");
    expect(by(0).ahead).toBe(3);
    expect(by(0).staged + by(0).unstaged + by(0).untracked).toBeGreaterThan(0);
    expect(by(1).state).toBe("rebasing");
    expect(by(1).conflicted).toBe(2);
    expect(by(2).behind).toBe(2);
    expect(by(4).state).toBe("clean");
  });

  it("returns multi-hunk file diffs for commit files", async () => {
    const { ids } = await setup();
    const info = await call<LogSessionInfo>("log_open", { query: { repoIds: [ids[0]], refs: [] } });
    const [head] = await call<CommitRow[]>("log_rows", { sessionId: info.sessionId, start: 0, count: 1 });
    const d = await call<{ files: { path: string }[] }>("commit_details", { repoId: ids[0], oid: head.oid });
    expect(d.files.length).toBeGreaterThan(3);
    const diff = await call<FileDiff>("file_diff", { repoId: ids[0], spec: { kind: "commit", oid: head.oid }, path: "src/refunds/controller.rs", oldPath: null, context: 3 });
    expect(diff.hunks.length).toBeGreaterThan(1);
  });

  it("stages, commits and emits repo-changed and git-console events", async () => {
    const { ids } = await setup();
    const repoId = ids[3]; // web-checkout
    const events: string[] = [];
    const consoleArgs: string[][] = [];
    const off1 = mockListen("repo-changed", (p) => events.push((p as { repoId: string }).repoId));
    const off2 = mockListen("git-console", (p) => consoleArgs.push((p as ConsoleEntry).args));
    const before = await call<WorkingTree>("working_tree", { repoId });
    expect(before.unstaged.length).toBeGreaterThan(0);
    await call("stage", { repoId, paths: before.unstaged.map((f) => f.path) });
    const mid = await call<WorkingTree>("working_tree", { repoId });
    expect(mid.unstaged).toHaveLength(0);
    expect(mid.staged.length).toBe(before.unstaged.length + before.staged.length);
    const res = await call<OpResult>("commit", { repoId, message: "Add checkout tests\n\nBody", amend: false });
    expect(res.ok).toBe(true);
    const after = await call<WorkingTree>("working_tree", { repoId });
    expect(after.staged).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 200));
    off1();
    off2();
    expect(events).toContain(repoId);
    expect(consoleArgs.some((a) => a[0] === "commit")).toBe(true);
    // the new commit is the newest row of a fresh log session
    const info = await call<LogSessionInfo>("log_open", { query: { repoIds: [repoId], refs: [] } });
    const [top] = await call<CommitRow[]>("log_rows", { sessionId: info.sessionId, start: 0, count: 1 });
    expect(top.subject).toBe("Add checkout tests");
  });

  it("creates and checks out branches and rejects duplicates with an ApiError shape", async () => {
    const { ids } = await setup();
    const repoId = ids[4];
    const r = await call<OpResult>("branch_create", { repoId, name: "feature/x-1", startPoint: "main", checkout: true });
    expect(r.ok).toBe(true);
    const s = await call<RepoSummary[]>("repo_summaries", { repoIds: [repoId] });
    expect(s[0].branch).toBe("feature/x-1");
    await expect(call("branch_create", { repoId, name: "feature/x-1", startPoint: "main", checkout: false })).rejects.toMatchObject({ message: expect.stringContaining("already exists") });
  });

  it("requires '<remote>/<branch>' to delete a remote branch", async () => {
    const { ids } = await setup();
    const repoId = ids[3]; // not ids[5]: docs-site has an https remote and asks for credentials (mockAuth.test.ts)
    await call("branch_create", { repoId, name: "topic/del", startPoint: "main", checkout: false });
    await call("push", { repoId, branch: "topic/del", remote: "origin", setUpstream: true });
    await expect(call("branch_delete", { repoId, name: "topic/del", force: false, remote: true })).rejects.toMatchObject({
      message: expect.stringContaining("does not belong to a configured remote"),
    });
    const r = await call<OpResult>("branch_delete", { repoId, name: "origin/topic/del", force: false, remote: true });
    expect(r.ok).toBe(true);
  });

  it("fails a push without a branch when the current branch has no upstream", async () => {
    const { ids } = await setup();
    const repoId = ids[4];
    await call("branch_create", { repoId, name: "no-up-1", startPoint: "main", checkout: true });
    await expect(call("push", { repoId, branch: null, remote: null })).rejects.toMatchObject({ message: expect.stringContaining("has no upstream branch") });
    const r = await call<OpResult>("push", { repoId, branch: "no-up-1", remote: "origin", setUpstream: true });
    expect(r.ok).toBe(true);
  });

  it("log_find honours repoId and log_open reports no skipped repos", async () => {
    const { ids } = await setup();
    const info = await call<LogSessionInfo>("log_open", { query: { repoIds: ids, refs: [] } });
    expect(info.skipped).toEqual([]);
    const rows = await call<CommitRow[]>("log_rows", { sessionId: info.sessionId, start: 0, count: 5 });
    const row = rows[2];
    expect(await call<number | null>("log_find", { sessionId: info.sessionId, oid: row.oid, repoId: row.repoId })).toBe(2);
    const other = ids.find((id) => id !== row.repoId) as string;
    expect(await call<number | null>("log_find", { sessionId: info.sessionId, oid: row.oid, repoId: other })).toBeNull();
  });

  it("is strict about a branch whose upstream has another name", async () => {
    const { ids } = await setup();
    const repoId = ids[3];
    // like `git checkout -b myfix --track origin/main`: upstream origin/main under another name
    await call("checkout", { repoId, target: "origin/main", newBranch: "myfix-up" });
    const refs = await call<{ local: { name: string; upstream: string | null }[] }>("refs", { repoId });
    expect(refs.local.find((b) => b.name === "myfix-up")?.upstream).toBe("origin/main");
    // `git push` without a refspec refuses (push.default=simple)
    await expect(call("push", { repoId, branch: null, remote: null })).rejects.toMatchObject({ message: expect.stringContaining("does not match its name") });
    // an explicit branch creates origin/<branch>, it does not touch origin/main
    const before = (await call<{ remote: { fullName: string; oid: string }[] }>("refs", { repoId })).remote.find((b) => b.fullName === "origin/main")?.oid;
    const r = await call<OpResult>("push", { repoId, branch: "myfix-up", remote: "origin", setUpstream: true });
    expect(r.ok).toBe(true);
    const after = await call<{ local: { name: string; upstream: string | null }[]; remote: { fullName: string; oid: string }[] }>("refs", { repoId });
    expect(after.remote.some((b) => b.fullName === "origin/myfix-up")).toBe(true);
    expect(after.remote.find((b) => b.fullName === "origin/main")?.oid).toBe(before);
    expect(after.local.find((b) => b.name === "myfix-up")?.upstream).toBe("origin/myfix-up");
  });

  it("rejects a push to a remote that is not configured", async () => {
    const { ids } = await setup();
    await expect(call("push", { repoId: ids[2], branch: "main", remote: "team/fork" })).rejects.toMatchObject({ message: expect.stringContaining("does not appear to be a git repository") });
  });
});
