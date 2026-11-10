/**
 * Pure geometry of the commit graph (DESIGN.md 5.6). Each log row draws its own small SVG from its `GraphRow`:
 * lane `n` has its centre at `(n + 1) * laneWidth`, `y` 0 / 1 / 2 are the top edge, the centre and the bottom edge
 * of the row. Straight lanes are lines; a segment that changes lane is a cubic Bezier
 * `M x1 y1 C x1 ymid, x2 ymid, x2 y2` so it leaves and enters vertically.
 */
import type { CommitRow, GraphRow } from "../../api/types";
import { cssPx } from "../../state/metrics";

export { cssPx };

export interface GraphMetrics {
  /** Distance between two lane centres. */
  lane: number;
  /** Commit node radius. */
  node: number;
  /** Radius of the filled HEAD node. */
  head: number;
  /** Radius of the HEAD ring. */
  ring: number;
  /** Edge stroke width. */
  edge: number;
  /** Row height in px. */
  rowHeight: number;
}

export const DEFAULT_METRICS: GraphMetrics = { lane: 14, node: 4, head: 4.5, ring: 7, edge: 2, rowHeight: 24 };

/** Reads the graph tokens (`--dg-log-lane-width`, ...) from the document. */
export function readGraphMetrics(rowHeight: number): GraphMetrics {
  const lane = cssPx("--dg-log-lane-width", DEFAULT_METRICS.lane);
  const node = cssPx("--dg-log-node-radius", DEFAULT_METRICS.node);
  return { lane, node, head: node + 0.5, ring: lane / 2, edge: cssPx("--dg-log-edge-width", DEFAULT_METRICS.edge), rowHeight };
}

export type NodeKind = "normal" | "merge" | "head";

export interface EdgePath {
  d: string;
  /** Unbounded lane colour index (`GraphSegment.color`). */
  color: number;
}

export interface RowGraphShape {
  edges: EdgePath[];
  node: { x: number; y: number; color: number; kind: NodeKind };
}

export const laneX = (lane: number, m: GraphMetrics): number => (lane + 1) * m.lane;

const fmt = (n: number): string => String(Math.round(n * 100) / 100);

/** SVG path of one segment. */
export function segmentPath(x1: number, y1: number, x2: number, y2: number, m: GraphMetrics): string {
  const ax = laneX(x1, m);
  const bx = laneX(x2, m);
  const ay = (y1 * m.rowHeight) / 2;
  const by = (y2 * m.rowHeight) / 2;
  if (ax === bx) return `M${fmt(ax)} ${fmt(ay)}V${fmt(by)}`;
  const mid = (ay + by) / 2;
  return `M${fmt(ax)} ${fmt(ay)}C${fmt(ax)} ${fmt(mid)} ${fmt(bx)} ${fmt(mid)} ${fmt(bx)} ${fmt(by)}`;
}

/** One path per colour, so a row has a handful of DOM nodes. */
function mergeByColor(items: { d: string; color: number }[]): EdgePath[] {
  const byColor = new Map<number, string>();
  for (const it of items) byColor.set(it.color, (byColor.get(it.color) ?? "") + it.d);
  return [...byColor].map(([color, d]) => ({ d, color }));
}

/** Edges and node of a commit row. */
export function rowGraphShape(g: GraphRow, kind: NodeKind, m: GraphMetrics): RowGraphShape {
  const edges = mergeByColor(g.segments.map((s) => ({ d: segmentPath(s.x1, s.y1, s.x2, s.y2, m), color: s.color })));
  return { edges, node: { x: laneX(g.node, m), y: m.rowHeight / 2, color: g.color, kind } };
}

/** Lanes that enter a row from above, drawn as straight lines through a group row (the graph continues through it). */
export function passThroughShape(g: GraphRow, m: GraphMetrics): EdgePath[] {
  const seen = new Set<number>();
  const out: { d: string; color: number }[] = [];
  for (const s of g.segments) {
    if (s.y1 !== 0 || seen.has(s.x1)) continue;
    seen.add(s.x1);
    out.push({ d: `M${fmt(laneX(s.x1, m))} 0V${fmt(m.rowHeight)}`, color: s.color });
  }
  return mergeByColor(out);
}

/** Width in px of the graph column for `lanes` visible lanes: `16 + lanes x 14`, min 30, max 220. */
export function autoGraphWidth(lanes: number, m: GraphMetrics = DEFAULT_METRICS): number {
  return Math.min(220, Math.max(30, 16 + Math.max(1, lanes) * m.lane));
}

/** Widest row (in lanes) of a list of rows. */
export function maxLanesOf(rows: readonly (CommitRow | undefined)[]): number {
  let n = 0;
  for (const r of rows) if (r && r.graph.width > n) n = r.graph.width;
  return n;
}
