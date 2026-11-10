/**
 * The three-way merge model (a port of IntelliJ's `MergeConflictModel`, `MergeModelBase` and
 * `MergeRangeUtil`). Pure, no DOM, no Solid.
 *
 *   const m = new MergeModel(baseText, leftText, rightText);   // left = Yours, right = Theirs
 *   m.chunks                       // regions where the versions differ, with their type and state
 *   m.resultText()                 // the Result pane: starts as the base text
 *   m.applyNonConflicting("all");  // apply every change that only one side made
 *   m.applyChange(2, "left");      // ">>" on chunk 2; a conflict stays open until the other side is applied or ignored
 *   m.magicResolve(3);             // merge a conflict at word level, when the two sides changed different words
 *   m.documentChanged(l1, l2, shift, newLines)   // the Result pane was edited by hand (see below)
 *   m.resultWithMarkers({ left: "main", right: "feature" })   // text to save, unresolved conflicts as <<<<<<< blocks
 *
 * Texts are LF-only strings (`normalizeText`); a text is split on "\n", so a file that ends with a newline has a
 * final empty line, the same as a CodeMirror document. The Result pane starts as the base. A chunk is resolved
 * once both sides are applied or ignored (a side that did not change is resolved from the start).
 */
import { tryResolveText } from "./resolve";
import { intern, mergeRangesFromDiffs, diffSeq, type MergeRange } from "./seqDiff";

export type Side = "left" | "right";
export type ChangeType = "inserted" | "deleted" | "modified" | "conflict";

/** Half-open range of lines. */
export interface LineRange {
  start: number;
  end: number;
}

export interface MergeType {
  type: ChangeType;
  /** The left (Yours) version differs from the base here. */
  leftChange: boolean;
  rightChange: boolean;
  /** A conflict that word-level merging can resolve (never when a side deleted the lines). */
  resolvable: boolean;
}

export interface Chunk {
  index: number;
  left: LineRange;
  base: LineRange;
  right: LineRange;
  type: ChangeType;
  leftChange: boolean;
  rightChange: boolean;
  resolvable: boolean;
  resolvedLeft: boolean;
  resolvedRight: boolean;
  /** A conflict where one side was applied first: the other side is appended. */
  onesideApplied: boolean;
  /** Resolved by editing the Result pane by hand (undone when the edit is undone). */
  byHand: boolean;
  /** Where the chunk is in the Result pane now. */
  start: number;
  end: number;
}

export type Which = "left" | "right" | "all";

/** An edit of the Result pane, as lines (see `MergeModel.documentEdits`). */
export interface LineEdit {
  oldLine1: number;
  oldLine2: number;
  shift: number;
}

export const MARKER_START = "<<<<<<<";
export const MARKER_MIDDLE = "=======";
export const MARKER_END = ">>>>>>>";

// ---------------------------------------------------------------- text helpers

/** `crlf` files are edited with LF line ends; `saveResolution` converts back. Other files are left alone. */
export function normalizeText(text: string, eol: "lf" | "crlf"): string {
  return eol === "crlf" ? text.replace(/\r\n/g, "\n") : text;
}

export const linesOf = (text: string): string[] => text.split("\n");

const sameLines = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

// ---------------------------------------------------------------- classification

const slice = (lines: readonly string[], r: readonly [number, number]) => lines.slice(r[0], r[1]);

/**
 * What kind of change a merge range is (IntelliJ `MergeRangeUtil.getMergeType`, default policy):
 *
 *   base empty:  one side empty -> inserted by the other; both inserted the same -> inserted (no conflict); else conflict
 *   base kept:   both sides empty -> deleted; a side equal to the base -> modified / deleted by the other side;
 *                both changed the same way -> modified (no conflict); else conflict
 */
export function classify(base: readonly string[], left: readonly string[], right: readonly string[], r: MergeRange): MergeType {
  const b = slice(base, r.base);
  const l = slice(left, r.left);
  const rt = slice(right, r.right);
  const [lEmpty, bEmpty, rEmpty] = [l.length === 0, b.length === 0, rt.length === 0];
  if (bEmpty) {
    if (lEmpty) return { type: "inserted", leftChange: false, rightChange: true, resolvable: false };
    if (rEmpty) return { type: "inserted", leftChange: true, rightChange: false, resolvable: false };
    if (sameLines(l, rt)) return { type: "inserted", leftChange: true, rightChange: true, resolvable: false };
    return { type: "conflict", leftChange: true, rightChange: true, resolvable: false };
  }
  if (lEmpty && rEmpty) return { type: "deleted", leftChange: true, rightChange: true, resolvable: false };
  const unchangedLeft = sameLines(b, l);
  const unchangedRight = sameLines(b, rt);
  if (unchangedLeft && unchangedRight) return { type: "modified", leftChange: false, rightChange: false, resolvable: false };
  if (unchangedLeft) return { type: rEmpty ? "deleted" : "modified", leftChange: false, rightChange: true, resolvable: false };
  if (unchangedRight) return { type: lEmpty ? "deleted" : "modified", leftChange: true, rightChange: false, resolvable: false };
  if (sameLines(l, rt)) return { type: "modified", leftChange: true, rightChange: true, resolvable: false };
  const resolvable = !lEmpty && !rEmpty && tryResolveText(l.join("\n"), b.join("\n"), rt.join("\n")) !== null;
  return { type: "conflict", leftChange: true, rightChange: true, resolvable };
}

