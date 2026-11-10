/**
 * Pure model of the diff viewer: turns a `FileDiff` (hunks with 3 lines of context, optionally the same
 * diff with the whole file as context) into flat rows for the side-by-side and unified layouts, with
 * collapsed regions, change blocks and word-diff partners. No DOM, no Solid.
 */
import type { DiffLine, FileDiff, FileStatus, Hunk, LineKind } from "../../api/types";
import { pairWords, type Span } from "./wordDiff";

/** Unchanged lines kept around every change (same as the `context` asked from git). */
export const CONTEXT = 3;
/** `context` value that makes git return the whole file. */
export const FULL_CONTEXT = 1_000_000;
/** Above this many changed lines the diff is shown only after a click. */
export const BIG_DIFF_LINES = 5000;

export type IgnoreWs = "off" | "trailing" | "all";

export interface Cell {
  kind: LineKind;
  oldNo: number | null;
  newNo: number | null;
  text: string;
  /** The line facing this one inside the same change block (word diff partner). */
  mate: Cell | null;
  /** Word-diff cache: `undefined` = not computed, `null` = no highlight. */
  words?: Span[] | null;
}

const NO_SPANS: readonly Span[] = [];

/** Changed ranges of a line, computed on first use. Empty for context lines and lines without a partner. */
export function cellWords(c: Cell): readonly Span[] {
  if (c.words !== undefined) return c.words ?? NO_SPANS;
  if (c.kind === "context" || !c.mate) {
    c.words = null;
    return NO_SPANS;
  }
  const del = c.kind === "del" ? c : c.mate;
  const add = c.kind === "del" ? c.mate : c;
  const r = pairWords(del.text, add.text);
  del.words = r?.a ?? null;
  add.words = r?.b ?? null;
  return c.words ?? NO_SPANS;
}

export type Item =
  | { t: "hunk"; hunk: number; label: string }
  | { t: "fold"; id: string; count: number | null }
  | { t: "line"; line: DiffLine };

export type SbsRow =
  | { t: "hunk"; hunk: number; label: string }
  | { t: "fold"; id: string; count: number | null }
  | { t: "pair"; l: Cell | null; r: Cell | null; change: number; ws: boolean };

export type UniRow =
  | { t: "hunk"; hunk: number; label: string }
  | { t: "fold"; id: string; count: number | null }
  | { t: "line"; c: Cell; change: number; ws: boolean };

export interface ChangeMark {
  /** First and last row of the block. */
  row: number;
  end: number;
  kind: "add" | "del" | "mod";
  /** Index of the git hunk the block belongs to (for stage / discard). */
  hunk: number;
}

export interface Model<R> {
  rows: R[];
  changes: ChangeMark[];
  /** Longest line in columns (tabs count 4): sizes the horizontal scroll of both sides. */
  maxCols: number;
}

export function hunkLabel(h: Hunk): string {
  const range = (s: number, n: number) => (n === 1 ? String(s) : `${s},${n}`);
  return `@@ -${range(h.oldStart, h.oldLines)} +${range(h.newStart, h.newLines)} @@${h.header ? " " + h.header : ""}`;
}

/** First line number covered by a hunk side (a 0-length side points at the line before the insertion). */
const startOf = (start: number, len: number) => (len > 0 ? start : start + 1);
/** First line number after a hunk side. */
const endOf = (start: number, len: number) => (len > 0 ? start + len : start + 1);

export interface BuildOptions {
  /** Ids of folds the user opened (only meaningful with `full`). */
  expanded: ReadonlySet<string>;
  /** Show every unchanged line (needs `full`). */
  expandAll: boolean;
}

/** The whole-file reload is only usable when git returned its lines; a `tooLarge` (or empty) answer must not replace the hunk view. */
export function usableFull(full: FileDiff | null): FileDiff | null {
  return full && !full.tooLarge && !full.binary && full.hunks.length > 0 ? full : null;
}

/**
 * Items of the diff in display order. Without `full`, the hunks as git gave them with a fold between them;
 * with `full` (the same diff with the whole file as context), every unchanged run longer than the context is
 * folded unless the user opened it. Hunk headers are placed where the original hunks start in both cases, so
 * hunk indexes stay valid for stage / discard.
 */
