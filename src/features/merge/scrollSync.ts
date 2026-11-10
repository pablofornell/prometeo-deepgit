/**
 * Scroll sync of the three panes (IntelliJ aligns the starts of the changes). Pure, no DOM.
 *
 * A change is a region with a different length in every pane, so the panes cannot scroll by the same number of
 * pixels. The model gives anchor points (the start and end line of every change in the Result, Yours and Theirs);
 * a line of one pane is placed in another pane by moving linearly between the two anchors around it.
 */
import type { MergeModel } from "./model";

/** Index of each pane in an anchor: `[result, left, right]`. */
export const COL = { result: 0, left: 1, right: 2 } as const;
export type Col = (typeof COL)[keyof typeof COL];

/** `[result, left, right]` line numbers of every change start and end, never decreasing. */
export function anchorsOf(model: MergeModel): number[][] {
  const a: number[][] = [[0, 0, 0]];
  const push = (x: number[]) => {
    const last = a[a.length - 1];
    a.push([Math.max(last[0], x[0]), Math.max(last[1], x[1]), Math.max(last[2], x[2])]);
  };
  for (const c of model.chunks) {
    push([c.start, c.left.start, c.right.start]);
    push([c.end, c.left.end, c.right.end]);
  }
  push([model.result.length, model.leftLines.length, model.rightLines.length]);
  return a;
}

/** Where line `x` (may be fractional) of column `from` is in column `to`. */
export function mapLine(a: readonly number[][], from: Col, to: Col, x: number): number {
  for (let i = 0; i < a.length - 1; i++) {
    const f0 = a[i][from];
    const f1 = a[i + 1][from];
    // a region that is empty in the source pane (an insertion elsewhere): its start in the other pane
    if (x < f1 || (f0 === f1 && x === f0)) {
      if (f1 === f0) return a[i][to];
      return a[i][to] + ((x - f0) / (f1 - f0)) * (a[i + 1][to] - a[i][to]);
    }
  }
  const last = a[a.length - 1];
  return last[to] + (x - last[from]);
}
