/** Pure geometry for submenu hover (no DOM): keeps a submenu open while the pointer travels diagonally towards it. */

export interface Pt {
  x: number;
  y: number;
}

export interface EdgeRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** True when `p` lies inside (or on) the triangle a-b-c. */
export function inTriangle(p: Pt, a: Pt, b: Pt, c: Pt): boolean {
  const side = (u: Pt, v: Pt) => (p.x - v.x) * (u.y - v.y) - (u.x - v.x) * (p.y - v.y);
  const d1 = side(a, b);
  const d2 = side(b, c);
  const d3 = side(c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/**
 * True when the pointer, now at `cur`, is heading from `prev` into the submenu panel `sub`: `cur` is inside the
 * triangle made of `prev` and the near edge of the panel. Moving diagonally to a submenu crosses other items of the
 * parent menu; those must not close the submenu.
 */
export function movingToward(prev: Pt | null, cur: Pt, sub: EdgeRect): boolean {
  if (!prev) return false;
  const edgeX = prev.x <= sub.left ? sub.left : sub.right;
  return inTriangle(cur, prev, { x: edgeX, y: sub.top }, { x: edgeX, y: sub.bottom });
}
