/**
 * Add to .gitignore (docs/design/ITERATION-3.md section 11): pattern options with a match count, the target file
 * (`.gitignore` or `.git/info/exclude`), a preview of the line, and a note for tracked files. The dialog writes the lines and
 * shows the toast. It does not stage, commit or untrack anything.
 */
import { type JSX, For, Show, createEffect, createMemo, createResource, createSignal } from "solid-js";
import * as api from "../../api/tauri";
import type { IgnoreTarget } from "../../api/types";
import { Dialog, type DialogComponentProps, Select, TextField, toast } from "../../components/ui";
import type { IgnoreProps, IgnoreResult } from "../../state/dialogs";
import { openFileInFiles } from "../../state/fileOpen";
import { repoById } from "../../state/workspace";
import { Field, Note, RadioGroup, TextArea, type RadioOption } from "./parts";
import {
  MAX_COUNTED_FILES, addedTitle, countMatches, defaultKind, fileCountLabel, parseLines, patternOptions, splitKnown, thesePatterns, trackedNote,
  type MatchCount, type OptionKind, type PatternOption,
} from "./ignoreRules";

/** The files of a repo and the ones that git tracks. Null when the list is not there. */
interface FileData {
  files: string[];
  tracked: Set<string>;
}

async function loadFiles(repoId: string): Promise<FileData | null> {
  try {
    const [list, wt] = await Promise.all([api.listFiles(repoId), api.workingTree(repoId)]);
    if (list.truncated || list.files.length > MAX_COUNTED_FILES) return null;
    const untracked = new Set(wt.unstaged.filter((f) => f.status === "untracked").map((f) => f.path));
    return { files: list.files, tracked: new Set(list.files.filter((p) => !untracked.has(p))) };
  } catch {
    return null;
  }
}

const TARGET_NAME: Record<IgnoreTarget, string> = { gitignore: ".gitignore", exclude: ".git/info/exclude" };

/** The description of an option: its lines, cut after a few when there are many. */
function describe(lines: readonly string[]): string {
  return lines.length <= 3 ? lines.join(", ") : `${lines.slice(0, 3).join(", ")} and ${lines.length - 3} more`;
}

