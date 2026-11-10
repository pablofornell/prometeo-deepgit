/** Rename project: new name, checked while typing with the backend's rules (not empty, at most 80 characters, unique). */
import { type JSX, createSignal } from "solid-js";
import { Dialog, type DialogComponentProps, TextField } from "../../components/ui";
import type { RenameProjectProps, RenameProjectResult } from "../../state/dialogs";
import { projectNameError, workspace } from "../../state/workspace";
import { Field, ReadOnly } from "./parts";

export function RenameProjectDialog(props: RenameProjectProps & DialogComponentProps<RenameProjectResult>): JSX.Element {
  const project = () => workspace.projects.find((p) => p.id === props.projectId);
  const oldName = project()?.name ?? "";
  const [name, setName] = createSignal(oldName);
  const error = () => projectNameError(props.projectId, name());
  const unchanged = () => name().trim() === oldName;
  const canSubmit = () => !!project() && !unchanged() && error() === null;

  return (
    <Dialog
      title="Rename project"
      onClose={() => props.close()}
      primary={{ label: "Rename", disabled: !canSubmit(), onClick: () => props.close({ name: name().trim() }) }}
    >
      <Field label="Folder">
        <ReadOnly icon="project">{project()?.path ?? ""}</ReadOnly>
      </Field>
      <Field label="Name" error={error()} hint="Only the name in DeepGit changes. The folder keeps its name.">
        <TextField value={name()} onInput={setName} error={error() !== null} aria-label="Project name" maxLength={200} />
      </Field>
    </Dialog>
  );
}