/**
 * How a range moves when lines `[changeStart, changeEnd)` of the document are replaced by text that has `shift`
 * more lines (IntelliJ `DiffUtil.updateRangeOnModification`). `damaged`: the edit cut into the range.
 */
export function updateRange(start: number, end: number, changeStart: number, changeEnd: number, shift: number): { start: number; end: number; damaged: boolean } {
  if (end <= changeStart) return { start, end, damaged: false }; // edit before
  if (start >= changeEnd) return { start: start + shift, end: end + shift, damaged: false }; // edit after
  if (start <= changeStart && end >= changeEnd) return { start, end: end + shift, damaged: false }; // edit inside
  const newEnd = changeEnd + shift;
  if (start >= changeStart && end <= changeEnd) return { start: newEnd, end: newEnd, damaged: true }; // range inside the edit
  if (start < changeStart) return { start, end: changeStart, damaged: true }; // bottom boundary damaged
  return { start: newEnd, end: end + shift, damaged: true }; // top boundary damaged
}

// ---------------------------------------------------------------- the model

/** Everything that changes when the user acts; used for undo. */
export interface Snapshot {
  chunks: { start: number; end: number; resolvedLeft: boolean; resolvedRight: boolean; onesideApplied: boolean; byHand: boolean }[];
}

export class MergeModel {
  readonly baseLines: readonly string[];
  readonly leftLines: readonly string[];
  readonly rightLines: readonly string[];
  readonly chunks: Chunk[];
  /** The Result pane, one entry per line. */
  result: string[];

  constructor(base: string, left: string, right: string) {
    this.baseLines = linesOf(base);
    this.leftLines = linesOf(left);
    this.rightLines = linesOf(right);
    const [b, l, r] = intern(this.baseLines, this.leftLines, this.rightLines);
    const ranges = mergeRangesFromDiffs(b.length, l.length, r.length, diffSeq(b, l), diffSeq(b, r));
    this.chunks = ranges.map((m, index) => {
      const t = classify(this.baseLines, this.leftLines, this.rightLines, m);
      return {
        index,
        left: { start: m.left[0], end: m.left[1] },
        base: { start: m.base[0], end: m.base[1] },
        right: { start: m.right[0], end: m.right[1] },
        type: t.type,
        leftChange: t.leftChange,
        rightChange: t.rightChange,
        resolvable: t.resolvable,
        resolvedLeft: false,
        resolvedRight: false,
        onesideApplied: false,
        byHand: false,
        start: m.base[0],
        end: m.base[1],
      };
    });
    this.result = [...this.baseLines];
  }

  // ------------------------------------------------------------ queries

  resultText(): string {
    return this.result.join("\n");
  }

  isResolved(c: Chunk): boolean {
    return c.resolvedLeft && c.resolvedRight;
  }

  isSideResolved(c: Chunk, side: Side): boolean {
    return side === "left" ? c.resolvedLeft : c.resolvedRight;
  }

  isChange(c: Chunk, side: Side): boolean {
    return side === "left" ? c.leftChange : c.rightChange;
  }

  /** Chunks that are still open (not resolved). */
  unresolved(): Chunk[] {
    return this.chunks.filter((c) => !this.isResolved(c));
  }

  /** Open chunks that are real conflicts (both sides changed the lines differently). */
  unresolvedConflicts(): Chunk[] {
    return this.chunks.filter((c) => c.type === "conflict" && !this.isResolved(c));
  }

  /** `conflicts`: open conflicts. `changes`: open changes that only one side made. */
  counts(): { conflicts: number; changes: number } {
    let conflicts = 0;
    let changes = 0;
    for (const c of this.chunks) {
      if (this.isResolved(c)) continue;
      if (c.type === "conflict") conflicts++;
      else changes++;
    }
    return { conflicts, changes };
  }

  /** Index of the next open chunk after `from` (wraps around), or -1. `dir` -1 goes backwards. */
  nextUnresolved(from: number, dir: 1 | -1 = 1, onlyConflicts = false): number {
    const n = this.chunks.length;
    for (let step = 1; step <= n; step++) {
      const i = (((from + dir * step) % n) + n) % n;
      const c = this.chunks[i];
      if (!this.isResolved(c) && (!onlyConflicts || c.type === "conflict")) return i;
    }
    return -1;
  }

