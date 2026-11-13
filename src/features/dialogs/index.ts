/**
 * Registers the dialog components (see `state/dialogs.ts`). Called once at startup from `App`.
 * One file per dialog; the generic "confirm" lives in `components/ui` and registers itself.
 */
import { registerDialog } from "../../state/dialogs";
import { AuthDialog } from "./AuthDialog";
import { CheckoutRemoteDialog } from "./CheckoutRemoteDialog";
import { CloneDialog } from "./CloneDialog";
import { InitRepositoryDialog } from "./InitRepositoryDialog";
import { MergeDialog } from "./MergeDialog";
import { NewBranchDialog } from "./NewBranchDialog";
import { PushDialog } from "./PushDialog";
import { RebaseDialog } from "./RebaseDialog";
import { RenameBranchDialog } from "./RenameBranchDialog";
import { RenameProjectDialog } from "./RenameProjectDialog";
import { ResetDialog } from "./ResetDialog";
import { StashDialog } from "./StashDialog";
import { TagDialog } from "./TagDialog";

export function registerAllDialogs(): void {
  registerDialog("newBranch", NewBranchDialog);
  registerDialog("renameBranch", RenameBranchDialog);
  registerDialog("merge", MergeDialog);
  registerDialog("rebase", RebaseDialog);
  registerDialog("reset", ResetDialog);
  registerDialog("push", PushDialog);
  registerDialog("stash", StashDialog);
  registerDialog("tag", TagDialog);
  registerDialog("checkoutRemote", CheckoutRemoteDialog);
  registerDialog("clone", CloneDialog);
  registerDialog("auth", AuthDialog);
  registerDialog("renameProject", RenameProjectDialog);
  registerDialog("initRepository", InitRepositoryDialog);
}
