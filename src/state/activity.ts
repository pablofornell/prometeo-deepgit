/**
 * Running operations, for the status bar progress widget (DESIGN.md 5.17).
 * `actions.ts` creates one per multi-repo operation; features normally only read `activities()`.
 *
 *   const a = beginActivity("Fetching 12 repositories", 12);
 *   a.step(); …; a.end();
 */
import { createSignal } from "solid-js";

export interface Activity {
  id: number;
  label: string;
  done: number;
  total: number;
}

const [list, setList] = createSignal<readonly Activity[]>([]);
let seq = 0;

/** Operations that are running now (reactive), oldest first. */
export const activities = list;

export interface ActivityHandle {
  /** Marks one more item as done. */
  step(): void;
  /** Removes the activity. */
  end(): void;
}

export function beginActivity(label: string, total: number): ActivityHandle {
  const id = ++seq;
  setList((l) => [...l, { id, label, done: 0, total }]);
  return {
    step: () => setList((l) => l.map((a) => (a.id === id ? { ...a, done: Math.min(a.total, a.done + 1) } : a))),
    end: () => setList((l) => l.filter((a) => a.id !== id)),
  };
}