export function buildItems(diff: FileDiff, full: FileDiff | null, o: BuildOptions): Item[] {
  full = usableFull(full);
  const hunks = diff.hunks;
  const out: Item[] = [];
  if (hunks.length === 0) return out;

  if (!full) {
    hunks.forEach((h, i) => {
      const gap = i === 0 ? startOf(h.newStart, h.newLines) - 1 : startOf(h.newStart, h.newLines) - endOf(hunks[i - 1].newStart, hunks[i - 1].newLines);
      if (gap > 0) out.push({ t: "fold", id: `n${i === 0 ? 1 : endOf(hunks[i - 1].newStart, hunks[i - 1].newLines)}`, count: gap });
      out.push({ t: "hunk", hunk: i, label: hunkLabel(h) });
      for (const line of h.lines) out.push({ t: "line", line });
    });
    const last = hunks[hunks.length - 1];
    let trailing = 0;
    for (let k = last.lines.length - 1; k >= 0 && last.lines[k].kind === "context"; k--) trailing++;
    if (trailing >= CONTEXT) out.push({ t: "fold", id: `n${endOf(last.newStart, last.newLines)}`, count: null });
    return out;
  }

  const lines = full.hunks.flatMap((h) => h.lines);
  const keyOf = (l: DiffLine) => `${l.kind}:${l.oldNo ?? ""}:${l.newNo ?? ""}`;
  const index = new Map<string, number>();
  lines.forEach((l, i) => index.set(keyOf(l), i));
  const headerAt = new Map<number, number>();
  hunks.forEach((h, i) => {
    const first = h.lines[0];
    const at = first ? index.get(keyOf(first)) : undefined;
    if (at !== undefined) headerAt.set(at, i);
  });

  // Hidden ranges [from, to) of unchanged runs.
  const hidden = new Map<number, { to: number; id: string }>();
  if (!o.expandAll) {
    let s = 0;
    while (s < lines.length) {
      if (lines[s].kind !== "context") {
        s++;
        continue;
      }
      let e = s;
      while (e < lines.length && lines[e].kind === "context") e++;
      const from = s + (s === 0 ? 0 : CONTEXT);
      const to = e - (e === lines.length ? 0 : CONTEXT);
      if (to - from >= 1) {
        const id = `n${lines[from].newNo ?? from}`;
        if (!o.expanded.has(id)) hidden.set(from, { to, id });
      }
      s = e;
    }
  }

  let k = 0;
  while (k < lines.length) {
    const h = hidden.get(k);
    if (h) {
      out.push({ t: "fold", id: h.id, count: h.to - k });
      k = h.to;
      continue;
    }
    const hi = headerAt.get(k);
    if (hi !== undefined) out.push({ t: "hunk", hunk: hi, label: hunkLabel(hunks[hi]) });
    out.push({ t: "line", line: lines[k] });
    k++;
  }
  return out;
}

// ---------------------------------------------------------------- rows

type Seg =
  | { t: "hunk"; hunk: number; label: string }
  | { t: "fold"; id: string; count: number | null }
  | { t: "ctx"; line: DiffLine }
  | { t: "change"; dels: DiffLine[]; adds: DiffLine[] };

const squash = (s: string, mode: IgnoreWs) => (mode === "all" ? s.replace(/\s+/g, "") : mode === "trailing" ? s.trimEnd() : s);

function wsOnly(dels: DiffLine[], adds: DiffLine[]): boolean {
  return dels.length === adds.length && dels.length > 0 && dels.every((d, i) => squash(d.text, "all") === squash(adds[i].text, "all"));
}

function segments(items: Item[], ignore: IgnoreWs): Seg[] {
  const out: Seg[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = () => {
    if (dels.length === 0 && adds.length === 0) return;
    if (ignore !== "off" && dels.length === adds.length && dels.every((d, i) => squash(d.text, ignore) === squash(adds[i].text, ignore))) {
      adds.forEach((a, i) => out.push({ t: "ctx", line: { kind: "context", oldNo: dels[i].oldNo, newNo: a.newNo, text: a.text } }));
    } else {
      out.push({ t: "change", dels, adds });
    }
    dels = [];
    adds = [];
  };
  for (const it of items) {
    if (it.t === "line") {
      const l = it.line;
      if (l.kind === "del") {
        if (adds.length > 0) flush();
        dels.push(l);
      } else if (l.kind === "add") adds.push(l);
      else {
        flush();
        out.push({ t: "ctx", line: l });
      }
    } else {
      flush();
      out.push(it);
    }
  }
  flush();
  return out;
}

const toCell = (l: DiffLine): Cell => ({ kind: l.kind, oldNo: l.oldNo, newNo: l.newNo, text: l.text, mate: null });

function cols(text: string): number {
  let n = text.length;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 9) n += 3;
  return n;
}

