/** Rebase: onto picker (the backend always uses --autostash), and a warning when the branch is already on its remote. */
import { type JSX, Show, createMemo, createSignal } from "solid-js";
import { Dialog, type DialogComponentProps, Select, type SelectOption, joinNames } from "../../components/ui";
import type { RebaseProps, RebaseResult } from "../../state/dialogs";
import { repoRefs } from "../../state/refs";
import { summary } from "../../state/workspace";
import { Field, Note, ReadOnly, repoNames } from "./parts";

export function RebaseDialog(props: RebaseProps & DialogComponentProps<RebaseResult>): JSX.Element {
  const [onto, setOnto] = createSignal(props.onto);

  const remoteNames = createMemo(() => new Set(props.repoIds.flatMap((id) => repoRefs(id)()?.remote.map((b) => b.fullName) ?? [])));

  const options = createMemo<SelectOption<string>[]>(() => {
    const seen = new Set<string>([props.branch]);
    const out: SelectOption<string>[] = [];
    const add = (n: string) => {
      if (seen.has(n)) return;
      seen.add(n);
      out.push({ value: n, label: n, icon: n.includes("/") && remoteNames().has(n) ? "remote" : "branch" });
    };
    add(props.onto);
    for (const id of props.repoIds) {
      const r = repoRefs(id)();
      if (!r) continue;
      for (const b of r.local) add(b.name);
    }
    for (const id of props.repoIds) {
      const r = repoRefs(id)();
      if (!r) continue;
      for (const b of r.remote) if (b.name !== "HEAD") add(b.fullName);
    }
    return out;
  });

  // the branch has an upstream: rebasing onto something else rewrites commits that may already be pushed
  const pushedIn = () => props.repoIds.filter((id) => {
    const up = summary(id)?.upstream;
    return !!up && up !== onto();
  });

  return (
    <Dialog
      title={`Rebase ${props.branch}`}
      onClose={() => props.close()}
      primary={{ label: "Rebase", disabled: onto() === "", onClick: () => props.close({ onto: onto() }) }}
    >
      <Field label="Rebase">
        <ReadOnly icon="rebase">{props.branch}</ReadOnly>
      </Field>
      <Field label="Onto">
        <Select class="dg-dialogs-select" ariaLabel="Rebase onto" value={onto()} onChange={setOnto} options={options()} />
      </Field>
      <div class="dg-dialogs-hint">Local changes are stashed and restored automatically.</div>
      <Show when={pushedIn().length > 0}>
        <Note kind="warning">
          {joinNames(repoNames(pushedIn()), 4)} {pushedIn().length === 1 ? "tracks" : "track"} a remote branch, so some commits may already be pushed.
          Rebasing rewrites them and the next push needs force with lease.
        </Note>
      </Show>
    </Dialog>
  );
}