  /** The Result pane lines of a chunk differ from the base lines (edited by hand, or something was applied). */
  isRangeModified(c: Chunk): boolean {
    return !sameLines(this.result.slice(c.start, c.end), this.baseLines.slice(c.base.start, c.base.end));
  }

  /** The gutter shows the apply (and ignore) button of `side` for this chunk. */
  canApply(c: Chunk, side: Side): boolean {
    return this.isChange(c, side) && !this.isSideResolved(c, side);
  }

  /** IntelliJ `canResolveChangeAutomatically`. `which = "all"` also covers conflicts that magic resolve can merge. */
  canResolveAutomatically(c: Chunk, which: Which): boolean {
    if (c.type === "conflict") {
      return which === "all" && c.resolvable && !c.resolvedLeft && !c.resolvedRight && !this.isRangeModified(c);
    }
    if (this.isResolved(c) || this.isRangeModified(c)) return false;
    return which === "all" || this.isChange(c, which);
  }

  hasNonConflicting(which: Which): boolean {
    return this.chunks.some((c) => c.type !== "conflict" && this.canResolveAutomatically(c, which));
  }

  hasMagicResolvable(): boolean {
    return this.chunks.some((c) => c.type === "conflict" && this.canResolveAutomatically(c, "all"));
  }

  // ------------------------------------------------------------ result editing primitives

  /** Replaces the chunk's Result lines; chunks after it move. */
  private setLines(c: Chunk, lines: readonly string[]): void {
    this.result.splice(c.start, c.end - c.start, ...lines);
    const delta = lines.length - (c.end - c.start);
    c.end = c.start + lines.length;
    if (delta === 0) return;
    for (let j = c.index + 1; j < this.chunks.length; j++) {
      this.chunks[j].start += delta;
      this.chunks[j].end += delta;
    }
  }

  /** Inserts lines at the start or the end of the chunk's Result lines, inside the chunk. */
  private addLines(c: Chunk, lines: readonly string[], where: "start" | "end"): void {
    const at = where === "start" ? c.start : c.end;
    this.result.splice(at, 0, ...lines);
    c.end += lines.length;
    for (let j = c.index + 1; j < this.chunks.length; j++) {
      this.chunks[j].start += lines.length;
      this.chunks[j].end += lines.length;
    }
  }

  private markResolved(c: Chunk): void {
    c.resolvedLeft = true;
    c.resolvedRight = true;
  }

  private sideLines(c: Chunk, side: Side): string[] {
    const r = c[side];
    return (side === "left" ? this.leftLines : this.rightLines).slice(r.start, r.end);
  }

  // ------------------------------------------------------------ actions

  /**
   * ">>" / "<<": takes the chunk's lines of `side` into the Result. A conflict where the other side also has
   * lines stays open (the other side can now be appended: Yours first, then Theirs); `resolve` closes it.
   */
  applyChange(index: number, side: Side, resolve = false): boolean {
    const c = this.chunks[index];
    if (!c || this.isSideResolved(c, side)) return false;
    if (!this.isChange(c, side)) {
      this.markResolved(c);
      return false;
    }
    const lines = this.sideLines(c, side);
    if (c.type === "conflict") {
      if (c.onesideApplied) this.addLines(c, lines, side === "left" ? "start" : "end");
      else this.setLines(c, lines);
      const other: Side = side === "left" ? "right" : "left";
      if (resolve || c[other].start === c[other].end) this.markResolved(c);
      else {
        c.onesideApplied = true;
        if (side === "left") c.resolvedLeft = true;
        else c.resolvedRight = true;
      }
    } else {
      this.setLines(c, lines);
      this.markResolved(c);
    }
    c.byHand = false;
    return true;
  }

  /** "x": keeps the Result as it is. For a conflict only that side is dropped, unless `resolve`. */
  ignoreChange(index: number, side: Side, resolve = false): boolean {
    const c = this.chunks[index];
    if (!c || this.isSideResolved(c, side)) return false;
    if (c.type !== "conflict" || resolve) this.markResolved(c);
    else if (side === "left") c.resolvedLeft = true;
    else c.resolvedRight = true;
    return true;
  }

  /** Applies every change that only one side made: `which` = that side's, or "all". Returns how many. */
  applyNonConflicting(which: Which): number {
    let n = 0;
    for (const c of this.chunks) {
      if (c.type === "conflict" || !this.canResolveAutomatically(c, which)) continue;
      const side: Side = which === "all" ? (c.leftChange ? "left" : "right") : which;
      if (this.applyChange(c.index, side)) n++;
    }
    return n;
  }

