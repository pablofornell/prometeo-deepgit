// @vitest-environment node
import { describe, expect, it } from "vitest";
import { gitCmd, perRepo, shellQuote } from "./command";

describe("shellQuote", () => {
  it("leaves plain arguments alone", () => {
    expect(shellQuote("feature/PAY-2318")).toBe("feature/PAY-2318");
    expect(shellQuote("--force-with-lease")).toBe("--force-with-lease");
    expect(shellQuote("stash@{0}")).toBe("stash@{0}");
    expect(shellQuote("HEAD~3")).toBe("HEAD~3");
  });

  it("quotes spaces, quotes and the empty string", () => {
    expect(shellQuote("fix login")).toBe("'fix login'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("")).toBe("''");
    expect(shellQuote("a;b")).toBe("'a;b'");
  });
});

describe("gitCmd", () => {
  it("joins the arguments and skips falsy ones", () => {
    expect(gitCmd("api-gateway", ["reset", "--mixed", "3c0e9b5"])).toBe("git -C api-gateway reset --mixed 3c0e9b5");
    expect(gitCmd("api", ["push", false, "-u", null, undefined, "origin", "main"])).toBe("git -C api push -u origin main");
  });

  it("leaves a placeholder unquoted", () => {
    expect(gitCmd("a", ["branch", "<name>", "main"])).toBe("git -C a branch <name> main");
  });

  it("quotes a repo name with spaces", () => {
    expect(gitCmd("my repo", ["status"])).toBe("git -C 'my repo' status");
  });

  it("quotes a message", () => {
    expect(gitCmd("a", ["stash", "push", "-m", "wip: login"])).toBe("git -C a stash push -m 'wip: login'");
  });
});

describe("perRepo", () => {
  it("lists every repo up to the cap, then summarises", () => {
    const names = ["a", "b", "c", "d", "e"];
    expect(perRepo(names, (n) => `git -C ${n} fetch`)).toEqual(["git -C a fetch", "git -C b fetch", "git -C c fetch", "# … and 2 more repositories"]);
  });

  it("accepts several commands per repo and a singular remainder", () => {
    expect(perRepo(["a", "b"], (n) => [`x ${n}`, `y ${n}`], 1)).toEqual(["x a", "y a", "# … and 1 more repository"]);
  });
});
