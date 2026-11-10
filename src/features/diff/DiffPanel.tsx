/** The diff island content: the diff of the file selected in the selection store, or an empty state. */
import { type JSX, Show } from "solid-js";
import { EmptyState } from "../../components/ui";
import * as actions from "../../state/actions";
import { selectedFile } from "../../state/selection";
import { DiffViewer } from "./DiffViewer";

export function DiffPanel(): JSX.Element {
  return (
    <Show when={selectedFile()} fallback={<EmptyState icon="file" title="Select a file">Pick a file in the list to see its changes.</EmptyState>}>
      {(f) => (
        <DiffViewer
          repoId={f().repoId}
          spec={f().spec}
          path={f().path}
          oldPath={f().oldPath}
          onStageHunk={f().spec.kind === "unstaged" ? (i, info) => void actions.stageHunk(f().repoId, f().path, i, false, { oldPath: f().oldPath, expected: info?.expected, context: info?.context }) : undefined}
          onUnstageHunk={f().spec.kind === "staged" ? (i, info) => void actions.stageHunk(f().repoId, f().path, i, true, { oldPath: f().oldPath, expected: info?.expected, context: info?.context }) : undefined}
          onDiscardHunk={f().spec.kind === "unstaged" ? (i, info) => void actions.discardHunk(f().repoId, f().path, i, { confirm: false, oldPath: f().oldPath, expected: info?.expected, context: info?.context }) : undefined}
        />
      )}
    </Show>
  );
}
