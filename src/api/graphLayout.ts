/**
 * Lane layout of the commit graph: TS port of PLAN.md section 6 (crates/gitcore/src/graph.rs).
 * Used by the browser mock; the desktop app gets the same `GraphRow`s from the Rust side.
 *
 *   const rows = layoutGraph([{ key: "a", parents: ["b"] }, { key: "b", parents: [] }]);
 */
import type { GraphRow, GraphSegment } from "./types";

/** One commit in display order (newest first). `key` must be unique (repoId + oid). */
export interface GraphInput {
  key: string;
  parents: string[];
}

export interface GraphLayout {
  rows: GraphRow[];
  /** Widest row, in lanes. */
  maxLanes: number;
}

interface Lane {
  expect: string;
  color: number;
}

function seg(x1: number, y1: number, x2: number, y2: number, color: number): GraphSegment {
  return { x1, y1, x2, y2, color };
}

/** First empty slot at or after `from`, or the index a push would get. */
function firstFree(lanes: (Lane | null)[], from: number): number {
  for (let i = from; i < lanes.length; i++) if (lanes[i] === null) return i;
  return Math.max(lanes.length, from);
}

function setLane(lanes: (Lane | null)[], slot: number, lane: Lane): void {
  while (lanes.length <= slot) lanes.push(null);
  lanes[slot] = lane;
}

export interface GraphOptions {
  /**
   * Deviation from PLAN.md section 6 (off by default): when the first parent is already expected by a lane
   * to the RIGHT of the node, keep the node's lane instead of moving the chain into that lane. Both lanes then
   * converge at the parent's row. This keeps a long first-parent chain (main) in a stable column instead of
   * drifting right every time a branch lane happens to sit on the same parent.
   */
  stableFirstParent?: boolean;
}

/**
 * Computes the graph row of every input row. `hints[i]`, when defined, is the colour a lane
 * started by row `i` gets instead of the next sequential colour.
 */
export function layoutGraph(rows: readonly GraphInput[], hints: readonly (number | undefined)[] = [], opts: GraphOptions = {}): GraphLayout {
  const lanes: (Lane | null)[] = [];
  let nextColor = 0;
  const out: GraphRow[] = [];
  let maxLanes = 0;

  for (let i = 0; i < rows.length; i++) {
    const { key, parents } = rows[i];
    const segments: GraphSegment[] = [];

    // 1. Lanes expecting this commit; allocate one when none does.
    const matches: number[] = [];
    for (let l = 0; l < lanes.length; l++) if (lanes[l]?.expect === key) matches.push(l);
    const isNew = matches.length === 0;
    if (isNew) {
      const hint = hints[i];
      const color = hint !== undefined ? hint : nextColor++;
      const slot = firstFree(lanes, 0);
      setLane(lanes, slot, { expect: key, color });
      matches.push(slot);
    }
    const node = matches[0];
    const nodeColor = lanes[node]?.color ?? 0;

    // 2. Top half: every matching lane converges on the node.
    if (!isNew) {
      for (const m of matches) segments.push(seg(m, 0, node, 1, lanes[m]?.color ?? nodeColor));
    }

    // 3. Pass-through lanes.
    for (let l = 0; l < lanes.length; l++) {
      const lane = lanes[l];
      if (lane && !matches.includes(l)) segments.push(seg(l, 0, l, 2, lane.color));
    }

    // 4. Free the matching lanes.
    for (const m of matches) lanes[m] = null;

    // 5. Parents.
    for (let pi = 0; pi < parents.length; pi++) {
      const parent = parents[pi];
      const existing = lanes.findIndex((l) => l !== null && l.expect === parent);
      if (existing >= 0 && !(opts.stableFirstParent && pi === 0 && existing > node)) {
        segments.push(seg(node, 1, existing, 2, lanes[existing]?.color ?? nodeColor));
      } else if (pi === 0) {
        setLane(lanes, node, { expect: parent, color: nodeColor });
        segments.push(seg(node, 1, node, 2, nodeColor));
      } else {
        const slot = firstFree(lanes, node + 1);
        const color = nextColor++;
        setLane(lanes, slot, { expect: parent, color });
        segments.push(seg(node, 1, slot, 2, color));
      }
    }

    // 6. Trim and measure.
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
    let maxX = node;
    for (const s of segments) maxX = Math.max(maxX, s.x1, s.x2);
    const width = maxX + 1;
    if (width > maxLanes) maxLanes = width;
    out.push({ node, color: nodeColor, segments, width });
  }
  return { rows: out, maxLanes };
}
