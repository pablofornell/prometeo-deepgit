// @vitest-environment node
// The rules of IntelliJ GitMergeOption, as the backend (crates/gitcore/tests/commit_merge_options.rs) applies them.
import { describe, expect, it } from "vitest";
import { checkMergeOpts, defaultMergeMessage, effectiveMessage, mergeArgs, mergeMessageApplies, noCommitApplies } from "./mergeRules";
import type { MergeOpts } from "./types";

const opts = (o: Partial<MergeOpts> = {}): MergeOpts => ({ mode: "ff", message: null, noCommit: false, allowUnrelatedHistories: false, ...o });

describe("merge option rules", () => {
  it("applies the message and --no-commit only where they make sense", () => {
    expect(noCommitApplies("ff")).toBe(true);
    expect(noCommitApplies("noFf")).toBe(true);
    expect(noCommitApplies("ffOnly")).toBe(false);
    expect(noCommitApplies("squash")).toBe(false);
    expect(mergeMessageApplies({ mode: "ff", noCommit: false })).toBe(true);
    expect(mergeMessageApplies({ mode: "noFf", noCommit: false })).toBe(true);
    expect(mergeMessageApplies({ mode: "noFf", noCommit: true })).toBe(false);
    expect(mergeMessageApplies({ mode: "ffOnly", noCommit: false })).toBe(false);
    expect(mergeMessageApplies({ mode: "squash", noCommit: false })).toBe(false);
  });

  it("refuses the mixes the backend refuses", () => {
    expect(checkMergeOpts(opts())).toBeNull();
    expect(checkMergeOpts(opts({ mode: "noFf", message: "m", allowUnrelatedHistories: true }))).toBeNull();
    expect(checkMergeOpts(opts({ mode: "ffOnly", message: "m" }))).toMatch(/needs a merge commit/);
    expect(checkMergeOpts(opts({ mode: "squash", message: "m" }))).toMatch(/needs a merge commit/);
    expect(checkMergeOpts(opts({ message: "m", noCommit: true }))).toMatch(/--no-commit/);
    expect(checkMergeOpts(opts({ mode: "ffOnly", noCommit: true }))).toMatch(/fast-forward only or squash/);
    expect(checkMergeOpts(opts({ mode: "squash", noCommit: true }))).toMatch(/fast-forward only or squash/);
    expect(checkMergeOpts(opts({ message: "a\0b" }))).toMatch(/NUL/);
    // a blank message is no message
    expect(checkMergeOpts(opts({ mode: "ffOnly", message: "  \n" }))).toBeNull();
    expect(effectiveMessage("  ")).toBeNull();
    expect(effectiveMessage(null)).toBeNull();
    expect(effectiveMessage(" x ")).toBe(" x ");
  });

  it("writes the arguments in the order of the backend", () => {
    expect(mergeArgs(opts(), "dev")).toEqual(["--no-edit", "dev"]);
    expect(mergeArgs(opts({ mode: "noFf" }), "dev")).toEqual(["--no-edit", "--no-ff", "dev"]);
    expect(mergeArgs(opts({ mode: "ffOnly" }), "dev")).toEqual(["--no-edit", "--ff-only", "dev"]);
    expect(mergeArgs(opts({ mode: "squash" }), "dev")).toEqual(["--squash", "dev"]);
    expect(mergeArgs(opts({ mode: "noFf", noCommit: true, allowUnrelatedHistories: true }), "dev")).toEqual(["--no-edit", "--no-ff", "--no-commit", "--allow-unrelated-histories", "dev"]);
    expect(mergeArgs(opts({ mode: "noFf", message: "Join\n\nbody" }), "dev")).toEqual(["--no-edit", "--no-ff", "-m", "Join\n\nbody", "dev"]);
    expect(mergeArgs(opts({ message: "  " }), "dev")).toEqual(["--no-edit", "dev"]);
  });

  it("sends --no-ff with --no-commit in fast-forward mode, so the branch cannot move", () => {
    expect(mergeArgs(opts({ noCommit: true }), "dev")).toEqual(["--no-edit", "--no-ff", "--no-commit", "dev"]);
    expect(mergeArgs(opts({ mode: "ff" }), "dev")).toEqual(["--no-edit", "dev"]);
  });

  it("writes git's default message: no 'into' for main and master", () => {
    expect(defaultMergeMessage("feature/x", "develop")).toBe("Merge branch 'feature/x' into develop");
    expect(defaultMergeMessage("feature/x", "main")).toBe("Merge branch 'feature/x'");
    expect(defaultMergeMessage("feature/x", "master")).toBe("Merge branch 'feature/x'");
    expect(defaultMergeMessage("origin/x", "develop", "remote")).toBe("Merge remote-tracking branch 'origin/x' into develop");
    expect(defaultMergeMessage("origin/x", "main", "remote")).toBe("Merge remote-tracking branch 'origin/x'");
    expect(defaultMergeMessage("v1.0", "develop", "tag")).toBe("Merge tag 'v1.0' into develop");
    expect(defaultMergeMessage("abc1234", "develop", "commit")).toBe("Merge commit 'abc1234' into develop");
  });
});
