/**
 * Matrix "Push and set upstream" (ITERATION-3.md section 7.3, 7.4): pushes one branch to a remote in many repos with
 * `-u`. The dialog stays open while it runs and shows the status of every repo; the matrix gets the progress through
 * `onStart`, `onRepoDone` and `onEnd` (sweep line, red rings).
 */
import { For, type JSX, Show, createMemo, createSignal, onMount } from "solid-js";
import * as api from "../../api/tauri";
import { Checkbox, Dialog, type DialogComponentProps, Icon, RepoIcon, Select, Spinner, plural, toast } from "../../components/ui";
import { notifyRepoChanged } from "../../state/events";
import { openBottomTool } from "../../state/layout";
import { refreshRefs, repoRefs } from "../../state/refs";
import { beginRepoOp } from "../../state/repoBusy";
import { refreshSummaries, repoById } from "../../state/workspace";
import { Field } from "../dialogs/parts";
import {
  MAX_PARALLEL_PUSHES, commitsText, countUnpushed, defaultRemote, planUpstreamRows, remoteNames, remotesOf, runUpstreamPushes, summarizeRun,
  type RowStatus,
} from "./upstreamPush";

/** Commits read per repo to count the ones that are on no remote. */
const COUNT_LIMIT = 300;

export interface UpstreamPushProps {
  branch: string;
  /** Repos of the column where the branch is local, has no upstream and the repo is not busy. */
  repoIds: string[];
  onStart: () => void;
  /** A repo ended: `error` is the full git error, or null when it worked. */
  onRepoDone: (repoId: string, error: string | null) => void;
  onEnd: () => void;
}

type Phase = "form" | "running" | "done";

