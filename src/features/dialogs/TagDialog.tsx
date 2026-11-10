/** New tag: validated name, optional message (non-empty makes it annotated), read-only target. */
import { type JSX, Show, createSignal } from "solid-js";
import { Dialog, type DialogComponentProps, TextField, joinNames, shortOid } from "../../components/ui";
import type { TagProps, TagResult } from "../../state/dialogs";
import { repoRefs } from "../../state/refs";
import { gitCmd, perRepo } from "./command";
import { Field, Note, ReadOnly, TextArea, repoNames } from "./parts";
import { validateRefName } from "./refname";

export function TagDialog(props: TagProps & DialogComponentProps<TagResult>): JSX.Element {
  const [name, setName] = createSignal("");
  const [message, setMessage] = createSignal("");
  const trimmed = () => name().trim();
  const msg = () => message().trim();
  const target = () => props.targetLabel ?? (/^[0-9a-f]{7,40}$/.test(props.target) ? shortOid(props.target) : props.target);

  const error = (): string | null => {
    if (trimmed() === "") return null;
    const format = validateRefName(trimmed(), "tag");
    if (format) return format;
    const clashes = props.repoIds.filter((id) => repoRefs(id)()?.tags.some((t) => t.name === trimmed()));
    if (clashes.length > 0) {
      const names = repoNames(clashes);
      return `${joinNames(names)} already ${names.length === 1 ? "has" : "have"} a tag named ${trimmed()}.`;
    }
    return null;
  };
  const canSubmit = () => trimmed() !== "" && error() === null;

  // mirrors the backend: `tag -a <name> -m <message> <target>` or `tag <name> <target>`
  const command = () => {
    const n = trimmed() || "<name>";
    return perRepo(repoNames(props.repoIds), (repo) => gitCmd(repo, msg() ? ["tag", "-a", n, "-m", msg(), props.target] : ["tag", n, props.target]));
  };

  return (
    <Dialog
      title="New tag"
      onClose={() => props.close()}
      command={command()}
      primary={{ label: "Create tag", disabled: !canSubmit(), onClick: () => props.close({ name: trimmed(), message: msg() || null }) }}
    >
      <Field label="Name" error={error()}>
        <TextField value={name()} onInput={setName} error={error() !== null} placeholder="v1.0.0" aria-label="Tag name" />
      </Field>
      <Field label="Tag at">
        <ReadOnly icon="tag" mono={!props.targetLabel}>{target()}</ReadOnly>
      </Field>
      <Field label="Message (optional)" hint="A message makes an annotated tag. Leave it empty for a lightweight tag.">
        <TextArea value={message()} onInput={setMessage} rows={3} ariaLabel="Tag message" />
      </Field>
      <Show when={props.repoIds.length > 1}>
        <Note kind="info">Creates the tag in {joinNames(repoNames(props.repoIds), 6)}.</Note>
      </Show>
    </Dialog>
  );
}
