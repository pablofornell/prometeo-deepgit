/**
 * Background scan of a log session: one pass over every row gives the overview ruler marks, the date groups, the lane
 * of each HEAD (for the "Uncommitted changes" node) and the author list. Pure functions; the session controller
 * feeds them pages.
 */
import type { CommitRow } from "../../api/types";
import { dateGroup, groupStartsOf } from "./dateGroups";

export type MarkKind = "head" | "branch" | "tag";

export interface Mark {
  /** Commit index. */
  row: number;
  kind: MarkKind;
  /** Ref name (tooltip). */
  label: string;
  repoId: string;
}

export interface AuthorInfo {
  name: string;
  email: string;
  count: number;
}

export interface ScanResult {
  marks: Mark[];
  groupStarts: number[];
  groupLabels: string[];
  /** First HEAD row of each repo and the lane of its node. */
  heads: Map<string, { row: number; lane: number }>;
  authors: Map<string, AuthorInfo>;
  complete: boolean;
}

export const emptyScan: ScanResult = { marks: [], groupStarts: [], groupLabels: [], heads: new Map(), authors: new Map(), complete: false };

export interface PageScan {
  keys: string[];
  labels: Map<string, string>;
  marks: Mark[];
  heads: { repoId: string; row: number; lane: number }[];
  authors: Map<string, AuthorInfo>;
}

/** Group key (and label) per 15-minute bucket: every time zone offset is a multiple of 15 minutes. */
const bucketCache = new Map<string, { key: string; label: string }>();

function groupOf(time: number, nowMs: number) {
  const k = `${Math.floor(nowMs / 900000)}:${Math.floor(time / 900)}`;
  let g = bucketCache.get(k);
  if (!g) {
    if (bucketCache.size > 4000) bucketCache.clear();
    bucketCache.set(k, (g = dateGroup(time, nowMs)));
  }
  return g;
}

/** Ref mark of a row: HEAD wins over branches, branches over tags. */
export function markOf(r: CommitRow, row: number): Mark | null {
  let branch: string | null = null;
  let tag: string | null = null;
  for (const l of r.refs) {
    if (l.kind === "head" || (l.kind === "local" && l.isCurrent)) return { row, kind: "head", label: l.kind === "head" ? "HEAD" : `HEAD -> ${l.name}`, repoId: r.repoId };
    if (l.kind === "local" || l.kind === "remote") branch ??= l.name;
    else if (l.kind === "tag") tag ??= l.name;
  }
  if (branch) return { row, kind: "branch", label: branch, repoId: r.repoId };
  if (tag) return { row, kind: "tag", label: tag, repoId: r.repoId };
  return null;
}

export const isHeadRow = (r: CommitRow): boolean => r.refs.some((l) => l.kind === "head" || (l.kind === "local" && l.isCurrent));

export function scanPage(rows: readonly CommitRow[], base: number, nowMs: number): PageScan {
  const out: PageScan = { keys: [], labels: new Map(), marks: [], heads: [], authors: new Map() };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const g = groupOf(r.committerTime, nowMs);
    out.keys.push(g.key);
    if (!out.labels.has(g.key)) out.labels.set(g.key, g.label);
    const m = markOf(r, base + i);
    if (m) {
      out.marks.push(m);
      if (m.kind === "head") out.heads.push({ repoId: r.repoId, row: base + i, lane: r.graph.node });
    }
    const a = out.authors.get(r.authorEmail);
    if (a) a.count++;
    else out.authors.set(r.authorEmail, { name: r.authorName, email: r.authorEmail, count: 1 });
  }
  return out;
}

/** Joins the page scans (in page order; every page must be present). */
export function assembleScan(pages: readonly PageScan[]): ScanResult {
  const keys: string[] = [];
  const labels = new Map<string, string>();
  const marks: Mark[] = [];
  const heads = new Map<string, { row: number; lane: number }>();
  const authors = new Map<string, AuthorInfo>();
  for (const p of pages) {
    for (const k of p.keys) keys.push(k);
    for (const [k, v] of p.labels) labels.set(k, v);
    for (const m of p.marks) marks.push(m);
    for (const h of p.heads) if (!heads.has(h.repoId)) heads.set(h.repoId, { row: h.row, lane: h.lane });
    for (const [e, a] of p.authors) {
      const cur = authors.get(e);
      if (cur) cur.count += a.count;
      else authors.set(e, { ...a });
    }
  }
  const { starts, labels: names } = groupStartsOf(keys, (k) => labels.get(k) ?? "");
  return { marks, groupStarts: starts, groupLabels: names, heads, authors, complete: true };
}
