/**
 * Small git-specific display parts shared by log, sidebar, details, palette and matrix:
 * RepoChip, RepoSquare, RefPill / RefPills, AheadBehind, StatusLetter.
 */
import { For, type JSX, Show } from "solid-js";
import type { FileStatus, RefLabel } from "../../api/types";
import { Icon } from "./Icon";
import { repoColorVar, statusColorVar, statusLetter } from "./util";

export interface RepoChipProps {
  name: string;
  /** Repo colour index (`RepoInfo.color`). */
  color: number;
  title?: string;
}

/**
 * Repository chip: tinted background, repo-colour text (DESIGN.md 4.1 rule 6).
 *
 *   <RepoChip name={repo.name} color={repo.color} />
 */
export function RepoChip(props: RepoChipProps): JSX.Element {
  return (
    <span class="dg-repochip" style={{ "--rc": repoColorVar(props.color) }} title={props.title ?? props.name}>
      {props.name}
    </span>
  );
}

/** 10x10 rounded colour square of a repo (sidebar rows, status bar). `<RepoSquare color={repo.color} />` */
export function RepoSquare(props: { color: number; size?: number }): JSX.Element {
  const s = () => (props.size ?? 10) + "px";
  return <span class="dg-repo-square" style={{ background: repoColorVar(props.color), width: s(), height: s() }} />;
}

export interface RefPillProps {
  label: RefLabel;
  /** For a local branch whose upstream points at the same commit: shows the cloud mark. */
  synced?: boolean;
}

/**
 * One ref pill (DESIGN.md 5.5): HEAD, current branch, local branch, remote branch, tag, stash.
 *
 *   <RefPill label={{ kind: "tag", name: "v3.12.0", isCurrent: false }} />
 */
export function RefPill(props: RefPillProps): JSX.Element {
  const l = () => props.label;
  const cls = () => (l().kind === "head" ? "head" : l().kind === "local" ? (l().isCurrent ? "cur" : "local") : l().kind);
  return (
    <span class={`dg-ref dg-ref-${cls()}`} title={props.synced ? `${l().name} and origin/${l().name}` : l().name}>
      <Show when={l().kind === "local"}>
        <Icon name="branch" size={11} />
      </Show>
      <Show when={l().kind === "remote"}>
        <Icon name="remote" size={11} />
      </Show>
      <Show when={l().kind === "tag"}>
        <Icon name="tag" size={11} />
      </Show>
      <Show when={l().kind === "stash"}>
        <Icon name="stash" size={11} />
      </Show>
      <span class="dg-ref-text">{l().name}</span>
      <Show when={props.synced}>
        <Icon name="remote" size={11} class="dg-ref-sync" />
      </Show>
    </span>
  );
}

const KIND_ORDER: Record<RefLabel["kind"], number> = { head: 0, local: 1, remote: 2, tag: 3, stash: 4 };

export interface RefPillsProps {
  refs: RefLabel[];
  /** Pills shown before "+N" (default 2). */
  max?: number;
}

/**
 * The ref pills of a commit row with the DESIGN.md rules: split HEAD pill when a branch is checked out,
 * synced pill (local + same-named remote merged), order head/local/remote/tag, "+N" overflow with a tooltip.
 *
 *   <RefPills refs={row.refs} />
 */
export function RefPills(props: RefPillsProps): JSX.Element {
  const items = () => {
    const refs = [...props.refs].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
    const remotes = new Set(refs.filter((r) => r.kind === "remote").map((r) => r.name));
    const used = new Set<string>();
    const out: { key: string; render: () => JSX.Element; text: string }[] = [];
    for (const r of refs) {
      if (r.kind === "remote" && used.has(r.name)) continue;
      if (r.kind === "local") {
        const synced = [...remotes].some((n) => n === "origin/" + r.name || n.endsWith("/" + r.name));
        if (synced) for (const n of remotes) if (n === "origin/" + r.name || n.endsWith("/" + r.name)) used.add(n);
        if (r.isCurrent) {
          out.push({
            key: "cur:" + r.name,
            text: r.name,
            render: () => (
              <span class="dg-ref dg-ref-split" title={`HEAD -> ${r.name}`}>
                <span class="dg-ref-head">HEAD</span>
                <span class="dg-ref-cur">
                  <Icon name="branch" size={11} />
                  <span class="dg-ref-text">{r.name}</span>
                  <Show when={synced}>
                    <Icon name="remote" size={11} class="dg-ref-sync" />
                  </Show>
                </span>
              </span>
            ),
          });
          continue;
        }
        out.push({ key: "l:" + r.name, text: r.name, render: () => <RefPill label={r} synced={synced} /> });
        continue;
      }
      out.push({ key: r.kind + ":" + r.name, text: r.name, render: () => <RefPill label={r} /> });
    }
    return out;
  };
  const max = () => props.max ?? 2;
  return (
    <span class="dg-refs">
      <For each={items().slice(0, max())}>{(it) => it.render()}</For>
      <Show when={items().length > max()}>
        <span class="dg-ref dg-ref-more" title={items().map((i) => i.text).join("\n")}>
          +{items().length - max()}
        </span>
      </Show>
    </span>
  );
}

export interface AheadBehindProps {
  ahead: number;
  behind: number;
  /** Upstream name for the tooltip ("origin/main"). */
  upstream?: string | null;
}

const cap = (n: number) => (n > 999 ? "999+" : String(n));

/**
 * Ahead/behind capsule (DESIGN.md 5.4): `↑3 ↓1`; renders nothing when both are 0.
 *
 *   <AheadBehind ahead={s.ahead} behind={s.behind} upstream={s.upstream} />
 */
export function AheadBehind(props: AheadBehindProps): JSX.Element {
  const title = () =>
    `${props.ahead} commit${props.ahead === 1 ? "" : "s"} to push${props.upstream ? " to " + props.upstream : ""}. ${props.behind} to pull.`;
  return (
    <Show when={props.ahead > 0 || props.behind > 0}>
      <span class="dg-ab" classList={{ "is-diverged": props.ahead > 0 && props.behind > 0 }} title={title()}>
        <Show when={props.ahead > 0}>
          <span class="dg-ab-up">↑{cap(props.ahead)}</span>
        </Show>
        <Show when={props.behind > 0}>
          <span class="dg-ab-down">↓{cap(props.behind)}</span>
        </Show>
      </span>
    </Show>
  );
}

/** Status letter (A, M, D, R, C, U, ?, !, T) in the file-status colour. `<StatusLetter status="modified" />` */
export function StatusLetter(props: { status: FileStatus }): JSX.Element {
  return (
    <span class="dg-status-letter" style={{ color: statusColorVar(props.status) }} title={props.status}>
      {statusLetter(props.status)}
    </span>
  );
}
