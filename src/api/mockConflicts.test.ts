// @vitest-environment node
import { describe, expect, it } from "vitest";
import { mockInvoke } from "./mock";
import type { ConflictEntry, ConflictVersions, RepoSummary, Workspace, WorkingTree } from "./types";

const call = <T>(cmd: string, args?: Record<string, unknown>) => mockInvoke(cmd, args) as Promise<T>;

async function repoIds() {
  const ws = await call<Workspace>("workspace_load");
  const project = ws.projects.find((p) => p.name === "payments-platform");
  if (!project) throw new Error("project missing");
  const by = (name: string) => (project.repos.find((r) => r.name === name) as { id: string }).id;
  return { docs: by("docs-site"), ledger: by("ledger-service") };
}

describe("mock conflicts (mirror of gitcore::conflicts)", () => {
  it("docs-site is merging with four conflicted files, ledger-service is rebasing with two", async () => {
    const { docs, ledger } = await repoIds();
    const s = await call<RepoSummary[]>("repo_summaries", { repoIds: [docs, ledger] });
    expect(s[0].state).toBe("merging");
    expect(s[0].conflicted).toBe(4);
    expect(s[1].state).toBe("rebasing");
    expect(s[1].conflicted).toBe(2);
    const list = await call<ConflictEntry[]>("conflicts", { repoId: docs });
    expect(list.map((c) => c.path)).toEqual(["config/site.toml", "docs/getting-started.md", "docs/legacy/changelog-2019.md", "static/img/architecture.png"]);
    const by = Object.fromEntries(list.map((c) => [c.path, c]));
    expect(by["docs/getting-started.md"]).toMatchObject({ ours: "modified", theirs: "modified", binary: false });
    // Yours deleted it, theirs modified it
    expect(by["docs/legacy/changelog-2019.md"]).toMatchObject({ ours: "deleted", theirs: "modified", binary: false });
    expect(by["static/img/architecture.png"].binary).toBe(true);
    // the entries match the conflicted list of the working tree
    const wt = await call<WorkingTree>("working_tree", { repoId: docs });
    expect(wt.conflicted.map((f) => f.path).sort()).toEqual(list.map((c) => c.path));
  });

  it("returns the versions, labels and no text for a binary file", async () => {
    const { docs } = await repoIds();
    const v = await call<ConflictVersions>("conflict_versions", { repoId: docs, path: "docs/getting-started.md" });
    expect(v.swapped).toBe(false);
    expect(v.base?.text).toContain("# Getting started");
    expect(v.ours?.text).toContain("Node 20 or newer");
    expect(v.theirs?.text).toContain("Node 22 or newer");
    expect(v.labels).toEqual({ ours: "main", theirs: "feature/search-docs", base: "Base" });
    expect(v.eol).toBe("lf");
    const del = await call<ConflictVersions>("conflict_versions", { repoId: docs, path: "docs/legacy/changelog-2019.md" });
    expect(del.ours).toBeNull();
    expect(del.theirs?.text).toContain("2019-12-30");
    const bin = await call<ConflictVersions>("conflict_versions", { repoId: docs, path: "static/img/architecture.png" });
    expect(bin.ours).toMatchObject({ text: null, binary: true, bytesLen: 51_930 });
  });

  it("swaps Yours and Theirs during a rebase", async () => {
    const { ledger } = await repoIds();
    const v = await call<ConflictVersions>("conflict_versions", { repoId: ledger, path: "src/ledger/posting.rs" });
    expect(v.swapped).toBe(true);
    // Yours is the commit being replayed (it adds `retries`), Theirs the upstream (it renames the function)
    expect(v.ours?.text).toContain("retries: u32");
    expect(v.theirs?.text).toContain("post_entry");
    expect(v.labels.ours).toContain("feature/PAY-2318-refunds (");
    expect(v.labels.theirs).toBe("origin/main");
    const list = await call<ConflictEntry[]>("conflicts", { repoId: ledger });
    // add/add: no base, both sides added
    expect(list.find((c) => c.path.endsWith("0018_audit_trail.sql"))).toMatchObject({ ours: "added", theirs: "added" });
    const add = await call<ConflictVersions>("conflict_versions", { repoId: ledger, path: "migrations/0018_audit_trail.sql" });
    expect(add.base).toBeNull();
  });

  it("is as strict as the backend about paths", async () => {
    const { docs } = await repoIds();
    for (const bad of ["-f", "--ours", "../x", "/etc/passwd", "a/../../x", "", "a\nb"]) {
      await expect(call("conflict_versions", { repoId: docs, path: bad })).rejects.toHaveProperty("message");
      await expect(call("accept_side", { repoId: docs, paths: [bad], side: "ours" })).rejects.toHaveProperty("message");
      await expect(call("save_resolution", { repoId: docs, path: bad, content: "x", expectedOursOid: null, resolved: true })).rejects.toHaveProperty("message");
    }
    await expect(call("conflict_versions", { repoId: docs, path: "nope.txt" })).rejects.toMatchObject({ message: "nope.txt is no longer in conflict." });
    await expect(call("accept_side", { repoId: docs, paths: ["docs"], side: "ours" })).rejects.toMatchObject({ message: expect.stringContaining("no longer in conflict") });
    await expect(call("accept_side", { repoId: docs, paths: ["config/site.toml"], side: "mine" })).rejects.toHaveProperty("message");
  });

  it("refuses to save a binary file, a stale blob and a NUL byte", async () => {
    const { docs } = await repoIds();
    await expect(call("save_resolution", { repoId: docs, path: "static/img/architecture.png", content: "x", expectedOursOid: null, resolved: true })).rejects.toMatchObject({
      message: expect.stringContaining("binary"),
    });
    await expect(call("save_resolution", { repoId: docs, path: "config/site.toml", content: "x", expectedOursOid: "0".repeat(40), resolved: true })).rejects.toMatchObject({
      message: "The conflict changed. Reload the merge.",
    });
    await expect(call("save_resolution", { repoId: docs, path: "config/site.toml", content: "a\0b", expectedOursOid: null, resolved: true })).rejects.toHaveProperty("message");
  });

  it("an unresolved save keeps the file in the list, a resolved one stages it", async () => {
    const { docs } = await repoIds();
    const v = await call<ConflictVersions>("conflict_versions", { repoId: docs, path: "config/site.toml" });
    await call("save_resolution", { repoId: docs, path: "config/site.toml", content: "<<<<<<<", expectedOursOid: v.ours?.oid ?? null, resolved: false });
    expect((await call<ConflictEntry[]>("conflicts", { repoId: docs })).some((c) => c.path === "config/site.toml")).toBe(true);
    await call("save_resolution", { repoId: docs, path: "config/site.toml", content: "title = 1\n", expectedOursOid: v.ours?.oid ?? null, resolved: true });
    expect((await call<ConflictEntry[]>("conflicts", { repoId: docs })).some((c) => c.path === "config/site.toml")).toBe(false);
    const wt = await call<WorkingTree>("working_tree", { repoId: docs });
    expect(wt.staged.some((f) => f.path === "config/site.toml")).toBe(true);
    // a second save is refused: the file is no longer conflicted
    await expect(call("save_resolution", { repoId: docs, path: "config/site.toml", content: "x", expectedOursOid: null, resolved: true })).rejects.toMatchObject({
      message: "config/site.toml is no longer in conflict.",
    });
  });

  it("accepting the deleted side removes the file, accepting the other keeps it", async () => {
    const { docs, ledger } = await repoIds();
    // Yours (stage 2 in a merge) deleted the changelog: accepting Yours is `git rm`
    await call("accept_side", { repoId: docs, paths: ["docs/legacy/changelog-2019.md"], side: "ours" });
    let wt = await call<WorkingTree>("working_tree", { repoId: docs });
    expect(wt.staged.find((f) => f.path === "docs/legacy/changelog-2019.md")?.status).toBe("deleted");
    // Rebase: Theirs is stage 2; the add/add file exists on both sides, so it is kept
    await call("accept_side", { repoId: ledger, paths: ["migrations/0018_audit_trail.sql"], side: "theirs" });
    wt = await call<WorkingTree>("working_tree", { repoId: ledger });
    expect(wt.conflicted.map((f) => f.path)).toEqual(["src/ledger/posting.rs"]);
    expect(wt.staged.find((f) => f.path === "migrations/0018_audit_trail.sql")?.status).toBe("modified");
    // already resolved: refused
    await expect(call("accept_side", { repoId: docs, paths: ["docs/legacy/changelog-2019.md"], side: "ours" })).rejects.toMatchObject({
      message: expect.stringContaining("no longer in conflict"),
    });
  });

  it("the operation can continue once every conflict is resolved", async () => {
    const { docs } = await repoIds();
    const left = await call<ConflictEntry[]>("conflicts", { repoId: docs });
    await call("accept_side", { repoId: docs, paths: left.map((c) => c.path), side: "theirs" });
    expect(await call<ConflictEntry[]>("conflicts", { repoId: docs })).toEqual([]);
    const res = await call<{ ok: boolean }>("op_continue", { repoId: docs });
    expect(res.ok).toBe(true);
    const s = await call<RepoSummary[]>("repo_summaries", { repoIds: [docs] });
    expect(s[0].state).toBe("clean");
  });
});
