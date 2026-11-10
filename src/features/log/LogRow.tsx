/**
 * Rows of the log: the commit row (graph, subject with ref pills, repository, author, date, hash), the date group row
 * and the "Uncommitted changes" row. All three share the grid of the column header (CSS variables on `.dg-log`).
 */
import { For, type JSX, Show, createMemo } from "solid-js";
import type { CommitRow, GraphRow } from "../../api/types";
import { Avatar, RefPills, RepoChip, formatDateTime, formatLogDate, plural, shortOid } from "../../components/ui";
import { type GraphMetrics, type NodeKind, passThroughShape, rowGraphShape } from "./graph";
import type { DisplayMap } from "./dateGroups";
import { splitMatches } from "./query";
import { pillBudget, pillWidths, visiblePills } from "./pills";
import { isHeadRow } from "./scan";

export interface WipInfo {
  /** Dirty repos among the selected ones, in sidebar order. */
  repos: { id: string; name: string; color: number }[];
  files: number;
  /** Lane of the HEAD node the dashed edge connects to, and the commit index of that HEAD. */
  lane: number;
  headRow: number | null;
}

export interface RowCtx {
  rowAt: (ci: number) => CommitRow | undefined;
  displayMap: () => DisplayMap;
  metrics: () => GraphMetrics;
  graphWidth: () => number;
  /** Width in px of the subject column (the ref pills take a share of it). */
  subjectWidth: () => number;
  /** Smallest width the subject text keeps next to the pills, in px. */
  minSubject: () => number;
  /** Combined log: spine, repository column and by-repository lane colours. */
  multiRepo: () => boolean;
  /** CSS colour of a lane colour index; `owner` is the repo of the node when it is known (by-repository colours). */
  laneColor: (color: number, owner?: string) => string;
  repoColor: (repoId: string) => string;
  /** Repo colour index (0..11), for `RepoChip`. */
  repoIdx: (repoId: string) => number;
  repoName: (repoId: string) => string;
  isSelected: (key: string) => boolean;
  needle: () => string;
  wip: () => WipInfo | null;
  onRowClick: (e: MouseEvent, ci: number, row: CommitRow) => void;
  onRowMenu: (e: MouseEvent, ci: number, row: CommitRow) => void;
  onRowOpen: (row: CommitRow) => void;
  onRefMenu: (e: MouseEvent, ci: number, row: CommitRow) => void;
  onSpine: (e: MouseEvent, repoId: string) => void;
  onWipClick: () => void;
}

// ---------------------------------------------------------------- graph cell

function Node(props: { x: number; y: number; color: string; kind: NodeKind; m: GraphMetrics }): JSX.Element {
  return (
    <>
      <Show when={props.kind === "head"}>
        <circle cx={props.x} cy={props.y} r={props.m.ring} class="dg-log-node-ring" stroke={props.color} />
      </Show>
      <circle
        cx={props.x}
        cy={props.y}
        r={props.kind === "head" ? props.m.head : props.m.node}
        class={`dg-log-node is-${props.kind}`}
        fill={props.kind === "merge" ? undefined : props.color}
        stroke={props.kind === "merge" ? props.color : undefined}
      />
    </>
  );
}

function GraphSvg(props: { ctx: RowCtx; graph: GraphRow; kind: NodeKind; repoId: string; dashedTop?: { x: number } | null }): JSX.Element {
  const shape = createMemo(() => rowGraphShape(props.graph, props.kind, props.ctx.metrics()));
  const w = () => props.ctx.graphWidth();
  const h = () => props.ctx.metrics().rowHeight;
  return (
    <svg class="dg-log-graph" width={w()} height={h()} viewBox={`0 0 ${w()} ${h()}`} aria-hidden="true">
      <g class="dg-log-edges">
        <Show when={props.dashedTop}>
          {(d) => <path class="dg-log-wip-edge" d={`M${d().x} 0V${h() / 2}`} />}
        </Show>
        <For each={shape().edges}>{(e) => <path d={e.d} stroke={props.ctx.laneColor(e.color)} />}</For>
      </g>
      <Node x={shape().node.x} y={shape().node.y} color={props.ctx.laneColor(shape().node.color, props.repoId)} kind={props.kind} m={props.ctx.metrics()} />
    </svg>
  );
}

