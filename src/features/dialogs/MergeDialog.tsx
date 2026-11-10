/**
 * Merge: source and target (read-only), the mode (fast-forward when possible / merge commit / fast-forward only /
 * squash) and the options of IntelliJ `GitMergeDialog`: commit message, `--no-commit`, unrelated histories.
 * The rules that switch controls off live in `api/mergeRules.ts` (the backend and the mock apply the same ones).
 */
import { type JSX, Show, createSignal } from "solid-js";
import { defaultMergeMessage, effectiveMessage, mergeArgs, mergeMessageApplies, noCommitApplies } from "../../api/mergeRules";
import type { MergeMode, MergeOpts } from "../../api/types";
import { Checkbox, Dialog, type DialogComponentProps, joinNames } from "../../components/ui";
import type { MergeProps, MergeResult } from "../../state/dialogs";
import { gitCmd, perRepo } from "./command";
import { Field, Note, RadioGroup, ReadOnly, TextArea, repoNames } from "./parts";

export function MergeDialog(props: MergeProps & DialogComponentProps<MergeResult>): JSX.Element {
  const [mode, setMode] = createSignal<MergeMode>("ff");
  const defaultMessage = defaultMergeMessage(props.source, props.target, props.sourceKind);
  const [message, setMessage] = createSignal(defaultMessage);
  const [noCommit, setNoCommit] = createSignal(false);
  const [unrelated, setUnrelated] = createSignal(false);
  const names = () => repoNames(props.repoIds);

  const noCommitOn = () => noCommitApplies(mode()) && noCommit();
  const messageOn = () => mergeMessageApplies({ mode: mode(), noCommit: noCommitOn() });

  /** The options to run with. The message goes along only when the user changed git's default one (each repo has its own default). */
  const opts = (): MergeOpts => ({
    mode: mode(),
    message: messageOn() && message().trim() !== defaultMessage ? effectiveMessage(message()) : null,
    noCommit: noCommitOn(),
    allowUnrelatedHistories: unrelated(),
  });

  // mirrors what the backend runs: `merge --no-edit [--no-ff|--ff-only] [--no-commit] [-m msg] <source>` or `merge --squash <source>`
  const command = () => perRepo(names(), (repo) => gitCmd(repo, ["merge", ...mergeArgs(opts(), props.source)]));

  const messageHint = (): string | undefined => {
    if (messageOn()) return "Used when a merge commit is created. Leave it as it is to keep git's own message.";
    if (!noCommitApplies(mode())) return "A merge commit is not made in this mode.";
    return "No commit is made with --no-commit.";
  };

  return (
    <Dialog
      title={`Merge ${props.source}`}
      onClose={() => props.close()}
      command={command()}
      primary={{ label: "Merge", onClick: () => props.close(opts()) }}
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
          { value: "noFf", label: "Always create a merge commit", description: "Keeps the branch visible in the history as its own line." },
          { value: "ffOnly", label: "Fast-forward only", description: `Fails when ${props.target} has commits that ${props.source} does not have.` },
          { value: "squash", label: "Squash", description: `Stages the changes of ${props.source} without committing. Review them in Local changes.` },
        ]}
      />
      <Field label="Commit message" hint={messageHint()}>
        <TextArea value={message()} onInput={setMessage} rows={3} ariaLabel="Commit message of the merge" disabled={!messageOn()} />
      </Field>
      <div class="dg-dialogs-options">
        <Checkbox
          checked={noCommitOn()}
          onChange={setNoCommit}
          disabled={!noCommitApplies(mode())}
          label="Do not commit (--no-commit)"
          title={noCommitApplies(mode()) ? "Merge, then stop: finish it from Local changes" : "Squash and fast-forward only make no merge commit"}
        />
        <Checkbox checked={unrelated()} onChange={setUnrelated} label="Allow unrelated histories" title="--allow-unrelated-histories: merge branches that share no commit" />
      </div>
    </Dialog>
  );
}