export function UpstreamPushDialog(props: UpstreamPushProps & DialogComponentProps<void>): JSX.Element {
  const nameOf = (id: string): string => repoById(id)?.name ?? id;
  const remotesById = (id: string): string[] => remotesOf(repoRefs(id)());
  const names = createMemo(() => remoteNames(props.repoIds.map(remotesById)));
  const [remote, setRemote] = createSignal(defaultRemote(names()));
  const options = createMemo(() => {
    const list = names().includes(remote()) ? names() : [remote(), ...names()];
    return list.map((r) => ({ value: r, label: r, icon: "remote" as const }));
  });
  const rows = createMemo(() => planUpstreamRows(props.repoIds.map((repoId) => ({ repoId, remotes: remotesById(repoId) })), remote()));
  const enabled = () => rows().filter((r) => r.enabled).map((r) => r.repoId);

  // all enabled rows are checked; changing the remote checks them again
  const [unchecked, setUnchecked] = createSignal<string[]>([]);
  const picked = () => enabled().filter((id) => !unchecked().includes(id));
  const toggle = (id: string, on: boolean) => setUnchecked((u) => (on ? u.filter((x) => x !== id) : [...u, id]));

  const [phase, setPhase] = createSignal<Phase>("form");
  const [statuses, setStatuses] = createSignal<Record<string, RowStatus>>({});
  const [counts, setCounts] = createSignal<Record<string, string>>({});

  // commits that are on no remote, one cheap log per repo
  onMount(() => {
    let next = 0;
    const worker = async () => {
      while (next < props.repoIds.length) {
        const id = props.repoIds[next++];
        try {
          const info = await api.logOpen({ repoIds: [id], refs: [props.branch], maxCount: COUNT_LIMIT });
          try {
            const list = await api.logRows(info.sessionId, 0, COUNT_LIMIT);
            setCounts((c) => ({ ...c, [id]: commitsText(countUnpushed(list, list.length >= COUNT_LIMIT)) }));
          } finally {
            void api.logClose(info.sessionId).catch(() => undefined);
          }
        } catch {
          // no count: the row just shows no detail
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_PUSHES, props.repoIds.length) }, worker));
  });

  const pushOne = async (id: string, to: string) => {
    const end = beginRepoOp(id);
    try {
      const r = await api.push(id, { remote: to, branch: props.branch, setUpstream: true });
      return { ok: r.ok, message: r.message };
    } finally {
      end();
      // the cell of this repo changes now, not when the last push ends
      notifyRepoChanged(id);
      void refreshRefs(id).catch(() => undefined);
      void refreshSummaries([id]);
    }
  };

  const submit = async () => {
    const ids = picked();
    if (phase() !== "form" || ids.length === 0) return;
    const to = remote();
    setPhase("running");
    props.onStart();
    const result = await runUpstreamPushes(ids, (id) => pushOne(id, to), (id, s) => {
      setStatuses((all) => ({ ...all, [id]: s }));
      if (s.kind === "done") props.onRepoDone(id, null);
      else if (s.kind === "failed") props.onRepoDone(id, s.full);
    });
    props.onEnd();
    setPhase("done");
    const sum = summarizeRun(props.branch, to, result, nameOf);
    toast({ kind: sum.kind, title: sum.title, body: sum.body, actions: sum.console ? [{ label: "Show in console", onClick: () => openBottomTool("console") }] : undefined });
  };

  const primary = () => {
    if (phase() === "running") return { label: "Pushing…", disabled: true, onClick: () => undefined };
    if (phase() === "done") return { label: "Close", onClick: () => props.close() };
    return { label: `Push to ${plural(picked().length, "repository", "repositories")}`, disabled: picked().length === 0, onClick: () => void submit() };
  };

  const statusIcon = (s: RowStatus | undefined): JSX.Element => {
    if (!s) return <span class="dg-matrix-up-icon" />;
    return (
      <span class="dg-matrix-up-icon">
        {s.kind === "queued" ? <i class="dg-matrix-up-ring" /> : s.kind === "running" ? <Spinner size={14} /> : s.kind === "done" ? <Icon name="check" size={14} class="is-ok" /> : <Icon name="error" size={14} class="is-bad" />}
      </span>
    );
  };

  const statusText = (s: RowStatus): { text: string; tip?: string; cls: string } => {
    if (s.kind === "queued") return { text: "Queued", cls: "" };
    if (s.kind === "running") return { text: "Pushing…", cls: "" };
    if (s.kind === "done") return { text: `Upstream set to ${remote()}/${props.branch}`, cls: "is-ok" };
    return { text: s.message, tip: s.full, cls: "is-bad" };
  };

  return (
    <Dialog title="Push and set upstream" width="wide" onClose={() => props.close()} primary={primary()}>
      <div class="dg-matrix-up" classList={{ "dg-matrix-up-done": phase() === "done" }}>
        <div class="dg-dialogs-text">Push "{props.branch}" and set it as the upstream branch.</div>
        <Field label="Remote">
          <Select class="dg-dialogs-select" ariaLabel="Remote" value={remote()} disabled={phase() !== "form"} onChange={(v) => { setRemote(v); setUnchecked([]); }} options={options()} />
        </Field>
        <div class="dg-dialogs-checklist dg-matrix-up-list" role="list">
          <For each={rows()}>
            {(row) => {
              const status = () => statuses()[row.repoId];
              const st = () => (status() ? statusText(status()!) : null);
              return (
                <div class="dg-matrix-up-row" classList={{ "is-disabled": !row.enabled }} role="listitem">
                  <Show
                    when={phase() === "form"}
                    fallback={statusIcon(status())}
                  >
                    <Checkbox checked={picked().includes(row.repoId)} disabled={!row.enabled} onChange={(on) => toggle(row.repoId, on)} ariaLabel={nameOf(row.repoId)} />
                  </Show>
                  <RepoIcon />
                  <span class="dg-dialogs-repo-name">{nameOf(row.repoId)}</span>
                  <span class="dg-matrix-up-detail">{row.reason ?? counts()[row.repoId] ?? ""}</span>
                  <Show when={st()}>
                    {(t) => <span class={`dg-matrix-up-status ${t().cls}`} data-tip={t().tip}>{t().text}</span>}
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      </div>
    </Dialog>
  );
}