  /** Merges one conflict at word level. False when it cannot be resolved (or the Result lines were edited). */
  magicResolve(index: number): boolean {
    const c = this.chunks[index];
    if (!c || c.type !== "conflict" || !this.canResolveAutomatically(c, "all")) return false;
    const merged = tryResolveText(this.sideLines(c, "left").join("\n"), this.baseLines.slice(c.base.start, c.base.end).join("\n"), this.sideLines(c, "right").join("\n"));
    if (merged === null) return false;
    this.setLines(c, linesOf(merged));
    this.markResolved(c);
    c.byHand = false;
    return true;
  }

  /** Toolbar "Magic resolve": word-level merges of every conflict that allows it. Returns how many. */
  magicResolveAll(): number {
    let n = 0;
    for (const c of this.chunks) if (this.magicResolve(c.index)) n++;
    return n;
  }

  /** "Resolve simple conflicts automatically": non-conflicting changes and word-level merges. Returns how many chunks. */
  resolveAutomatically(): number {
    return this.applyNonConflicting("all") + this.magicResolveAll();
  }

  /** Back to the base text with every chunk open. */
  reset(): void {
    this.result = [...this.baseLines];
    for (const c of this.chunks) {
      c.start = c.base.start;
      c.end = c.base.end;
      c.resolvedLeft = false;
      c.resolvedRight = false;
      c.onesideApplied = false;
      c.byHand = false;
    }
  }

  /** "Accept Left / Right": the Result becomes exactly that version and every chunk is resolved. */
  acceptAll(side: Side): void {
    this.reset();
    for (const c of this.chunks) this.applyChange(c.index, side, true);
  }

  // ------------------------------------------------------------ the Result pane was edited by hand

  /** One edit of the Result pane as lines: old lines `[oldLine1, oldLine2)` were replaced by text with `shift` more lines. */
  documentChanged(oldLine1: number, oldLine2: number, shift: number, newLines: readonly string[]): void {
    this.documentEdits([{ oldLine1, oldLine2, shift }], newLines);
  }

  /**
   * The user edited the Result pane. Each edit is the lines it touched, as CodeMirror reports them (`oldLine1`..`oldLine2`
   * are the lines of the text before the edit, `shift` is how many lines it added); `newLines` is the whole Result
   * afterwards. Chunk ranges follow the edits (IntelliJ `MergeModelBase.processDocumentChange`). An edit that really
   * changes the lines of an open chunk resolves it by hand; undoing the edit opens it again.
   *
   * Several edits of one transaction are given last to first, so every position still refers to the old text.
   */
  documentEdits(edits: readonly LineEdit[], newLines: readonly string[]): void {
    const touched = new Set<Chunk>();
    for (const e of edits) {
      for (const c of this.chunks) {
        const u = updateRange(c.start, c.end, e.oldLine1, e.oldLine2, e.shift);
        // lines of the chunk were hit (an edit right next to it does not count)
        if (u.damaged || (e.oldLine2 > c.start && e.oldLine1 < c.end)) touched.add(c);
        c.start = u.start;
        c.end = u.end;
      }
    }
    this.result = [...newLines];
    for (const c of touched) {
      if (!this.isRangeModified(c)) {
        if (c.byHand) {
          c.byHand = false;
          c.resolvedLeft = false;
          c.resolvedRight = false;
          c.onesideApplied = false;
        }
      } else if (!this.isResolved(c)) {
        c.byHand = true;
        this.markResolved(c);
      }
    }
  }

  // ------------------------------------------------------------ undo support

  snapshot(): Snapshot {
    return {
      chunks: this.chunks.map((c) => ({ start: c.start, end: c.end, resolvedLeft: c.resolvedLeft, resolvedRight: c.resolvedRight, onesideApplied: c.onesideApplied, byHand: c.byHand })),
    };
  }

  /** Restores the chunk state and sets the Result lines (the editor text at that moment). */
  restore(s: Snapshot, resultLines: readonly string[]): void {
    s.chunks.forEach((x, i) => Object.assign(this.chunks[i], x));
    this.result = [...resultLines];
  }

  // ------------------------------------------------------------ output

  /**
   * The text to save: the Result, but every conflict that is still open is written as a conflict block with the
   * original Yours and Theirs lines (what an unresolved git merge leaves in the file). Edits inside an open
   * conflict are not kept; a conflict that was edited by hand counts as resolved and is kept as edited.
   */
  resultWithMarkers(labels: { left: string; right: string }): string {
    const out: string[] = [];
    let at = 0;
    for (const c of this.chunks) {
      if (c.type !== "conflict" || this.isResolved(c)) continue;
      out.push(...this.result.slice(at, c.start));
      out.push(`${MARKER_START} ${labels.left}`, ...this.sideLines(c, "left"), MARKER_MIDDLE, ...this.sideLines(c, "right"), `${MARKER_END} ${labels.right}`);
      at = c.end;
    }
    out.push(...this.result.slice(at));
    return out.join("\n");
  }
}
