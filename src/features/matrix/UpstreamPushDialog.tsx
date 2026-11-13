/**
 * Matrix "Push and set upstream" (ITERATION-3.md section 7.3, 7.4): pushes one branch to a remote in many repos with
 * `-u`. The dialog stays open while it runs and shows the status of every repo; the matrix gets the progress through
 * `onStart`, `onRepoDone` and `onEnd` (sweep line, red rings). While it runs, Cancel is "Stop": the pushes that have
 * not started are skipped, the ones running end normally.
 */
import { For, type JSX, Show, createMemo, createSignal, onMount } from "solid-js";
import * as api from "../../api/tauri";
import { Dialog, type DialogComponentProps, Icon, RepoIcon, Select, Spinner, plural, toast } from "../../components/ui";
import { notifyRepoChanged } from "../../state/events";
import { openBottomTool } from "../../state/layout";
import { refreshRefs, repoRefs } from "../../state/refs";
import { beginRepoOp } from "../../state/repoBusy";
import { refreshSummaries, repoById } from "../../state/workspace";
import { Field, RepoChecklist } from "../dialogs/parts";
import {
  MAX_PARALLEL_PUSHES, commitsText, defaultRemote, planUpstreamRows, remoteNames, remotesOf, runUpstreamPushes, summarizeRun,
  type RowStatus,
} from "./upstreamPush";

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
  const rowOf = (id: string) => rows().find((r) => r.repoId === id);
  const enabled = () => rows().filter((r) => r.enabled).map((r) => r.repoId);

  // all enabled rows are checked; changing the remote checks them again
  const [unchecked, setUnchecked] = createSignal<string[]>([]);
  const picked = () => enabled().filter((id) => !unchecked().includes(id));
  const setPicked = (ids: string[]) => setUnchecked(enabled().filter((id) => !ids.includes(id)));

  const [phase, setPhase] = createSignal<Phase>("form");
  const [stopped, setStopped] = createSignal(false);
  const [statuses, setStatuses] = createSignal<Record<string, RowStatus>>({});
  const [counts, setCounts] = createSignal<Record<string, string>>({});

  // commits that are on no remote, one cheap `rev-list --count` per repo
  onMount(() => {
    let next = 0;
    const worker = async () => {
      while (next < props.repoIds.length) {
        const id = props.repoIds[next++];
        try {
          const n = await api.unpushedCount(id, props.branch);
          setCounts((c) => ({ ...c, [id]: commitsText(n) }));
        } catch {
          // no count: the row just shows no detail
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_PUSHES, props.repoIds.length) }, worker));
  });

  const detail = (id: string): string => rowOf(id)?.reason ?? counts()[id] ?? "";

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
    const result = await runUpstreamPushes(
      ids,
      (id) => pushOne(id, to),
      (id, s) => {
        setStatuses((all) => ({ ...all, [id]: s }));
        if (s.kind === "done") props.onRepoDone(id, null);
        else if (s.kind === "failed") props.onRepoDone(id, s.full);
      },
      MAX_PARALLEL_PUSHES,
      stopped,
    );
    props.onEnd();
    setPhase("done");
    const sum = summarizeRun(props.branch, to, result, nameOf);
    toast({ kind: sum.kind, title: sum.title, body: sum.body, actions: sum.console ? [{ label: "Show in console", onClick: () => openBottomTool("console") }] : undefined });
  };

  // Cancel closes the form; while the pushes run it stops the ones that have not started
  const onClose = () => {
    if (phase() === "running") setStopped(true);
    else props.close();
  };

  const primary = () => {
    if (phase() === "running") return { label: "Pushing…", disabled: true, onClick: () => undefined };
    if (phase() === "done") return { label: "Close", onClick: () => props.close() };
    return { label: `Push to ${plural(picked().length, "repository", "repositories")}`, disabled: picked().length === 0, onClick: () => void submit() };
  };

  const statusIcon = (s: RowStatus | undefined): JSX.Element => (
    <span class="dg-matrix-up-icon">
      {!s ? null : s.kind === "queued" || s.kind === "skipped" ? <i class="dg-matrix-up-ring" /> : s.kind === "running" ? <Spinner size={14} /> : s.kind === "done" ? <Icon name="check" size={14} class="is-ok" /> : <Icon name="error" size={14} class="is-bad" />}
    </span>
  );

  const statusText = (s: RowStatus): { text: string; tip?: string; cls: string } => {
    if (s.kind === "queued") return { text: "Queued", cls: "" };
    if (s.kind === "skipped") return { text: "Skipped", cls: "" };
    if (s.kind === "running") return { text: "Pushing…", cls: "" };
    if (s.kind === "done") return { text: `Upstream set to ${remote()}/${props.branch}`, cls: "is-ok" };
    return { text: s.message, tip: s.full, cls: "is-bad" };
  };

  return (
    <Dialog
      title="Push and set upstream"
      width="wide"
      onClose={onClose}
      cancel={phase() !== "done"}
      cancelLabel={phase() === "running" ? "Stop" : "Cancel"}
      primary={primary()}
    >
      <div class="dg-matrix-up">
        <div class="dg-dialogs-text">Push "{props.branch}" and set it as the upstream branch.</div>
        <Field label="Remote">
          <Select class="dg-dialogs-select" ariaLabel="Remote" value={remote()} disabled={phase() !== "form"} onChange={(v) => { setRemote(v); setUnchecked([]); }} options={options()} />
        </Field>
        <Show
          when={phase() === "form"}
          fallback={
            <div class="dg-dialogs-checklist dg-matrix-up-list" role="list">
              <For each={props.repoIds}>
                {(id) => {
                  const status = () => statuses()[id];
                  const st = () => (status() ? statusText(status()!) : null);
                  return (
                    <div class="dg-matrix-up-row" classList={{ "is-disabled": !rowOf(id)?.enabled }} role="listitem">
                      {statusIcon(status())}
                      <RepoIcon />
                      <span class="dg-dialogs-repo-name">{nameOf(id)}</span>
                      <span class="dg-matrix-up-detail">{detail(id)}</span>
                      <Show when={st()}>
                        {(t) => <span class={`dg-matrix-up-status ${t().cls}`} data-tip={t().tip}>{t().text}</span>}
                      </Show>
                    </div>
                  );
                }}
              </For>
            </div>
          }
        >
          <RepoChecklist repoIds={props.repoIds} picked={picked()} onChange={setPicked} detail={detail} disabled={(id) => !rowOf(id)?.enabled} />
        </Show>
      </div>
    </Dialog>
  );
}
