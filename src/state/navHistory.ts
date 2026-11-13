/**
 * Back / forward history of where the user has been (like the back and forward buttons of an IDE). Pure: the wiring to
 * the views, the mouse buttons and the keys is in `navigation.ts`.
 *
 * A history has one current location, a back stack and a forward stack. `record(loc)` makes `loc` the current location
 * and puts the old one on the back stack; it clears the forward stack. `back()` and `forward()` move the current
 * location between the stacks and return the location to show.
 */

/** Where the user is: a main view, plus the commit selected in the log or the file open in the Files view. */
export interface NavLocation {
  /** The main view: "log", "changes" or "files". */
  view: string;
  /** Log view: the selected commit (`stash` is the index when the commit is a stash). */
  commit?: { repoId: string; oid: string; stash?: number };
  /** Files view: the file in the active tab. */
  file?: { repoId: string; path: string };
}

export const NAV_LIMIT = 100;

/** True when both locations are the same place. */
export function sameLocation(a: NavLocation | null | undefined, b: NavLocation | null | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.view === b.view &&
    a.commit?.repoId === b.commit?.repoId &&
    a.commit?.oid === b.commit?.oid &&
    a.commit?.stash === b.commit?.stash &&
    a.file?.repoId === b.file?.repoId &&
    a.file?.path === b.file?.path
  );
}

export interface NavHistory {
  /** The location the history is at now, or null before the first `record`. */
  current(): NavLocation | null;
  canBack(): boolean;
  canForward(): boolean;
  /** Records a new location. The same location as the current one is ignored. Clears the forward stack. */
  record(loc: NavLocation): void;
  /** Replaces the current location without touching the stacks (the place restored is not exactly what was stored). */
  settle(loc: NavLocation): void;
  /** Goes one step back and returns that location, or null when there is none. `valid` skips (and drops) dead locations. */
  back(valid?: (loc: NavLocation) => boolean): NavLocation | null;
  /** Goes one step forward and returns that location, or null when there is none. `valid` skips (and drops) dead locations. */
  forward(valid?: (loc: NavLocation) => boolean): NavLocation | null;
  clear(): void;
}

export function createNavHistory(limit: number = NAV_LIMIT): NavHistory {
  let cur: NavLocation | null = null;
  let backStack: NavLocation[] = [];
  let fwdStack: NavLocation[] = [];

  /** Takes the next valid location of `from`; dead ones on the way are dropped. The old current goes to `to`. */
  function step(from: NavLocation[], to: NavLocation[], valid?: (loc: NavLocation) => boolean): NavLocation | null {
    while (from.length > 0) {
      const target = from.pop()!;
      if (valid && !valid(target)) continue;
      if (cur) {
        to.push(cur);
        if (to.length > limit) to.shift();
      }
      cur = target;
      return target;
    }
    return null;
  }

  return {
    current: () => cur,
    canBack: () => backStack.length > 0,
    canForward: () => fwdStack.length > 0,
    record(loc) {
      if (sameLocation(cur, loc)) return;
      if (cur) {
        backStack.push(cur);
        if (backStack.length > limit) backStack.shift();
      }
      cur = loc;
      fwdStack = [];
    },
    settle(loc) {
      cur = loc;
    },
    back: (valid) => step(backStack, fwdStack, valid),
    forward: (valid) => step(fwdStack, backStack, valid),
    clear() {
      cur = null;
      backStack = [];
      fwdStack = [];
    },
  };
}
