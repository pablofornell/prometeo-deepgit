/**
 * Registers the dialogs of the merge feature (see `state/dialogs.ts`): "conflicts" (the list of conflicted files) and
 * "mergeFile" (the three-pane merge window). Called once at startup from `App`; open them with `actions.openConflicts`
 * and `actions.openMerge`.
 */
import { registerDialog } from "../../state/dialogs";
import { ConflictsDialog } from "./ConflictsDialog";
import { MergeFileDialog } from "./MergeFileDialog";

export function registerMergeDialogs(): void {
  registerDialog("conflicts", ConflictsDialog);
  registerDialog("mergeFile", MergeFileDialog);
}
