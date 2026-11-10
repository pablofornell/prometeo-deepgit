// @vitest-environment node
// Same cases as the Rust tests in crates/gitcore/src/clone.rs: the two must agree.
import { describe, expect, it } from "vitest";
import { checkCloneInput, checkCloneUrl, checkDirName, defaultDirName, insideProject, isAbsolutePath, joinPath, looksLikeRepoUrl } from "./cloneRules";

describe("defaultDirName", () => {
  it("follows git for URLs and paths", () => {
    const cases: [string, string][] = [
      ["https://github.com/org/repo.git", "repo"],
      ["https://github.com/org/repo.git/", "repo"],
      ["https://github.com/org/repo", "repo"],
      ["https://github.com/org/repo///", "repo"],
      ["git@github.com:org/repo.git", "repo"],
      ["git@github.com:repo.git", "repo"],
      ["host:repo", "repo"],
      ["ssh://git@host:2222/org/repo.git", "repo"],
      ["file:///srv/git/proj.git", "proj"],
      ["file:///srv/git/proj", "proj"],
      ["/srv/git/proj.git", "proj"],
      ["/srv/git/proj/", "proj"],
      ["/srv/work/proj/.git", "proj"],
      ["../relative/proj.git", "proj"],
      ["proj.git", "proj"],
      ["C:\\Users\\me\\proj.git", "proj"],
      ["  https://x.org/a/b.git \n", "b"],
      ["https://example.com", "example.com"],
      ["my.repo.name", "my.repo.name"],
      ["foo.git.git", "foo.git"],
    ];
    for (const [url, name] of cases) expect(defaultDirName(url), url).toBe(name);
  });

  it("gives null when nothing is left", () => {
    for (const url of ["", "   ", "/", ".git", "https://host/.."]) expect(defaultDirName(url), url).toBeNull();
  });
});

describe("clone input rules", () => {
  it("checks the URL", () => {
    expect(checkCloneUrl("")).toMatch(/Enter the URL/);
    expect(checkCloneUrl("  ")).toMatch(/Enter the URL/);
    expect(checkCloneUrl("--upload-pack=touch /tmp/pwn")).toMatch(/cannot start with '-'/);
    expect(checkCloneUrl("https://h/r\nx")).toMatch(/control character/);
    expect(checkCloneUrl("https://h/r\u0007")).toMatch(/control character/);
    expect(checkCloneUrl("ext::sh -c touch% /tmp/pwn")).toMatch(/runs commands/);
    expect(checkCloneUrl("FD::3")).toMatch(/runs commands/);
    expect(checkCloneUrl("  https://h/r.git ")).toBeNull();
    expect(checkCloneUrl("git@host:org/r.git")).toBeNull();
    expect(checkCloneUrl("/srv/git/r.git")).toBeNull();
  });

  it("checks the folder name", () => {
    for (const bad of ["", " ", "a/b", "a\\b", ".", "..", "a..b", "../x", "a\nb"]) expect(checkDirName(bad), JSON.stringify(bad)).not.toBeNull();
    for (const good of ["repo", "my.repo", " repo ", "a-b_c"]) expect(checkDirName(good), good).toBeNull();
  });

  it("checks the whole input", () => {
    const ok = { url: "https://h/r.git", parentDir: "/work", dirName: "r", branch: null, depth: null };
    expect(checkCloneInput(ok)).toBeNull();
    expect(checkCloneInput({ ...ok, parentDir: "~/work" })).toBeNull();
    expect(checkCloneInput({ ...ok, parentDir: "" })).toMatch(/Choose the parent/);
    expect(checkCloneInput({ ...ok, parentDir: "work" })).toMatch(/absolute/);
    expect(checkCloneInput({ ...ok, branch: " " })).toMatch(/empty/);
    expect(checkCloneInput({ ...ok, branch: "-x" })).toMatch(/cannot start with '-'/);
    expect(checkCloneInput({ ...ok, depth: 0 })).toMatch(/at least 1/);
    expect(checkCloneInput({ ...ok, depth: 1.5 })).toMatch(/at least 1/);
    expect(checkCloneInput({ ...ok, depth: Number.NaN })).toMatch(/at least 1/);
    expect(checkCloneInput({ ...ok, branch: "dev", depth: 1 })).toBeNull();
  });

  it("knows absolute paths and joins names", () => {
    for (const p of ["/a", "~", "~/a", "C:\\a", "c:/a", "\\\\srv\\share"]) expect(isAbsolutePath(p), p).toBe(true);
    for (const p of ["a", "./a", "../a", ""]) expect(isAbsolutePath(p), p).toBe(false);
    expect(joinPath("/work/", "r")).toBe("/work/r");
    expect(joinPath("/work", "r")).toBe("/work/r");
    expect(joinPath("C:\\work", "r")).toBe("C:\\work\\r");
  });
});

describe("clone dialog helpers", () => {
  it("detects something to clone in pasted text", () => {
    for (const t of ["https://github.com/a/b", "ssh://git@host/a/b.git", "git@github.com:a/b.git", "file:///srv/x", "/srv/x/y.git", " https://h/a/b.git\n"]) expect(looksLikeRepoUrl(t), t).toBe(true);
    for (const t of ["", "hello world", "some text", "https://h/a b", "ls -la", "/just/a/path"]) expect(looksLikeRepoUrl(t), t).toBe(false);
  });

  it("tells whether a clone is found again by a rescan of the project", () => {
    expect(insideProject("/work/p", "/work/p")).toBe(true);
    expect(insideProject("/work/p/", "/work/p")).toBe(true);
    expect(insideProject("/work/p/sub/deeper", "/work/p")).toBe(true);
    expect(insideProject("/work/p2", "/work/p")).toBe(false);
    expect(insideProject("/other", "/work/p")).toBe(false);
    // `~` cannot be compared with an absolute path: the backend decides
    expect(insideProject("~/work/p", "/home/me/work/p")).toBe(true);
    expect(insideProject("~/work/q", "~/work/p")).toBe(false);
  });
});
