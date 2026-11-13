// @vitest-environment node
// The mock must refuse what the backend refuses: the file commands (crates/gitcore/tests/files.rs mirrors these).
import { describe, expect, it } from "vitest";
import { mockInvoke, mockListen } from "./mock";
import { FIXED_FILES, SEARCH_TEXT_INVALID, appendIgnoreLines, byBytes, CHANGED_ON_DISK, initialWorktree, isBinary, listFiles, readText, searchFiles, versionOf } from "./mockFiles";
import type { FileList, IgnoreTarget, SearchResult, TextFile, Workspace, WorkingTree } from "./types";

const call = <T>(cmd: string, args?: Record<string, unknown>) => mockInvoke(cmd, args) as Promise<T>;

/** The rejection of a command; fails the test when the command succeeds. */
async function rejected(p: Promise<unknown>): Promise<{ message: string; detail?: string }> {
  try {
    await p;
  } catch (e) {
    return e as { message: string; detail?: string };
  }
  throw new Error("expected the command to be refused");
}

async function repoNamed(name: string): Promise<string> {
  const ws = await call<Workspace>("workspace_load");
  const repo = ws.projects.flatMap((p) => p.repos).find((r) => r.name === name);
  if (!repo) throw new Error(`no repo ${name}`);
  return repo.id;
}

const write = (repoId: string, path: string, content: string, expectedVersion: string | null = null) =>
  call<string>("write_text_file", { repoId, path, content, expectedVersion });
const read = (repoId: string, path: string) => call<TextFile>("read_text_file", { repoId, path });
const search = (repoId: string, query: string, caseSensitive = true, regex = false) =>
  call<SearchResult>("search_files", { repoId, query, caseSensitive, regex });

describe("mock files: list", () => {
  it("lists the worktree files sorted by bytes and leaves out the ignored ones", async () => {
    const api = await repoNamed("api-gateway");
    const list = await call<FileList>("list_files", { repoId: api });
    expect(list.files).toContain("README.md");
    expect(list.files).toContain("src/main.rs");
    expect(list.files).not.toContain("build.log");
    expect(list.files).not.toContain("dist/bundle.js");
    for (let i = 1; i < list.files.length; i++) expect(byBytes(list.files[i - 1], list.files[i])).toBeLessThan(0);
    expect(list.truncated).toBe(false);
  });

  it("lists a new file, as the backend lists an untracked one", async () => {
    const api = await repoNamed("api-gateway");
    await write(api, "notes/new-idea.md", "# Idea\n");
    expect((await call<FileList>("list_files", { repoId: api })).files).toContain("notes/new-idea.md");
  });
});

describe("mock files: read", () => {
  it("reads the text with the version that the write returned", async () => {
    const ledger = await repoNamed("ledger-service");
    const version = await write(ledger, "docs/a.txt", "one\r\ntwo\r\n");
    const f = await read(ledger, "docs/a.txt");
    expect(f).toEqual({ content: "one\r\ntwo\r\n", version, binary: false, tooLarge: false });
  });

  it("reads the fixed set of files", async () => {
    const ledger = await repoNamed("ledger-service");
    expect((await read(ledger, "src/main.rs")).content).toBe(FIXED_FILES["src/main.rs"]);
  });

  it("gives no content for a binary file or a file over 2 MiB, and takes exactly 2 MiB", async () => {
    const shared = await repoNamed("shared-proto");
    await write(shared, "bin.dat", "a\u0000b");
    expect(await read(shared, "bin.dat")).toMatchObject({ content: "", binary: true, tooLarge: false });

    const limit = 2 * 1024 * 1024;
    await write(shared, "exact.txt", "a".repeat(limit));
    expect(await read(shared, "exact.txt")).toMatchObject({ tooLarge: false, binary: false });
    await write(shared, "big.txt", "a".repeat(limit + 1));
    expect(await read(shared, "big.txt")).toEqual({ content: "", version: "", binary: false, tooLarge: true });
  });

  it("refuses paths the backend refuses", async () => {
    const ledger = await repoNamed("ledger-service");
    expect(await rejected(read(ledger, "../outside.txt"))).toEqual({ message: "path outside the repo: ../outside.txt" });
    expect(await rejected(read(ledger, "/etc/passwd"))).toEqual({ message: "path outside the repo: /etc/passwd" });
    expect(await rejected(read(ledger, ".git/config"))).toEqual({ message: "path inside the git folder: .git/config" });
    expect(await rejected(read(ledger, ""))).toEqual({ message: "No file path given." });
    expect(await rejected(read(ledger, "src"))).toEqual({ message: "not a regular file: src" });
    expect(await rejected(read(ledger, "nope.md"))).toEqual({ message: "file not found: nope.md" });
  });
});

