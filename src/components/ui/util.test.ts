// @vitest-environment node
import { describe, expect, it } from "vitest";
import { joinRepoPath } from "./util";

describe("joinRepoPath", () => {
  it("joins a POSIX folder with a slash", () => {
    expect(joinRepoPath("/home/me/app", "src/a.ts")).toBe("/home/me/app/src/a.ts");
    expect(joinRepoPath("/home/me/app/", "a.ts")).toBe("/home/me/app/a.ts");
  });

  it("uses backslashes all the way for a Windows folder", () => {
    expect(joinRepoPath("C:\\Users\\me\\app", "src/deep/a.ts")).toBe("C:\\Users\\me\\app\\src\\deep\\a.ts");
    expect(joinRepoPath("C:\\Users\\me\\app\\", "a.ts")).toBe("C:\\Users\\me\\app\\a.ts");
    expect(joinRepoPath("C:\\", "a.ts")).toBe("C:\\a.ts");
  });

  it("keeps slashes for a folder that already has them, even with a drive letter", () => {
    expect(joinRepoPath("C:/Users/me/app", "src/a.ts")).toBe("C:/Users/me/app/src/a.ts");
  });

  it("keeps a backslash that is part of a POSIX file name", () => {
    expect(joinRepoPath("/srv/app", "we\\ird.txt")).toBe("/srv/app/we\\ird.txt");
  });

  it("joins a file of the root folder", () => {
    expect(joinRepoPath("/", "a.ts")).toBe("/a.ts");
  });
});
