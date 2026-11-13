/** Rename branch: new name (validated), "Also rename on origin" when the remote branch exists. */
import { type JSX, Show, createSignal } from "solid-js";
import { Checkbox, Dialog, type DialogComponentProps, TextField } from "../../components/ui";
import type { RenameBranchProps, RenameBranchResult } from "../../state/dialogs";
import { repoRefs } from "../../state/refs";
import { repoById } from "../../state/workspace";
import { Field, Note, ReadOnly } from "./parts";
import { validateRefName } from "./refname";

export function RenameBranchDialog(props: RenameBranchProps & DialogComponentProps<RenameBranchResult>): JSX.Element {
  const [name, setName] = createSignal(props.oldName);
  const [renameRemote, setRenameRemote] = createSignal(false);
  const repoName = () => repoById(props.repoId)?.name ?? props.repoId;
  const trimmed = () => name().trim();

  const error = (): string | null => {
    if (trimmed() === "" || trimmed() === props.oldName) return null;
    const format = validateRefName(trimmed());
    if (format) return format;
    if (repoRefs(props.repoId)()?.local.some((b) => b.name === trimmed())) return `${repoName()} already has a branch named ${trimmed()}.`;
    return null;
  };
  const canSubmit = () => trimmed() !== "" && trimmed() !== props.oldName && error() === null;
  const alsoRemote = () => !!props.hasRemote && renameRemote();
  const remoteFull = () => props.remoteName ?? `origin/${props.oldName}`;

  return (
    <Dialog
      title="Rename branch"
      onClose={() => props.close()}
      primary={{ label: "Rename", disabled: !canSubmit(), onClick: () => props.close({ newName: trimmed(), renameRemote: alsoRemote() }) }}
    >
      <Field label="Current name">
        <ReadOnly icon="branch">{props.oldName}</ReadOnly>
      </Field>
      <Field label="New name" error={error()}>
        <TextField value={name()} onInput={setName} error={error() !== null} aria-label="New branch name" />
      </Field>
      <Show when={props.hasRemote}>
        <Checkbox checked={renameRemote()} onChange={setRenameRemote} label={`Also rename ${remoteFull()}`} />
        <Show when={renameRemote()}>
          <Note kind="warning">Teammates who track {remoteFull()} will have to switch to the new name.</Note>
        </Show>
      </Show>
    </Dialog>
  );
}
