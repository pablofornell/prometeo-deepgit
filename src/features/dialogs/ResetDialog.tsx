/** Reset: mode radio (soft, mixed, hard, keep). Hard is the danger one. */
import { type JSX, Show, createSignal } from "solid-js";
import { Dialog, type DialogComponentProps, joinNames, plural, shortOid } from "../../components/ui";
import type { ResetMode } from "../../api/types";
import type { ResetProps, ResetResult } from "../../state/dialogs";
import { summary } from "../../state/workspace";
import { gitCmd, perRepo } from "./command";
import { Field, Note, RadioGroup, ReadOnly, repoNames } from "./parts";

export function ResetDialog(props: ResetProps & DialogComponentProps<ResetResult>): JSX.Element {
  const [mode, setMode] = createSignal<ResetMode>("mixed");
  const names = () => repoNames(props.repoIds);
  const target = () => props.targetLabel ?? (/^[0-9a-f]{7,40}$/.test(props.target) ? shortOid(props.target) : props.target);
  const branches = () => [...new Set(props.repoIds.map((id) => summary(id)?.branch).filter((b): b is string => !!b))];

  const command = () => perRepo(names(), (repo) => gitCmd(repo, ["reset", `--${mode()}`, props.target]));

  return (
    <Dialog
      title="Reset current branch"
      onClose={() => props.close()}
      command={command()}
      primary={{ label: "Reset", danger: mode() === "hard", onClick: () => props.close({ mode: mode() }) }}
    >
      <p class="dg-dialogs-text dg-selectable">
        Move <strong>{branches().length > 0 ? joinNames(branches(), 3) : "the current branch"}</strong>
        {props.repoIds.length > 1 ? ` in ${plural(props.repoIds.length, "repository", "repositories")}` : names()[0] ? ` in ${names()[0]}` : ""} to
      </p>
      <ReadOnly icon="commit" mono={!props.targetLabel}>{target()}</ReadOnly>
      <Field label="Mode">
        <RadioGroup
          name="reset-mode"
          label="Reset mode"
          value={mode()}
          onChange={setMode}
          options={[
            { value: "soft", label: "Soft", description: "Keep the index and the working tree. Changes since the target stay staged." },
            { value: "mixed", label: "Mixed", description: "Keep the working tree and unstage the changes." },
            { value: "hard", label: "Hard", description: "Discard everything: index, working tree and the commits after the target.", danger: true },
            { value: "keep", label: "Keep", description: "Like hard, but stops if a local change would be overwritten." },
          ]}
        />
      </Field>
      <Show when={mode() === "hard"}>
        <Note kind="error">
          {props.dirtyFiles && props.dirtyFiles > 0
            ? `Uncommitted changes in ${plural(props.dirtyFiles, "file")} will be lost.`
            : "Local changes and the commits after the target will be lost."}
        </Note>
      </Show>
    </Dialog>
  );
}
