/** Check out a remote branch as a new local tracking branch. */
import { type JSX, createSignal } from "solid-js";
import { Dialog, type DialogComponentProps, TextField } from "../../components/ui";
import type { CheckoutRemoteProps, CheckoutRemoteResult } from "../../state/dialogs";
import { repoRefs } from "../../state/refs";
import { splitRemoteRefLoose } from "../../state/remoteRefs";
import { repoById } from "../../state/workspace";
import { Field, Note, ReadOnly } from "./parts";
import { validateRefName } from "./refname";

export function CheckoutRemoteDialog(props: CheckoutRemoteProps & DialogComponentProps<CheckoutRemoteResult>): JSX.Element {
  const [name, setName] = createSignal(splitRemoteRefLoose(props.remoteBranch, repoRefs(props.repoId)())?.branch ?? props.remoteBranch);
  const repoName = () => repoById(props.repoId)?.name ?? props.repoId;
  const trimmed = () => name().trim();

  const error = (): string | null => {
    if (trimmed() === "") return null;
    const format = validateRefName(trimmed());
    if (format) return format;
    if (repoRefs(props.repoId)()?.local.some((b) => b.name === trimmed())) return `${repoName()} already has a local branch named ${trimmed()}.`;
    return null;
  };

  return (
    <Dialog
      title="Check out remote branch"
      onClose={() => props.close()}
      primary={{ label: "Check out", disabled: trimmed() === "" || error() !== null, onClick: () => props.close({ localName: trimmed() }) }}
    >
      <Field label="Remote branch">
        <ReadOnly icon="remote">{props.remoteBranch}</ReadOnly>
      </Field>
      <Field label="Local branch name" error={error()}>
        <TextField value={name()} onInput={setName} error={error() !== null} aria-label="Local branch name" />
      </Field>
      <Note kind="info">The new branch tracks {props.remoteBranch}, so pull and push work without extra arguments.</Note>
    </Dialog>
  );
}
