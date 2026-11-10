/**
 * Commit message editor and commit bar (DESIGN.md 5.12): message with a subject counter and a 72 column ruler,
 * Amend, "Commit" (Ctrl+Enter) and "Commit and Push" (Ctrl+Alt+K). One message goes to every repo that has
 * staged changes. The draft is kept per project in `localStorage` (`deepgit.draft.<projectId>`).
 */
import { For, type JSX, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import * as api from "../../api/tauri";
import type { RepoInfo } from "../../api/types";
import { Button, Checkbox, Icon, Splitter, plural, toast } from "../../components/ui";
import * as actions from "../../state/actions";
import { register } from "../../state/keymap";
import { mainTab } from "../../state/selection";
import { activeProject, repoColor, summary } from "../../state/workspace";
import { SUBJECT_LIMIT, commitLabel, subjectLength } from "./model";

export interface CommitTarget {
  repo: RepoInfo;
  /** Number of staged files. */
  staged: number;
}

export interface CommitBoxProps {
  /** Repos with staged changes: the commit goes to all of them. */
  targets: () => CommitTarget[];
  /** Repo used by "Amend" when nothing is staged anywhere. */
  fallback: () => RepoInfo | undefined;
  /** Height in px of the whole box (targets, editor, bar); the editor takes what the rest leaves. */
  height: () => number;
  onHeight: (h: number) => void;
  /** Smallest and largest box height: the file list above keeps its own minimum. */
  minHeight: () => number;
  maxHeight: () => number;
  /** Very short island: one-line subject field next to the buttons, no target row. */
  compact: () => boolean;
  /** Right end of the target row (stash button). */
  aside?: JSX.Element;
}

/** Box height before the user drags the splitter. */
export const DEFAULT_HEIGHT = 184;

const draftKey = (projectId: string): string => `deepgit.draft.${projectId}`;

function loadDraft(projectId: string | undefined): string {
  if (!projectId) return "";
  try {
    return localStorage.getItem(draftKey(projectId)) ?? "";
  } catch {
    return "";
  }
}

function saveDraft(projectId: string | undefined, message: string): void {
  if (!projectId) return;
  try {
    if (message) localStorage.setItem(draftKey(projectId), message);
    else localStorage.removeItem(draftKey(projectId));
  } catch {
    /* ignore */
  }
}

export function CommitBox(props: CommitBoxProps): JSX.Element {
  const projectId = () => activeProject()?.id;
  const [message, setMessage] = createSignal(loadDraft(projectId()));
  const [amend, setAmend] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  let area: HTMLTextAreaElement | undefined;
  /** Message loaded by "Amend": removed again when Amend is switched off without edits. */
  let amendLoaded = "";

  // a different project has a different draft
  createEffect(on(projectId, (id) => {
    setMessage(loadDraft(id));
    setAmend(false);
  }, { defer: true }));

  const edit = (value: string) => {
    setMessage(value);
    saveDraft(projectId(), value);
  };

  const commitRepos = createMemo<RepoInfo[]>(() => {
    const t = props.targets();
    if (t.length > 0) return t.map((x) => x.repo);
    const f = amend() ? props.fallback() : undefined;
    return f ? [f] : [];
  });

  const subjectLen = () => subjectLength(message());
  const overLimit = () => subjectLen() > SUBJECT_LIMIT;
  const hasMessage = () => message().trim().length > 0;
  const blocker = (): string | null => {
    if (busy()) return "A commit is running.";
    if (commitRepos().length === 0) return "Nothing is staged. Stage files first, or tick Amend.";
    if (!hasMessage()) return "Write a commit message first.";
    return null;
  };
  const canCommit = () => blocker() === null;

  const onAmend = async (on: boolean) => {
    setAmend(on);
    if (on) {
      const repo = commitRepos()[0] ?? props.fallback();
      if (!repo || hasMessage()) return;
      try {
        const text = (await api.lastCommitMessage(repo.id)).trim();
        if (amend() && !hasMessage()) {
          amendLoaded = text;
          edit(text);
        }
      } catch (e) {
        toast({ kind: "error", title: "Could not read the last commit message", body: e instanceof Error ? e.message : String(e) });
      }
    } else if (amendLoaded && message().trim() === amendLoaded) {
      edit("");
      amendLoaded = "";
    }
  };

  const run = async (push: boolean) => {
    if (!canCommit()) return;
    const repos = commitRepos();
    setBusy(true);
    try {
      const r = await actions.commit(repos.map((x) => x.id), message().trim(), { amend: amend() });
      if (r.cancelled || r.ok.length === 0) return;
      if (r.failed.length === 0) {
        edit("");
        setAmend(false);
        amendLoaded = "";
      }
      if (push) await actions.push(r.ok);
    } finally {
      setBusy(false);
    }
  };

  const active = () => mainTab() === "changes";
  const offs = [
    register("changes.focusMessage", "Ctrl+M", () => area?.focus(), { title: "Focus the commit message", group: "Local changes", when: active, allowInInput: true }),
    register("changes.commit", "Ctrl+Enter", () => void run(false), { title: "Commit", group: "Local changes", when: active, allowInInput: true }),
    register("changes.commitPush", "Ctrl+Alt+K", () => void run(true), { title: "Commit and push", group: "Local changes", when: active, allowInInput: true }),
  ];
  onCleanup(() => offs.forEach((off) => off()));

  const summaryLine = () => {
    const only = commitRepos()[0];
    return only ? summary(only.id)?.branch ?? "detached HEAD" : "";
  };

  return (
    <div class="dg-changes-commit" classList={{ "is-compact": props.compact() }} style={props.compact() ? undefined : { height: props.height() + "px" }}>
      <Show when={!props.compact()}>
        <Splitter orientation="horizontal" reverse size={props.height()} onSize={props.onHeight} min={props.minHeight()} max={props.maxHeight} defaultSize={DEFAULT_HEIGHT} persistKey="changesCommit" />
      </Show>
      <div class="dg-changes-targets" aria-live="polite" hidden={props.compact()}>
        <Show
          when={commitRepos().length > 0}
          fallback={<span class="dg-changes-targets-none">{amend() ? "No repository to amend" : "Nothing staged"}</span>}
        >
          <Show
            when={commitRepos().length > 1}
            fallback={
              <>
                <Icon name="branch" size={14} class="dg-changes-targets-icon" />
                <span class="dg-changes-targets-label">{amend() ? "Amend on" : "Commit on"}</span>
                <span class="dg-changes-targets-branch">{summaryLine()}</span>
              </>
            }
          >
            <span class="dg-changes-targets-label">{amend() ? "Amend in" : "Commit to"} {plural(commitRepos().length, "repo")}</span>
            <For each={commitRepos()}>
              {(r) => (
                <span class="dg-changes-target" title={`${r.name}: ${plural(props.targets().find((t) => t.repo.id === r.id)?.staged ?? 0, "staged file")}`}>
                  <i class="dg-changes-target-dot" style={{ background: repoColor(r) }} />
                  {r.name}
                </span>
              )}
            </For>
          </Show>
        </Show>
        <span class="dg-grow" />
        {props.aside}
      </div>
      <div class="dg-changes-editor">
        <textarea
          ref={area}
          class="dg-changes-message"
          placeholder={props.compact() ? "Commit message (subject)" : "Commit message"}
          aria-label="Commit message"
          spellcheck={true}
          value={message()}
          onInput={(e) => edit(e.currentTarget.value)}
        />
        <Show when={message().length > 0 && !props.compact()}>
          <span
            class="dg-changes-counter"
            classList={{ "is-over": overLimit() }}
            title={overLimit() ? `The subject line is over ${SUBJECT_LIMIT} characters` : "Length of the subject line"}
          >
            {subjectLen()} / {SUBJECT_LIMIT}
          </span>
        </Show>
      </div>
      <div class="dg-changes-bar">
        <Checkbox checked={amend()} onChange={(v) => void onAmend(v)} label="Amend" title="Replace the last commit instead of adding a new one" />
        <span class="dg-grow" />
        <Button
          variant="primary"
          disabled={!canCommit()}
          title={blocker() ?? (amend() ? "Amend the last commit" : "Commit the staged changes")}
          shortcut="Ctrl+Enter"
          onClick={() => void run(false)}
        >
          {commitLabel(commitRepos().length, amend())}
        </Button>
        <Button
          disabled={!canCommit()}
          title={blocker() ?? "Commit, then push"}
          shortcut="Ctrl+Alt+K"
          onClick={() => void run(true)}
        >
          {amend() ? "Amend and Push" : "Commit and Push"}
        </Button>
      </div>
    </div>
  );
}