function markKind(dels: number, adds: number): ChangeMark["kind"] {
  return dels > 0 && adds > 0 ? "mod" : adds > 0 ? "add" : "del";
}

/** Side-by-side rows: a change block becomes `max(dels, adds)` rows with filler on the shorter side. */
export function toSideBySide(items: Item[], ignore: IgnoreWs = "off"): Model<SbsRow> {
  const rows: SbsRow[] = [];
  const changes: ChangeMark[] = [];
  let maxCols = 0;
  let hunk = 0;
  for (const s of segments(items, ignore)) {
    if (s.t === "hunk") {
      hunk = s.hunk;
      rows.push(s);
    } else if (s.t === "fold") rows.push(s);
    else if (s.t === "ctx") {
      const c = toCell(s.line);
      maxCols = Math.max(maxCols, cols(c.text));
      rows.push({ t: "pair", l: c, r: c, change: -1, ws: false });
    } else {
      const ws = ignore === "off" && wsOnly(s.dels, s.adds);
      const idx = changes.length;
      const start = rows.length;
      const n = Math.max(s.dels.length, s.adds.length);
      for (let i = 0; i < n; i++) {
        const l = i < s.dels.length ? toCell(s.dels[i]) : null;
        const r = i < s.adds.length ? toCell(s.adds[i]) : null;
        if (l && r) {
          l.mate = r;
          r.mate = l;
        }
        maxCols = Math.max(maxCols, l ? cols(l.text) : 0, r ? cols(r.text) : 0);
        rows.push({ t: "pair", l, r, change: idx, ws });
      }
      changes.push({ row: start, end: rows.length - 1, kind: markKind(s.dels.length, s.adds.length), hunk });
    }
  }
  return { rows, changes, maxCols };
}

/** Unified rows: deleted lines then added lines of each block. */
export function toUnified(items: Item[], ignore: IgnoreWs = "off"): Model<UniRow> {
  const rows: UniRow[] = [];
  const changes: ChangeMark[] = [];
  let maxCols = 0;
  let hunk = 0;
  for (const s of segments(items, ignore)) {
    if (s.t === "hunk") {
      hunk = s.hunk;
      rows.push(s);
    } else if (s.t === "fold") rows.push(s);
    else if (s.t === "ctx") {
      const c = toCell(s.line);
      maxCols = Math.max(maxCols, cols(c.text));
      rows.push({ t: "line", c, change: -1, ws: false });
    } else {
      const ws = ignore === "off" && wsOnly(s.dels, s.adds);
      const idx = changes.length;
      const start = rows.length;
      const dc = s.dels.map(toCell);
      const ac = s.adds.map(toCell);
      for (let i = 0; i < Math.min(dc.length, ac.length); i++) {
        dc[i].mate = ac[i];
        ac[i].mate = dc[i];
      }
      for (const c of dc.concat(ac)) {
        maxCols = Math.max(maxCols, cols(c.text));
        rows.push({ t: "line", c, change: idx, ws });
      }
      changes.push({ row: start, end: rows.length - 1, kind: markKind(dc.length, ac.length), hunk });
    }
  }
  return { rows, changes, maxCols };
}

/** `+N -M` of a diff. */
export function countLines(diff: FileDiff): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const h of diff.hunks) {
    for (const l of h.lines) {
      if (l.kind === "add") additions++;
      else if (l.kind === "del") deletions++;
    }
  }
  return { additions, deletions };
}

/** Status shown in the toolbar, derived from the diff itself. */
export function statusOf(diff: FileDiff, path: string, oldPath?: string | null): FileStatus {
  if (oldPath && oldPath !== path) return "renamed";
  if (diff.hunks.length > 0) {
    if (diff.hunks.every((h) => h.oldLines === 0)) return "added";
    if (diff.hunks.every((h) => h.newLines === 0)) return "deleted";
  }
  return "modified";
}

/** True when every change of the diff differs only in whitespace. */
export function isWhitespaceOnly(diff: FileDiff): boolean {
  let any = false;
  for (const h of diff.hunks) {
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    const end = () => {
      if (dels.length + adds.length > 0) {
        any = true;
        if (!wsOnly(dels, adds)) return false;
      }
      dels.length = 0;
      adds.length = 0;
      return true;
    };
    for (const l of h.lines) {
      if (l.kind === "context") {
        if (!end()) return false;
      } else if (l.kind === "del") {
        if (adds.length > 0 && !end()) return false;
        dels.push(l);
      } else adds.push(l);
    }
    if (!end()) return false;
  }
  return any;
}
