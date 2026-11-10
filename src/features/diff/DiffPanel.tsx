/** The "File changes" tab of the right column: the diff of the file selected in the selection store, or a hint. */
import { type JSX, Show } from "solid-js";
import { EmptyState } from "../../components/ui";
import * as actions from "../../state/actions";
import { mainTab, selectedFile } from "../../state/selection";
import { DiffViewer } from "./DiffViewer";

export function DiffPanel(): JSX.Element {
  return (
    <Show when={selectedFile()} fallback={
        <EmptyState icon="file" title="No file selected">
          {mainTab() === "changes" ? "Select a file in Local changes." : "Select a file in Changed files."}
        </EmptyState>
      }>
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