describe("mock files: write", () => {
  it("refuses a stale version and keeps the saved text", async () => {
    const refunds = await repoNamed("refunds-worker");
    const v1 = await write(refunds, "a.txt", "first");
    const v2 = await write(refunds, "a.txt", "second", v1);
    expect(v2).not.toBe(v1);
    expect(await rejected(write(refunds, "a.txt", "third", v1))).toEqual({ message: CHANGED_ON_DISK });
    expect((await read(refunds, "a.txt")).content).toBe("second");
  });

  it("refuses a missing file when a version is expected", async () => {
    const refunds = await repoNamed("refunds-worker");
    expect(await rejected(write(refunds, "missing.txt", "x", "abc-1"))).toEqual({ message: CHANGED_ON_DISK });
    expect(await rejected(read(refunds, "missing.txt"))).toEqual({ message: "file not found: missing.txt" });
  });

  it("keeps the line endings of the content", async () => {
    const refunds = await repoNamed("refunds-worker");
    await write(refunds, "win.txt", "a\r\nb\r\n");
    expect((await read(refunds, "win.txt")).content).toBe("a\r\nb\r\n");
  });

  it("refuses a folder and paths outside the repo or in the git folder", async () => {
    const refunds = await repoNamed("refunds-worker");
    expect(await rejected(write(refunds, "src", "x"))).toEqual({ message: "not a regular file: src" });
    expect(await rejected(write(refunds, "../x.txt", "x"))).toEqual({ message: "path outside the repo: ../x.txt" });
    expect(await rejected(write(refunds, ".git/hooks/pre-commit", "x"))).toEqual({
      message: "path inside the git folder: .git/hooks/pre-commit",
    });
  });

  it("emits repo-changed after a save, so the UI refreshes", async () => {
    const refunds = await repoNamed("refunds-worker");
    const seen: unknown[] = [];
    const off = mockListen("repo-changed", (p) => seen.push(p));
    await write(refunds, "events.txt", "x");
    await new Promise((r) => setTimeout(r, 250));
    off();
    expect(seen).toContainEqual({ repoId: refunds });
  });
});

const readIgnore = (repoId: string, target: IgnoreTarget) => call<string>("read_ignore_file", { repoId, target });
const append = (repoId: string, target: IgnoreTarget, patterns: string[]) => call<string[]>("append_ignore_rules", { repoId, target, patterns });

