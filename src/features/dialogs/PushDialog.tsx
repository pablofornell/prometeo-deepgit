/** Push: remote, branch and upstream per repo, commits to push, set upstream, force with lease, tags. */
import { For, type JSX, Show, createMemo, createResource, createSignal } from "solid-js";
import * as api from "../../api/tauri";
import { Checkbox, Dialog, type DialogComponentProps, Icon, Select, type SelectOption, plural, shortOid } from "../../components/ui";
import type { PushProps, PushResult } from "../../state/dialogs";
import { planPush, remoteOfUpstream, type PushPlan } from "../../state/pushPlan";
import { repoRefs } from "../../state/refs";
import { repoById, summary } from "../../state/workspace";
import { gitCmd, perRepo } from "./command";
import { Field, Note, RepoRows } from "./parts";

const remoteOf = (id: string): string | null => remoteOfUpstream(summary(id)?.upstream, repoRefs(id)());

export function PushDialog(props: PushProps & DialogComponentProps<PushResult>): JSX.Element {
  const [force, setForce] = createSignal(false);
  const [tags, setTags] = createSignal(false);
  const single = () => props.repoIds.length === 1;
  const branchOf = (id: string): string | null => props.branch ?? summary(id)?.branch ?? null;
  const noUpstream = (id: string): boolean => !!summary(id) && !plan(id).upstream;
  // what `actions.push` will do per repo: its own branch, its own upstream (a non-HEAD branch has its own tracking data)
  const plan = (id: string): PushPlan => {
    const s = summary(id);
    return planPush(
      { branch: s?.branch ?? null, upstream: s?.upstream ?? null, ahead: s?.ahead ?? 0, local: repoRefs(id)()?.local, refs: repoRefs(id)() },
      { remote: null, branch: props.branch ?? null, force: force(), setUpstream: false, tags: tags() },
    );
  };

  const remotes = createMemo(() => {
    const set = new Set<string>();
    for (const id of props.repoIds) for (const r of repoRefs(id)()?.remotes ?? []) set.add(r.name);
    if (set.size === 0) set.add("origin");
    return [...set];
  });
  const defaultRemote = (): string => {
    const tracked = props.repoIds.map(remoteOf).find((r): r is string => !!r);
    return tracked ?? (remotes().includes("origin") ? "origin" : remotes()[0]);
  };
  const [remote, setRemote] = createSignal(defaultRemote());
  const [setUpstream, setSetUpstream] = createSignal(props.repoIds.some(noUpstream));
  const remoteOptions = createMemo<SelectOption<string>[]>(() => {
    const list = remotes().includes(remote()) ? remotes() : [remote(), ...remotes()];
    return list.map((r) => ({ value: r, label: r, icon: "remote" }));
  });

  // every repo already tracks the chosen remote: leave remote/branch to git
  // (not when a branch tracks a differently named upstream: a plain `git push` would refuse or hit the wrong branch)
  const useDefaults = () => !props.branch && props.repoIds.every((id) => remoteOf(id) === remote() && !plan(id).retargetedFrom);
  // several repos: `branch: null` lets the action resolve each repo's own current branch
  const branch = (): string | null => props.branch ?? (single() ? branchOf(props.repoIds[0]) : null);

  const aheadTotal = () => props.repoIds.reduce((n, id) => n + plan(id).ahead, 0);
  const allTracked = () => props.repoIds.every((id) => !!plan(id).upstream);
  // every repo would be skipped (nothing ahead, or detached)
  const nothing = () => props.repoIds.every((id) => plan(id).skip !== null);

  // the commits themselves: cheap for one repo with an upstream (one `git log upstream..branch`)
  const [outgoing] = createResource(
    () => {
      if (!single()) return null;
      const id = props.repoIds[0];
      const p = plan(id);
      return p.upstream && p.branch && p.ahead > 0 ? { id, range: `${p.upstream}..${p.branch}` } : null;
    },
    async ({ id, range }) => {
      try {
        const info = await api.logOpen({ repoIds: [id], refs: [range], maxCount: 8 });
        try {
          return { total: info.total, rows: await api.logRows(info.sessionId, 0, 8) };
        } finally {
          void api.logClose(info.sessionId).catch(() => undefined);
        }
      } catch {
        return null;
      }
    },
  );

  const label = (): string => {
    const n = aheadTotal();
    const count = allTracked() && n > 0 ? ` ${plural(n, "commit")}` : "";
    return force() ? `Force push${count}` : `Push${count}`;
  };

  // every repo shows its own branch: repos of one push can be on different branches
  const command = () =>
    perRepo(props.repoIds.filter((id) => !!repoById(id)), (id) =>
      gitCmd(repoById(id)?.name ?? id, [
        "push", force() && "--force-with-lease", (setUpstream() || noUpstream(id)) && "-u", tags() && "--tags",
        !useDefaults() && remote(), !useDefaults() && branchOf(id),
      ]),
    );

  const submit = () =>
    props.close({
      remote: useDefaults() ? null : remote(),
      branch: useDefaults() ? null : branch(),
      force: force(),
      setUpstream: setUpstream(),
      tags: tags(),
    });

  return (
    <Dialog
      title="Push"
      onClose={() => props.close()}
      command={command()}
      width="wide"
      primary={{ label: label(), danger: force(), disabled: nothing(), onClick: submit }}
    >
      <Field label="Remote">
        <Select class="dg-dialogs-select" ariaLabel="Remote" value={remote()} onChange={setRemote} options={remoteOptions()} />
      </Field>
      <RepoRows
        rows={props.repoIds.map((id) => ({
          repoId: id,
          detail: (
            <>
              <Icon name="branch" size={12} />
              <span class="dg-dialogs-mono dg-dialogs-ellipsis">{branchOf(id) ?? "detached HEAD"}</span>
              <Icon name="arrowRight" size={12} />
              <span class="dg-dialogs-mono dg-dialogs-ellipsis">{plan(id).upstream ?? (setUpstream() || noUpstream(id) ? `${remote()}/${branchOf(id) ?? ""} (new)` : "no upstream")}</span>
            </>
          ),
          trailing: plan(id).upstream ? (plan(id).ahead > 0 ? plural(plan(id).ahead, "commit") : "up to date") : undefined,
        }))}
      />
      <Show when={outgoing()?.rows.length ? outgoing() : null}>
        {(o) => (
          <Field label={`Commits to push (${o().total})`}>
            <div class="dg-dialogs-commits">
              <For each={o().rows}>
                {(r) => (
                  <div class="dg-dialogs-commit">
                    <span class="dg-dialogs-commit-subject">{r.subject}</span>
                    <span class="dg-dialogs-commit-hash">{shortOid(r.oid)}</span>
                  </div>
                )}
              </For>
              <Show when={o().total > o().rows.length}>
                <div class="dg-dialogs-hint">and {o().total - o().rows.length} more</div>
              </Show>
            </div>
          </Field>
        )}
      </Show>
      <div class="dg-dialogs-options">
        <Checkbox checked={setUpstream()} onChange={setSetUpstream} label="Set upstream (track the remote branch)" />
        <Checkbox checked={tags()} onChange={setTags} label="Push tags" />
        <Checkbox checked={force()} onChange={setForce} label={<span classList={{ "dg-dialogs-danger-label": force() }}>Force with lease</span>} />
      </div>
      <For each={props.repoIds.filter((id) => plan(id).retargetedFrom)}>
        {(id) => (
          <Note kind="info">
            {repoById(id)?.name ?? id}: {branchOf(id)} tracks {plan(id).retargetedFrom}. It is pushed to {remote()}/{branchOf(id)} instead and tracks that from now on.
          </Note>
        )}
      </For>
      <Show when={force()}>
        <Note kind="error">Force with lease overwrites the remote branch, but only if nobody else pushed to it since your last fetch.</Note>
      </Show>
      <Show when={nothing()}>
        <Note kind="info">Everything is already pushed.</Note>
      </Show>
    </Dialog>
  );
}