// ---------------------------------------------------------------- commit row

function accessibleName(r: CommitRow, repo: string): string {
  const refs = r.refs.map((x) => x.name).join(", ");
  return `${r.subject}, ${repo}, ${r.authorName}, ${formatLogDate(r.authorTime)}${refs ? ", " + refs : ""}`;
}

function CommitRowBody(props: { ctx: RowCtx; ci: number; row: CommitRow }): JSX.Element {
  const r = props.row;
  const ctx = props.ctx;
  const key = r.repoId + ":" + r.oid;
  const head = isHeadRow(r);
  const kind: NodeKind = head ? "head" : r.parents.length > 1 ? "merge" : "normal";
  const dashedTop = () => {
    const wip = ctx.wip();
    if (!wip || wip.headRow !== props.ci || ctx.displayMap().displayOf(props.ci) > 2) return null;
    return { x: (wip.lane + 1) * ctx.metrics().lane };
  };
  const dateTip = () => {
    const a = formatDateTime(r.authorTime);
    return r.committerTime !== r.authorTime ? `Authored ${a}\nCommitted ${formatDateTime(r.committerTime)}` : a;
  };
  const pillSpace = () => pillBudget(ctx.subjectWidth(), ctx.minSubject());
  const pillMax = () => visiblePills(pillWidths(r.refs), pillSpace());
  const refsTip = () => r.refs.map((x) => x.name).join("\n");
  const graphTip = () => `${r.oid}\n${r.authorName}${r.refs.length ? "\n" + r.refs.map((x) => x.name).join(", ") : ""}`;
  return (
    <div
      class="dg-log-row"
      classList={{ "is-selected": ctx.isSelected(key), "is-head": head, "is-merge": kind === "merge" }}
      role="row"
      aria-selected={ctx.isSelected(key)}
      aria-label={accessibleName(r, ctx.repoName(r.repoId))}
      onClick={(e) => ctx.onRowClick(e, props.ci, r)}
      onDblClick={() => ctx.onRowOpen(r)}
      onContextMenu={(e) => ctx.onRowMenu(e, props.ci, r)}
    >
      <span
        class="dg-log-spine"
        classList={{ "is-on": ctx.multiRepo() }}
        style={{ background: ctx.multiRepo() ? ctx.repoColor(r.repoId) : undefined }}
        data-tip={ctx.multiRepo() ? ctx.repoName(r.repoId) : undefined}
        onClick={(e) => ctx.multiRepo() && ctx.onSpine(e, r.repoId)}
      />
      <span class="dg-log-gcell" data-tip={graphTip()} role="gridcell">
        <GraphSvg ctx={ctx} graph={r.graph} kind={kind} repoId={r.repoId} dashedTop={dashedTop()} />
      </span>
      <span class="dg-log-subject" role="gridcell">
        <span class="dg-log-subj">
          <Show when={ctx.needle()} fallback={r.subject}>
            <For each={splitMatches(r.subject, ctx.needle())}>{(p) => (p.match ? <mark class="dg-log-match">{p.text}</mark> : p.text)}</For>
          </Show>
        </span>
        <Show when={r.refs.length > 0}>
          <span class="dg-log-refs" style={{ "max-width": pillSpace() + "px" }} title={refsTip()} onContextMenu={(e) => ctx.onRefMenu(e, props.ci, r)}>
            <RefPills refs={r.refs} max={pillMax()} />
          </span>
        </Show>
      </span>
      <span class="dg-log-repo" role="gridcell">
        <Show when={ctx.multiRepo()}>
          <RepoChip name={ctx.repoName(r.repoId)} color={ctx.repoIdx(r.repoId)} />
        </Show>
      </span>
      <span class="dg-log-author" role="gridcell">
        <Avatar name={r.authorName} email={r.authorEmail} />
        <span class="dg-log-aname">{r.authorName}</span>
      </span>
      <span class="dg-log-date" role="gridcell" data-tip={dateTip()}>{formatLogDate(r.authorTime)}</span>
      <span class="dg-log-hash" role="gridcell">{shortOid(r.oid)}</span>
      <span />
    </div>
  );
}

