/**
 * Initialize a Git repository (ITERATION-3.md section 4): the folder the user added has no repository. The dialog runs
 * `git init -b <branch>` itself (`api.projectInit`) and stays open on a failure to show the first line of git's error;
 * on success it closes with the new project. The branch starts as `init.defaultBranch` (`main` when it is not set).
 */
import { type JSX, Show, createSignal } from "solid-js";
import * as api from "../../api/tauri";
import { Dialog, type DialogComponentProps, TextField } from "../../components/ui";
import type { InitRepositoryProps, InitRepositoryResult } from "../../state/dialogs";
import { validateRefName } from "./refname";
import { Field, Note, ReadOnly } from "./parts";

export function InitRepositoryDialog(props: InitRepositoryProps & DialogComponentProps<InitRepositoryResult>): JSX.Element {
  const { info } = props;
  const [branch, setBranch] = createSignal(info.defaultBranch);
  const [running, setRunning] = createSignal(false);
  const [failure, setFailure] = createSignal<string | null>(null);

  const name = () => branch().trim();
  /** An empty name only disables the button; any other problem shows the sentence of the spec. */
  const invalid = () => name() === "" || validateRefName(name()) !== null;
  const error = () => (name() !== "" && validateRefName(name()) !== null ? "This is not a valid branch name." : null);

  const change = (value: string) => {
    setBranch(value);
    setFailure(null);
  };

  const start = async () => {
    if (running() || invalid()) return;
    setFailure(null);
    setRunning(true);
    try {
      const project = await api.projectInit(info.path, name());
      props.close({ project, branch: name() });
    } catch (e) {
      const err = api.toApiError(e);
      setFailure(err.message || "git init failed.");
      setRunning(false);
    }
  };

  return (
    <Dialog
      title="Initialize a Git repository?"
      onClose={() => {
        if (!running()) props.close();
      }}
      primary={{ label: running() ? "Initializing…" : "Initialize repository", disabled: running() || invalid(), onClick: () => void start() }}
    >
      <p class="dg-dialogs-text dg-selectable">
        The folder "{info.name}" has no Git repository.
        <br />
        DeepGit can create one in this folder.
      </p>
      <Field label="Folder">
        <ReadOnly icon="folder" mono>
          {info.path}
        </ReadOnly>
      </Field>
      <Field label="Initial branch" error={error()}>
        <TextField value={branch()} onInput={change} disabled={running()} error={error() !== null} aria-label="Initial branch" spellcheck={false} />
      </Field>
      <Show when={info.parentRepo}>
        {(parent) => (
          <Note kind="warning">
            This folder is inside the repository {parent()}. The new repository becomes a nested repository.
          </Note>
        )}
      </Show>
      <Show when={failure()}>{(msg) => <Note kind="error">{msg()}</Note>}</Show>
    </Dialog>
  );
}