describe("mock files: ignore files", () => {
  it("adds a line to .gitignore and hides the untracked file that it matches", async () => {
    const api = await repoNamed("api-gateway");
    const before = await call<WorkingTree>("working_tree", { repoId: api });
    const untracked = before.unstaged.find((f) => f.status === "untracked");
    expect(untracked).toBeDefined();
    const path = untracked?.path ?? "";
    expect((await call<FileList>("list_files", { repoId: api })).files).toContain(path);
    expect(await append(api, "gitignore", [`/${path}`])).toEqual([`/${path}`]);
    expect((await readIgnore(api, "gitignore")).endsWith(`/${path}\n`)).toBe(true);
    expect((await call<FileList>("list_files", { repoId: api })).files).not.toContain(path);
    expect((await call<WorkingTree>("working_tree", { repoId: api })).unstaged.map((f) => f.path)).not.toContain(path);
  });

  it("lists .gitignore as changed after the first change", async () => {
    const web = await repoNamed("web-checkout");
    await append(web, "gitignore", ["*.zzz"]);
    const wt = await call<WorkingTree>("working_tree", { repoId: web });
    expect(wt.unstaged.some((f) => f.path === ".gitignore" && f.status === "modified")).toBe(true);
    // A second change does not list it twice.
    await append(web, "gitignore", ["*.yyy"]);
    const again = await call<WorkingTree>("working_tree", { repoId: web });
    expect(again.unstaged.filter((f) => f.path === ".gitignore")).toHaveLength(1);
  });

  it("skips a line that the file holds already", async () => {
    const ledger = await repoNamed("ledger-service");
    expect(await append(ledger, "gitignore", ["*.log", "gen/"])).toEqual(["gen/"]);
    expect(await append(ledger, "gitignore", ["gen/"])).toEqual([]);
  });

  it("keeps the exclude file apart from .gitignore", async () => {
    const shared = await repoNamed("shared-proto");
    expect(await readIgnore(shared, "exclude")).toBe("");
    expect(await append(shared, "exclude", ["/local.env"])).toEqual(["/local.env"]);
    expect(await readIgnore(shared, "exclude")).toBe("/local.env\n");
    expect(await readIgnore(shared, "gitignore")).not.toContain("/local.env");
  });

  it("refuses an empty pattern, a line break and an unknown target", async () => {
    const refunds = await repoNamed("refunds-worker");
    expect(await rejected(append(refunds, "gitignore", [" "]))).toEqual({ message: "A pattern cannot be empty." });
    expect(await rejected(append(refunds, "gitignore", ["a\nb"]))).toEqual({
      message: "A pattern cannot contain a line break or a NUL character.",
    });
    expect((await rejected(readIgnore(refunds, "nope" as IgnoreTarget))).message).toContain("unknown variant");
    expect((await rejected(call("append_ignore_rules", { repoId: refunds, target: "gitignore" }))).message).toContain("missing required key patterns");
  });

  it("emits repo-changed after a change", async () => {
    const refunds = await repoNamed("refunds-worker");
    const seen: unknown[] = [];
    const off = mockListen("repo-changed", (p) => seen.push(p));
    await append(refunds, "exclude", ["/event.txt"]);
    await new Promise((r) => setTimeout(r, 250));
    off();
    expect(seen).toContainEqual({ repoId: refunds });
  });

  it("appends like the backend: line break first, same line ends, no repeat", () => {
    expect(appendIgnoreLines("", ["a"])).toEqual({ text: "a\n", added: ["a"] });
    expect(appendIgnoreLines("*.log", ["dist/"])).toEqual({ text: "*.log\ndist/\n", added: ["dist/"] });
    expect(appendIgnoreLines("*.log\r\n", ["dist/"])).toEqual({ text: "*.log\r\ndist/\r\n", added: ["dist/"] });
    expect(appendIgnoreLines("a\r\nb\n", ["a", "c", "c"])).toEqual({ text: "a\r\nb\nc\r\n", added: ["c"] });
    expect(appendIgnoreLines("a\n", ["a"])).toEqual({ text: "a\n", added: [] });
  });
});