export function CommitRowView(props: { ctx: RowCtx; ci: number }): JSX.Element {
  const row = createMemo(() => props.ctx.rowAt(props.ci));
  return (
    <Show when={row()} keyed fallback={<div class="dg-log-row is-loading" aria-busy="true" />}>
      {(r) => <CommitRowBody ctx={props.ctx} ci={props.ci} row={r} />}
    </Show>
  );
}

// ---------------------------------------------------------------- date group row

export function DateRowView(props: { ctx: RowCtx; display: number; group: number; label: string }): JSX.Element {
  const ctx = props.ctx;
  /** The commit below the group row: its lanes continue through this row. */
  const below = createMemo(() => ctx.rowAt(ctx.displayMap().groupStarts[props.group] ?? -1));
  const lines = createMemo(() => {
    const r = below();
    return r ? passThroughShape(r.graph, ctx.metrics()) : [];
  });
  const wipLine = () => {
    const wip = ctx.wip();
    // The dashed edge of the "Uncommitted changes" row runs through the first group row.
    return wip && props.display === 1 ? (wip.lane + 1) * ctx.metrics().lane : null;
  };
  return (
    <div class="dg-log-row is-date" role="row" aria-label={props.label}>
      <span class="dg-log-spine" />
      <span class="dg-log-gcell">
        <svg class="dg-log-graph" width={ctx.graphWidth()} height={ctx.metrics().rowHeight} aria-hidden="true">
          <g class="dg-log-edges">
            <Show when={wipLine()}>{(x) => <path class="dg-log-wip-edge" d={`M${x()} 0V${ctx.metrics().rowHeight}`} />}</Show>
            <For each={lines()}>{(e) => <path d={e.d} stroke={ctx.laneColor(e.color)} />}</For>
          </g>
        </svg>
      </span>
      <span class="dg-log-datelabel">{props.label}</span>
    </div>
  );
}

// ---------------------------------------------------------------- uncommitted changes row

const stripes = (colors: string[]): string => `repeating-linear-gradient(180deg, ${colors.map((c, i) => `${c} calc(${i} * var(--dg-log-stripe)) calc(${i + 1} * var(--dg-log-stripe))`).join(", ")})`;

export function WipRowView(props: { ctx: RowCtx; wip: WipInfo }): JSX.Element {
  const ctx = props.ctx;
  const colors = () => props.wip.repos.map((r) => `var(--dg-repo-${r.color % 12})`);
  const w = () => ctx.graphWidth();
  const h = () => ctx.metrics().rowHeight;
  const x = () => (props.wip.lane + 1) * ctx.metrics().lane;
  return (
    <div class="dg-log-row is-wip" role="row" tabindex={-1} aria-label="Uncommitted changes" onClick={() => ctx.onWipClick()}>
      <span class="dg-log-spine" classList={{ "is-on": ctx.multiRepo() }} style={{ background: ctx.multiRepo() ? stripes(colors()) : undefined }} />
      <span class="dg-log-gcell">
        <svg class="dg-log-graph" width={w()} height={h()} aria-hidden="true">
          <path class="dg-log-wip-edge" d={`M${x()} ${h() / 2}V${h()}`} />
          <circle class="dg-log-wip-node" cx={x()} cy={h() / 2} r={ctx.metrics().node} />
        </svg>
      </span>
      <span class="dg-log-subject">
        <span class="dg-log-wip-t">Uncommitted changes</span>
        <span class="dg-log-wip-n">
          {plural(props.wip.files, "file")}
          <Show when={props.wip.repos.length > 1}> in {plural(props.wip.repos.length, "repo")}</Show>
        </span>
      </span>
      <span class="dg-log-repo">
        <Show when={ctx.multiRepo()}>
          <span class="dg-log-dots is-row">
            <For each={props.wip.repos.slice(0, 4)}>{(r) => <i style={{ background: `var(--dg-repo-${r.color % 12})` }} />}</For>
          </span>
          <span class="dg-log-wip-n">{props.wip.repos.length === 1 ? props.wip.repos[0].name : plural(props.wip.repos.length, "repo")}</span>
        </Show>
      </span>
      <span class="dg-log-author" />
      <span class="dg-log-date">now</span>
      <span class="dg-log-hash" />
      <span />
    </div>
  );
}
