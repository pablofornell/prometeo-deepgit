/**
 * The merge window for a file that cannot be merged line by line: one side deleted it (delete / modify), or a version is
 * binary, not UTF-8 text, too large or not a regular file. The user keeps one whole side: "Accept Yours" or "Accept Theirs".
 * A side that deleted the file removes it.
 */
import { For, type JSX, Show, createSignal } from "solid-js";
import type { ConflictBlob, ConflictVersions } from "../../api/types";
import { Button } from "../../components/ui";
import * as actions from "../../state/actions";
import type { MergeFileResult } from "../../state/dialogs";

export interface SideChoiceProps {
  repoId: string;
  path: string;
  versions: ConflictVersions;
  done: (r?: MergeFileResult) => void;
}

/** Lines of a text version shown as a preview. */
const PREVIEW_LINES = 60;

const bytes = (n: number): string => `${n.toLocaleString("en-US")} bytes`;

type Kind = "deleted" | "binary" | "text";

function kindOf(b: ConflictBlob | null): Kind {
  return b === null ? "deleted" : b.binary ? "binary" : "text";
}

/** What the page says about the situation, in one or two sentences. */
export function explain(v: ConflictVersions): string {
  const [o, t] = [kindOf(v.ours), kindOf(v.theirs)];
  if (o === "deleted" && t === "deleted") return "Both sides deleted this file.";
  if (o === "deleted") return "Yours deleted this file and Theirs changed it. Keep the changed file, or delete it.";
  if (t === "deleted") return "Yours changed this file and Theirs deleted it. Keep the changed file, or delete it.";
  if (o === "binary" || t === "binary" || v.base?.binary) {
    return "This file is binary, not UTF-8 text, too large or not a regular file, so it cannot be merged line by line. Keep one version.";
  }
  return "Keep one version of this file.";
}

function Preview(props: { blob: ConflictBlob | null }): JSX.Element {
  const lines = () => (props.blob?.text ?? "").split("\n").slice(0, PREVIEW_LINES);
  return (
    <div class="dg-mg-preview dg-selectable" classList={{ "is-empty": !props.blob || props.blob.binary }} tabIndex={0} role="region" aria-label="Preview">
      <Show when={props.blob} fallback={<div class="dg-mg-preview-note">The file does not exist on this side.</div>}>
        {(b) => (
          <Show when={!b().binary} fallback={<div class="dg-mg-preview-note">Binary file, {bytes(b().bytesLen)}.</div>}>
            <pre>
              <For each={lines()}>{(l) => <div>{l || " "}</div>}</For>
            </pre>
            <Show when={(b().text ?? "").split("\n").length > PREVIEW_LINES}>
              <div class="dg-mg-preview-note">… {bytes(b().bytesLen)} in total</div>
            </Show>
          </Show>
        )}
      </Show>
    </div>
  );
}

export function SideChoice(props: SideChoiceProps): JSX.Element {
  const v = props.versions;
  const [busy, setBusy] = createSignal(false);

  const accept = async (side: "ours" | "theirs") => {
    setBusy(true);
    const res = await actions.acceptSide(props.repoId, [props.path], side, { offerContinue: false });
    setBusy(false);
    if (res.ok.length > 0) props.done({ resolved: true });
  };

  const sides = [
    { side: "ours" as const, title: "Yours", label: v.labels.ours, blob: v.ours },
    { side: "theirs" as const, title: "Theirs", label: v.labels.theirs, blob: v.theirs },
  ];
  const summary = (b: ConflictBlob | null): string => (b === null ? "Deleted this file" : b.binary ? `Binary file, ${bytes(b.bytesLen)}` : `Text file, ${bytes(b.bytesLen)}`);
  const verb = (b: ConflictBlob | null): string => (b === null ? "Delete the file" : "Keep this version");

  return (
    <div class="dg-mg-body is-choice" onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), e.stopPropagation(), props.done())}>
      <p class="dg-mg-explain">{explain(v)}</p>
      <div class="dg-mg-cards">
        <For each={sides}>
          {(s) => (
            <section class="dg-mg-card" aria-label={s.title}>
              <header class="dg-mg-card-head">
                <b>{s.title}</b>
                <span class="dg-mg-head-label" title={s.label}>{s.label}</span>
              </header>
              <div class="dg-mg-card-sub">{summary(s.blob)}</div>
              <Preview blob={s.blob} />
              <Button variant={s.blob === null ? "danger" : "primary"} disabled={busy()} onClick={() => void accept(s.side)}>
                {verb(s.blob)}
              </Button>
            </section>
          )}
        </For>
      </div>
      <div class="dg-mg-footer">
        <span class="dg-grow" />
        <Button onClick={() => props.done()}>Cancel</Button>
      </div>
    </div>
  );
}