describe("mock files: search", () => {
  it("matches a fixed string and counts the column in characters", async () => {
    const web = await repoNamed("web-checkout");
    await write(web, "uni.txt", "héllo zqUni\nsay zqUni\r\n");
    const r = await search(web, "zqUni");
    expect(r.hits).toEqual([
      { path: "uni.txt", line: 1, column: 7, text: "héllo zqUni" },
      { path: "uni.txt", line: 2, column: 5, text: "say zqUni" },
    ]);
    expect(r.truncated).toBe(false);
  });

  it("ignores case only when asked", async () => {
    const web = await repoNamed("web-checkout");
    await write(web, "notes.md", "zqtodo: one\nZqTodo two\nDONE\n");
    expect((await search(web, "ZQTODO", false)).hits.map((h) => h.line)).toEqual([1, 2]);
    expect((await search(web, "ZQTODO", true)).hits).toEqual([]);
  });

  it("takes a regex only when asked", async () => {
    const web = await repoNamed("web-checkout");
    await write(web, "lib.rs", "pub zqAlpha(x)\nlet zqbeta = 1;\n");
    const hit = await search(web, "zq[A-Za-z]+\\(", true, true);
    expect(hit.hits).toEqual([{ path: "lib.rs", line: 1, column: 5, text: "pub zqAlpha(x)" }]);
    expect((await search(web, "zq[A-Za-z]+\\(", true, false)).hits).toEqual([]);
  });

  it("gives an error for an invalid regex", async () => {
    const web = await repoNamed("web-checkout");
    expect((await rejected(search(web, "[", true, true))).message).toMatch(/^fatal:/);
  });

  it("skips ignored and binary files", async () => {
    const docs = await repoNamed("docs-site");
    expect((await search(docs, "build started")).hits).toEqual([]);
    await write(docs, "blob.dat", "zqBin\u0000");
    expect((await search(docs, "zqBin")).hits).toEqual([]);
  });

  it("stops at 2 000 hits and says so", async () => {
    const shared = await repoNamed("shared-proto");
    await write(shared, "many.txt", "zqMany\n".repeat(2100));
    const r = await search(shared, "zqMany");
    expect(r.hits).toHaveLength(2000);
    expect(r.truncated).toBe(true);
  });

  it("cuts a long line to 400 characters", async () => {
    const docs = await repoNamed("docs-site");
    await write(docs, "long.txt", `${"x".repeat(500)}zqEnd\n`);
    const r = await search(docs, "zqEnd");
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].text).toHaveLength(400);
    expect(r.hits[0].column).toBe(501);
  });

  it("refuses a line break or a NUL, and treats an empty query as no hits", async () => {
    const web = await repoNamed("web-checkout");
    expect(await rejected(search(web, "a\nb"))).toEqual({ message: SEARCH_TEXT_INVALID });
    expect(await rejected(search(web, "a\u0000b"))).toEqual({ message: SEARCH_TEXT_INVALID });
    expect(await search(web, "")).toEqual({ hits: [], truncated: false });
  });

  it("does not read the query as an option", async () => {
    const web = await repoNamed("web-checkout");
    await write(web, "opts.txt", "--zqVerbose flag\n");
    expect((await search(web, "--zqVerbose")).hits).toHaveLength(1);
  });
});

describe("mock files: rules", () => {
  it("orders by UTF-8 bytes, so U+FFFD comes before an emoji", () => {
    expect(byBytes("�", "\u{1F600}")).toBeLessThan(0);
    expect(byBytes("a", "a")).toBe(0);
    expect(byBytes("Zeta", "src")).toBeLessThan(0);
  });

  it("caps the list and the hits and says so", () => {
    const files = new Map([["a", "x"], ["b", "x"], ["c", "x"]]);
    expect(listFiles(files, new Set(), 2)).toEqual({ files: ["a", "b"], truncated: true });
    expect(listFiles(files, new Set(["c"]), 2)).toEqual({ files: ["a", "b"], truncated: false });
    const lines = new Map([["a.txt", "hit\nhit\nhit"]]);
    expect(searchFiles(lines, new Set(), "hit", true, false, 2)).toEqual({
      hits: [
        { path: "a.txt", line: 1, column: 1, text: "hit" },
        { path: "a.txt", line: 2, column: 1, text: "hit" },
      ],
      truncated: true,
    });
    expect(searchFiles(lines, new Set(), "hit", true, false, 3).truncated).toBe(false);
  });

  it("makes versions that change with the text and carry its byte length", () => {
    expect(versionOf("abc")).toBe(versionOf("abc"));
    expect(versionOf("abc")).not.toBe(versionOf("abd"));
    expect(versionOf("abc")).toMatch(/-3$/);
    expect(versionOf("é")).toMatch(/-2$/);
  });

  it("detects a NUL byte in the first 8 000 bytes as binary", () => {
    expect(isBinary("a\u0000")).toBe(true);
    expect(isBinary("a".repeat(8000) + "\u0000")).toBe(false);
    expect(readText("a\u0000")).toMatchObject({ content: "", binary: true });
  });

  it("builds the fake disk with the fixed set, the ignored files and the listed paths", () => {
    const { files, ignored } = initialWorktree(["src/scratch/notes_1.rs", "README.md", ".gitignore"]);
    expect(files.has("src/scratch/notes_1.rs")).toBe(true);
    expect(files.get("README.md")).toBe(FIXED_FILES["README.md"]);
    expect(ignored).toEqual(new Set(["dist/bundle.js", "build.log"]));
    expect(files.has("build.log")).toBe(true);
  });
});
