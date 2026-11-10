/** Merge: source and target (read-only), fast-forward / no fast-forward / squash. */
import { type JSX, Show, createSignal } from "solid-js";
import { Dialog, type DialogComponentProps, joinNames } from "../../components/ui";
import type { MergeProps, MergeResult } from "../../state/dialogs";
import { gitCmd, perRepo } from "./command";
import { Field, Note, RadioGroup, ReadOnly, repoNames } from "./parts";

type Mode = "ff" | "noff" | "squash";

export function MergeDialog(props: MergeProps & DialogComponentProps<MergeResult>): JSX.Element {
  const [mode, setMode] = createSignal<Mode>("ff");
  const names = () => repoNames(props.repoIds);

  // mirrors what the backend runs: `merge --no-edit [--no-ff] <source>` or `merge --squash <source>`
  const command = () =>
    perRepo(names(), (repo) => gitCmd(repo, ["merge", mode() === "squash" ? "--squash" : "--no-edit", mode() === "noff" && "--no-ff", props.source]));

  return (
    <Dialog
      title={`Merge ${props.source}`}
      onClose={() => props.close()}
      command={command()}
      primary={{ label: "Merge", onClick: () => props.close({ noFf: mode() === "noff", squash: mode() === "squash" }) }}
    >
      <div class="dg-dialogs-pair">
        <Field label="Merge"><ReadOnly icon="merge">{props.source}</ReadOnly></Field>
        <Field label="Into current branch"><ReadOnly icon="branch">{props.target}</ReadOnly></Field>
      </div>
      <Show when={props.repoIds.length > 1}>
        <Note kind="info">Runs in {joinNames(names(), 6)}. Repositories without {props.source} are skipped.</Note>
      </Show>
      <RadioGroup
        name="merge-mode"
        label="How to merge"
        value={mode()}
        onChange={setMode}
        options={[
          { value: "ff", label: "Fast-forward when possible", description: `Moves ${props.target} forward without a merge commit if it has not diverged.` },
          { value: "noff", label: "Always create a merge commit", description: "Keeps the branch visible in the history as its own line." },
          { value: "squash", label: "Squash", description: `Stages the changes of ${props.source} without committing. Review them in Local changes.` },
        ]}
      />
    </Dialog>
  );
}