export function IgnoreDialog(props: IgnoreProps & DialogComponentProps<IgnoreResult>): JSX.Element {
  const repoName = repoById(props.repoId)?.name ?? props.repoId;
  const items = props.items;
  const several = items.length > 1;
  const ready: PatternOption[] = several ? [{ kind: "these", label: "These files", lines: thesePatterns(items) }] : patternOptions(items[0]);
  const optionOf = (k: OptionKind): PatternOption | undefined => ready.find((o) => o.kind === k);

  const firstKind: OptionKind = several ? "these" : defaultKind(items[0]);
  const [kind, setKind] = createSignal<OptionKind>(firstKind);
  const [custom, setCustom] = createSignal((optionOf(firstKind)?.lines ?? []).join("\n"));
  const [target, setTarget] = createSignal<IgnoreTarget>("gitignore");
  const [busy, setBusy] = createSignal(false);
  const [failure, setFailure] = createSignal<string | null>(null);

  const radios: RadioOption<OptionKind>[] = [
    ...ready.map((o): RadioOption<OptionKind> => ({ value: o.kind, label: o.label, description: describe(o.lines), mono: true })),
    { value: "custom", label: "Custom" },
  ];
  const pick = (k: OptionKind): void => {
    setKind(k);
    // Custom starts with the pattern that was selected.
    const o = optionOf(k);
    if (o) setCustom(o.lines.join("\n"));
  };

  /** The lines the dialog adds. */
  const lines = createMemo<string[]>(() => (kind() === "custom" ? [...new Set(parseLines(custom()))] : (optionOf(kind())?.lines ?? [])));

  // ---- match count: one read of the file list. The counts of the fixed options do not change.
  const [data] = createResource(() => props.repoId, loadFiles);
  const fileData = (): FileData | null => (data.state === "ready" ? (data() ?? null) : null);
  // `core.ignorecase` of the repo comes with the first read of an ignore file. Git matches with this rule, so the count waits for it.
  const [ignoreCase, setIgnoreCase] = createSignal<boolean | null>(null);
  const optionCounts = createMemo(() => {
    const d = fileData();
    const ic = ignoreCase();
    const out = new Map<OptionKind, MatchCount>();
    if (!d || ic === null) return out;
    for (const o of ready) {
      const c = countMatches(d.files, d.tracked, o.lines, ic);
      if (c) out.set(o.kind, c);
    }
    return out;
  });
  const current = createMemo<MatchCount | null>(() => {
    const d = fileData();
    const ic = ignoreCase();
    if (!d || ic === null) return null;
    return kind() === "custom" ? countMatches(d.files, d.tracked, lines(), ic) : (optionCounts().get(kind()) ?? null);
  });
  const trailing = (k: OptionKind): string | undefined => {
    const c = optionCounts().get(k);
    return c ? fileCountLabel(c.matched) : undefined;
  };
  const tracked = () => trackedNote(current()?.tracked ?? 0);

  // ---- target file
  const targetLabel = (t: IgnoreTarget): string => (t === "gitignore" ? `${repoName}/.gitignore` : ".git/info/exclude");
  const [existing] = createResource(target, (t) => api.readIgnoreFile(props.repoId, t));
  createEffect(() => {
    if (existing.state === "ready") setIgnoreCase(existing()?.ignoreCase ?? false);
  });
  const existingText = (): string | null => (existing.state === "ready" ? (existing()?.content ?? "") : null);
  const readError = (): string | null => (existing.state === "errored" ? ((existing.error as { message?: string })?.message ?? String(existing.error)) : null);
  const split = createMemo(() => {
    const text = existingText();
    return text === null ? null : splitKnown(text, lines());
  });
  const knownNote = (): string | null => {
    const s = split();
    if (!s || s.known.length === 0) return null;
    const where = targetLabel(target());
    if (s.fresh.length === 0) return lines().length === 1 ? `This pattern is already in ${where}.` : `These patterns are already in ${where}.`;
    return `${s.known.length} of ${lines().length} patterns are already in ${where}. DeepGit skips them.`;
  };
  const canSubmit = () => !busy() && lines().length > 0 && (split()?.fresh.length ?? 0) > 0;

  const submit = async (): Promise<void> => {
    if (!canSubmit()) return;
    setBusy(true);
    setFailure(null);
    const t = target();
    try {
      const added = await api.appendIgnoreRules(props.repoId, t, lines());
      const name = TARGET_NAME[t];
      if (added.length === 0) {
        toast({ kind: "info", title: `Nothing new for ${name}`, body: `${targetLabel(t)} has these patterns already.` });
      } else {
        toast({
          kind: "success",
          title: addedTitle(added, name),
          body: t === "gitignore" ? `${targetLabel(t)}. Commit it when you are ready.` : `${targetLabel(t)} of ${repoName}. The rule stays on this computer.`,
          actions: t === "gitignore" ? [{ label: "Open .gitignore", onClick: () => openFileInFiles(props.repoId, ".gitignore") }] : undefined,
        });
      }
      props.close({ target: t, added });
    } catch (e) {
      setFailure((e as { message?: string })?.message ?? String(e));
      setBusy(false);
    }
  };

  const where = (): string => (several ? `${items.length} files` : items[0].path.replace(/^\/+|\/+$/g, ""));

  return (
    <Dialog
      title="Add to .gitignore"
      width="wide"
      onClose={() => props.close()}
      primary={{ label: "Add to .gitignore", disabled: !canSubmit(), onClick: () => void submit() }}
    >
      <div class="dg-dialogs-text dg-selectable">
        <strong>{repoName}</strong> <span class="dg-dialogs-ign-path">›</span> <span class="dg-dialogs-mono">{where()}</span>
      </div>
      <Field label="Pattern">
        <RadioGroup name="ignore-pattern" label="Pattern" value={kind()} onChange={pick} options={radios} trailing={trailing} />
        <Show when={kind() === "custom"}>
          <Show
            when={several}
            fallback={<TextField class="dg-dialogs-mono" value={custom()} onInput={setCustom} aria-label="Custom pattern" spellcheck={false} />}
          >
            <TextArea value={custom()} onInput={setCustom} rows={4} ariaLabel="Custom patterns, one on each line" />
          </Show>
        </Show>
      </Field>
      <Field label="Add to">
        <Select
          class="dg-dialogs-select"
          ariaLabel="Add to"
          value={target()}
          onChange={setTarget}
          options={[
            { value: "gitignore", label: `${targetLabel("gitignore")} (repository root)` },
            { value: "exclude", label: `${targetLabel("exclude")} (only on this computer)` },
          ]}
        />
      </Field>
      <Show when={lines().length > 0}>
        <div class="dg-dialogs-field">
          <span class="dg-dialogs-text">
            {lines().length === 1 ? "This line goes" : "These lines go"} at the end of {targetLabel(target())}:
          </span>
          <div class="dg-dialogs-ign-preview dg-selectable" aria-label="Lines to add">
            <For each={lines()}>{(l) => <span>{l}</span>}</For>
          </div>
        </div>
      </Show>
      <Show when={knownNote()}>{(n) => <Note kind="info">{n()}</Note>}</Show>
      <Show when={tracked()}>{(n) => <Note kind="warning">{n()}</Note>}</Show>
      <Show when={readError()}>{(n) => <Note kind="error">{n()}</Note>}</Show>
      <Show when={failure()}>{(n) => <Note kind="error">{n()}</Note>}</Show>
    </Dialog>
  );
}
