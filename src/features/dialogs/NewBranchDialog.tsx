/** New branch (DESIGN.md 5.11): validated name, read-only start point, "Check out", repo checklist when several repos. */
import { type JSX, Show, createMemo, createSignal } from "solid-js";
import { Checkbox, Dialog, type DialogComponentProps, TextField, joinNames, shortOid } from "../../components/ui";
import type { NewBranchProps, NewBranchResult } from "../../state/dialogs";
import { repoRefs } from "../../state/refs";
import { summary } from "../../state/workspace";
import { Field, ReadOnly, RepoChecklist, repoNames } from "./parts";
import { validateRefName } from "./refname";

const looksLikeOid = (s: string): boolean => /^[0-9a-f]{7,40}$/.test(s);

export function NewBranchDialog(props: NewBranchProps & DialogComponentProps<NewBranchResult>): JSX.Element {
  const [name, setName] = createSignal(props.suggestedName ?? "");
  const [checkout, setCheckout] = createSignal(true);
  const [picked, setPicked] = createSignal<string[]>([...props.repoIds]);
  const trimmed = () => name().trim();
  const start = () => props.startLabel ?? (looksLikeOid(props.startPoint) ? shortOid(props.startPoint) : props.startPoint);

  const clashes = createMemo(() => picked().filter((id) => repoRefs(id)()?.local.some((b) => b.name === trimmed())));
  const error = createMemo<string | null>(() => {
    if (trimmed() === "") return null;
    const format = validateRefName(trimmed());
    if (format) return format;
    if (clashes().length > 0) {
      const names = repoNames(clashes());
      return `${joinNames(names)} already ${names.length === 1 ? "has" : "have"} a branch named ${trimmed()}.${props.repoIds.length > 1 ? " Untick it or pick another name." : ""}`;
    }
    return null;
  });
  const canSubmit = () => trimmed() !== "" && error() === null && picked().length > 0;

  const submit = () => props.close({ name: trimmed(), checkout: checkout(), repoIds: picked() });

  return (
    <Dialog
      title="New branch"
      onClose={() => props.close()}
      primary={{ label: "Create branch", disabled: !canSubmit(), onClick: submit }}
    >
      <Field label="Name" error={error()}>
        <TextField value={name()} onInput={setName} error={error() !== null} placeholder="feature/short-description" aria-label="Branch name" />
      </Field>
      <Field label="Start point">
        <ReadOnly icon="branch" mono={looksLikeOid(start())}>{start()}</ReadOnly>
      </Field>
      <Checkbox checked={checkout()} onChange={setCheckout} label="Check out the new branch" />
      <Show when={props.repoIds.length > 1}>
        <RepoChecklist
          repoIds={props.repoIds}
          picked={picked()}
          onChange={setPicked}
          detail={(id) => {
            const b = summary(id)?.branch;
            return b ? `on ${b}` : undefined;
          }}
        />
      </Show>
    </Dialog>
  );
}
