/**
 * Operation banners (DESIGN.md 5.5): one per selected repo with a merge, rebase, cherry-pick, revert or bisect in
 * progress. More than 2 collapse into one line with "Show". Buttons call `actions.opContinue / opAbort / opSkip`.
 */
import { For, type JSX, Show, createMemo, createSignal } from "solid-js";
import type { RepoStateKind, SkippedRepo } from "../../api/types";
import { Button, Icon, plural } from "../../components/ui";
import * as actions from "../../state/actions";
import { setChangesRepoId, setMainTab } from "../../state/selection";
import { repoById, selectedRepoIds, summary, toggleRepo } from "../../state/workspace";

const WORD: Record<Exclude<RepoStateKind, "clean">, string> = {
  merging: "merge",
  rebasing: "rebase",
  cherryPicking: "cherry-pick",
  reverting: "revert",
  bisecting: "bisect",
};

/** Repos whose Continue failed because of unresolved conflicts: their banner turns red until the state changes. */
const [failed, setFailed] = createSignal<Set<string>>(new Set());

function resolveConflicts(repoId: string): void {
  setChangesRepoId(repoId);
  setMainTab("changes");
}

async function run(repoId: string, op: "continue" | "abort" | "skip"): Promise<void> {
  const res = await (op === "continue" ? actions.opContinue(repoId) : op === "abort" ? actions.opAbort(repoId) : actions.opSkip(repoId));
  const bad = res.failed.length > 0 || res.conflicts.length > 0;
  setFailed((s) => {
    const n = new Set(s);
    if (op === "continue" && bad) n.add(repoId);
    else n.delete(repoId);
    return n;
  });
}

function RepoBanner(props: { repoId: string }): JSX.Element {
  const s = () => summary(props.repoId);
  const kind = () => (s() && s()!.state !== "clean" ? WORD[s()!.state as Exclude<RepoStateKind, "clean">] : "");
  const conflicts = () => s()?.conflicted ?? 0;
  const isError = () => failed().has(props.repoId) && conflicts() > 0;
  return (
    <div class="dg-log-banner" classList={{ "is-error": isError() }} role="status">
      <Icon name={isError() ? "error" : "warning"} size={16} class="dg-log-banner-icon" />
      <span class="dg-log-banner-text">
        <b>{repoById(props.repoId)?.name ?? props.repoId}</b>: {kind()} in progress.
        <Show when={conflicts() > 0}> {plural(conflicts(), "file")} {conflicts() === 1 ? "has" : "have"} conflicts.</Show>
      </span>
      <span class="dg-grow" />
      <Show when={conflicts() > 0}>
        <Button size="small" variant="primary" onClick={() => resolveConflicts(props.repoId)}>Resolve conflicts</Button>
      </Show>
      <Show when={s()?.state !== "bisecting"}>
        <Button size="small" onClick={() => void run(props.repoId, "continue")}>Continue</Button>
      </Show>
      <Show when={s()?.state === "rebasing" || s()?.state === "cherryPicking"}>
        <Button size="small" onClick={() => void run(props.repoId, "skip")}>Skip</Button>
      </Show>
      <Button size="small" onClick={() => void run(props.repoId, "abort")}>Abort</Button>
    </div>
  );
}

export function OperationBanners(): JSX.Element {
  const busy = createMemo(() => selectedRepoIds().filter((id) => {
    const st = summary(id)?.state;
    return st !== undefined && st !== "clean";
  }));
  const [expanded, setExpanded] = createSignal(false);
  return (
    <Show when={busy().length > 0}>
      <Show
        when={busy().length <= 2 || expanded()}
        fallback={
          <div class="dg-log-banner" role="status">
            <Icon name="warning" size={16} class="dg-log-banner-icon" />
            <span class="dg-log-banner-text">{busy().length} repos have an operation in progress.</span>
            <span class="dg-grow" />
            <Button size="small" onClick={() => setExpanded(true)}>Show</Button>
          </div>
        }
      >
        <For each={busy()}>{(id) => <RepoBanner repoId={id} />}</For>
      </Show>
    </Show>
  );
}

/** Repos the log session could not read (the others are shown): one compact warning with Retry and Hide repo. */
export function SkippedBanner(props: { skipped: readonly SkippedRepo[]; onRetry: () => void }): JSX.Element {
  const name = (r: SkippedRepo) => repoById(r.repoId)?.name ?? r.repoId;
  const text = () => props.skipped.map((r) => `${name(r)} — ${r.message}`).join("\n");
  // The repo filter always keeps one repo: hiding is offered while another one stays.
  const canHide = () => selectedRepoIds().length > props.skipped.filter((r) => selectedRepoIds().includes(r.repoId)).length;
  const hide = () => props.skipped.forEach((r) => toggleRepo(r.repoId));
  return (
    <Show when={props.skipped.length > 0}>
      <div class="dg-log-banner" role="status" title={text()}>
        <Icon name="warning" size={16} class="dg-log-banner-icon" />
        <span class="dg-log-banner-text">
          {plural(props.skipped.length, "repository", "repositories")} could not be loaded:{" "}
          <b>{props.skipped.map(name).join(", ")}</b>
          <Show when={props.skipped.length === 1}> — {props.skipped[0].message}</Show>
        </span>
        <span class="dg-grow" />
        <Button size="small" onClick={props.onRetry}>Retry</Button>
        <Show when={canHide()}>
          <Button size="small" onClick={hide}>{props.skipped.length === 1 ? "Hide repo" : "Hide repos"}</Button>
        </Show>
      </div>
    </Show>
  );
}
