/**
 * The rules of the merge options (mirror of `ops::merge` in `crates/gitcore/src/ops.rs`, which follow IntelliJ
 * `GitMergeOption`): the merge dialog uses them to enable and disable controls and to show the command; the browser
 * mock uses them so it refuses exactly what the backend refuses.
 *
 *   mergeMessageApplies({ mode: "noFf", noCommit: false })   // true
 *   mergeArgs({ ...DEFAULT, mode: "squash" }, "feature/x")    // ["--squash", "feature/x"]
 */
import type { MergeMode, MergeOpts } from "./types";

/** Modes that never create a merge commit. */
const NO_MERGE_COMMIT: readonly MergeMode[] = ["ffOnly", "squash"];

/** `--no-commit` makes sense for the modes that can make a merge commit. */
export const noCommitApplies = (mode: MergeMode): boolean => !NO_MERGE_COMMIT.includes(mode);

/** A message is used when the mode can create a merge commit and `--no-commit` is off. */
export const mergeMessageApplies = (o: Pick<MergeOpts, "mode" | "noCommit">): boolean => noCommitApplies(o.mode) && !o.noCommit;

/** The message to send: null for a blank one (git's default). */
export const effectiveMessage = (message: string | null): string | null => (message !== null && message.trim() !== "" ? message : null);

/** Text of the first rule the options break, or null. Same texts as the backend. */
export function checkMergeOpts(o: MergeOpts): string | null {
  const message = effectiveMessage(o.message);
  if (message?.includes("\0")) return "The commit message contains a NUL character.";
  if (message !== null && !noCommitApplies(o.mode)) return "A commit message needs a merge commit. It cannot be used with fast-forward only or squash.";
  if (message !== null && o.noCommit) return "A commit message cannot be used with --no-commit: no commit is made.";
  if (o.noCommit && !noCommitApplies(o.mode)) return "--no-commit cannot be used with fast-forward only or squash.";
  return null;
}

/** What git writes for a merge without `-m`: "Merge branch 'x' into main". `kind` is what `source` names. */
export function defaultMergeMessage(source: string, target: string, kind: "branch" | "remote" | "tag" | "commit" = "branch"): string {
  const what = kind === "remote" ? "remote-tracking branch" : kind;
  return `Merge ${what} '${source}' into ${target}`;
}

/** The arguments after `git merge`, in the order the backend passes them (without `--end-of-options`). */
export function mergeArgs(o: MergeOpts, source: string): string[] {
  const args: string[] = [];
  switch (o.mode) {
    case "ff":
      args.push("--no-edit");
      break;
    case "noFf":
      args.push("--no-edit", "--no-ff");
      break;
    case "ffOnly":
      args.push("--no-edit", "--ff-only");
      break;
    case "squash":
      args.push("--squash");
      break;
  }
  if (o.noCommit) args.push("--no-commit");
  if (o.allowUnrelatedHistories) args.push("--allow-unrelated-histories");
  const message = effectiveMessage(o.message);
  if (message !== null) args.push("-m", message);
  args.push(source);
  return args;
}
