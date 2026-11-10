/**
 * Log session controller: opens a session per query, pages rows in blocks of 200 with an LRU page cache and scans the
 * whole session in the background (ruler marks, date groups, authors). All state is per call of
 * `createLogSession()`, which must run inside a component.
 *
 * Rows are read with `rowAt(commitIndex)`, which is reactive per page (no per-row stores). A session swap replaces the
 * cache atomically: the old rows stay on screen while the new session loads.
 */
import { batch, createSignal, onCleanup } from "solid-js";
import * as api from "../../api/tauri";
import type { ApiErrorShape, CommitRow, LogQuery, LogSessionInfo } from "../../api/types";
import { ensureRefs, cachedRefs } from "../../state/refs";
import { summary } from "../../state/workspace";
import { fnv1a } from "../../components/ui";
import { type Mark, type ScanResult, emptyScan, scanPage, assembleScan } from "./scan";
import { PageCache } from "./pageCache";

export const PAGE = 200;
const CACHE_PAGES = 40;
/** Sessions up to this size are scanned before they are shown, so date groups and marks never pop in. */
const BLOCK_LIMIT = 20_000;
/** Sessions above this size are not scanned (no ruler marks, no date groups). */
const SCAN_LIMIT = 200_000;
const SCAN_PARALLEL = 3;

export type OpenReason = "query" | "refresh" | "retry";

interface Sess {
  info: LogSessionInfo;
  gen: number;
  cache: PageCache<CommitRow[]>;
  inflight: Map<number, Promise<CommitRow[]>>;
  pending: Set<number>;
  scan: ScanResult;
  signature: string;
  closed: boolean;
  retried: boolean;
}

export interface OpenOptions {
  reason: OpenReason;
  /** Commit that stays where it is on screen (refresh) - its index is returned in `anchorIndex`. */
  anchor?: { oid: string; repoId?: string } | null;
  /** Selected commit - its index is returned in `selectedIndex`. */
  selected?: { oid: string; repoId?: string } | null;
}

export interface OpenResult {
  info: LogSessionInfo;
  anchorIndex: number | null;
  selectedIndex: number | null;
}

export function asApiError(e: unknown): ApiErrorShape {
  if (e && typeof e === "object" && "message" in e) return e as ApiErrorShape;
  return { message: String(e) };
}

/** Fingerprint of what the log shows for these repos (HEAD and every ref). Equal fingerprints mean no reload is needed. */
export function logSignature(repoIds: readonly string[]): string {
  return repoIds
    .map((id) => {
      const r = cachedRefs(id);
      const refs = r
        ? [...r.local.map((b) => b.name + b.oid), ...r.remote.map((b) => b.fullName + b.oid), ...r.tags.map((t) => t.name + t.oid), ...r.stashes.map((s) => s.oid)].join(",")
        : "";
      return `${id}:${summary(id)?.headOid ?? ""}:${fnv1a(refs)}`;
    })
    .join(";");
}

export function createLogSession() {
  const [sess, setSess] = createSignal<Sess | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<ApiErrorShape | null>(null);
  const [pageTick, setPageTick] = createSignal(0);
  const [scanTick, setScanTick] = createSignal(0);
  const pageSignals = new Map<number, ReturnType<typeof createSignal<number>>>();
  let openGen = 0;

  const pageSignal = (p: number) => {
    let s = pageSignals.get(p);
    if (!s) pageSignals.set(p, (s = createSignal(0)));
    return s;
  };
  const bump = (p: number) => pageSignal(p)[1]((n) => n + 1);

  const total = (): number => sess()?.info.total ?? 0;
  const info = (): LogSessionInfo | null => sess()?.info ?? null;
  const scan = (): ScanResult => {
    scanTick();
    return sess()?.scan ?? emptyScan;
  };
  const signature = (): string => sess()?.signature ?? "";

  /** Row at commit index `ci`, or undefined while its page loads. Reactive per page. */
  function rowAt(ci: number): CommitRow | undefined {
    const s = sess();
    if (!s) return undefined;
    const p = Math.floor(ci / PAGE);
    pageSignal(p)[0]();
    return s.cache.get(p)?.[ci % PAGE];
  }

  function loadPage(s: Sess, p: number): Promise<CommitRow[]> {
    let pr = s.inflight.get(p);
    if (!pr) {
      pr = api.logRows(s.info.sessionId, p * PAGE, PAGE).finally(() => s.inflight.delete(p));
      s.inflight.set(p, pr);
    }
    return pr;
  }

  function store(s: Sess, p: number, rows: CommitRow[]): void {
    if (s.closed || s.cache.has(p)) return;
    const evicted = s.cache.set(p, rows);
    if (s === untrackedSess) {
      bump(p);
      if (evicted !== undefined) bump(evicted);
      setPageTick((n) => n + 1);
    }
  }

  // The session currently shown, readable without tracking (callbacks).
  let untrackedSess: Sess | null = null;

  /** Loads the pages that cover commit indexes [start, end). */
  function ensure(start: number, end: number): void {
    const s = untrackedSess;
    if (!s || s.info.total === 0) return;
    const last = Math.floor((Math.min(end, s.info.total) - 1) / PAGE);
    for (let p = Math.floor(Math.max(0, start) / PAGE); p <= last; p++) {
      if (s.cache.has(p) || s.pending.has(p)) continue;
      s.pending.add(p);
      loadPage(s, p)
        .then((rows) => store(s, p, rows))
        .catch(() => {
          // An evicted backend session ("Log session expired"): reopen once.
          if (!s.closed && !s.retried && s === untrackedSess) {
            s.retried = true;
            retryOpen?.();
          }
        })
        .finally(() => s.pending.delete(p));
    }
  }

  /** The row at `ci`, loading its page when needed. */
  async function getRow(ci: number): Promise<CommitRow | undefined> {
    const s = untrackedSess;
    if (!s || ci < 0 || ci >= s.info.total) return undefined;
    const p = Math.floor(ci / PAGE);
    const cached = s.cache.get(p);
    if (cached) return cached[ci % PAGE];
    const rows = await loadPage(s, p);
    store(s, p, rows);
    return rows[ci % PAGE];
  }

  /** Rows in [start, end) (loads the pages). */
  async function getRows(start: number, end: number): Promise<CommitRow[]> {
    const out: CommitRow[] = [];
    for (let i = start; i < end; i++) {
      const r = await getRow(i);
      if (r) out.push(r);
    }
    return out;
  }

  /**
   * Index of commit `oid` of repo `repoId` in a session. Worktrees share oids, so the answer is only trusted when
   * the row at that index belongs to `repoId` (without a repo any match is returned).
   */
  async function findIn(s: Sess, oid: string, repoId?: string): Promise<number | null> {
    try {
      const ci = await api.logFind(s.info.sessionId, oid, repoId);
      if (ci === null || !repoId) return ci;
      const p = Math.floor(ci / PAGE);
      let rows = s.cache.get(p);
      if (!rows) {
        rows = await loadPage(s, p);
        store(s, p, rows);
      }
      return rows[ci % PAGE]?.repoId === repoId ? ci : null;
    } catch {
      return null;
    }
  }

  async function find(oid: string, repoId?: string): Promise<number | null> {
    const s = untrackedSess;
    return s ? findIn(s, oid, repoId) : null;
  }

  function closeSess(s: Sess | null): void {
    if (!s || s.closed) return;
    s.closed = true;
    void api.logClose(s.info.sessionId).catch(() => undefined);
  }

  async function scanSession(s: Sess, cancelled: () => boolean): Promise<void> {
    if (s.info.total === 0 || s.info.total > SCAN_LIMIT) return;
    const pages = Math.ceil(s.info.total / PAGE);
    const per = new Array<ReturnType<typeof scanPage>>(pages);
    const now = Date.now();
    let next = 0;
    const worker = async () => {
      for (;;) {
        if (cancelled()) return;
        const p = next++;
        if (p >= pages) return;
        const rows = await loadPage(s, p);
        per[p] = scanPage(rows, p * PAGE, now);
        if (p === 0) store(s, 0, rows);
      }
    };
    await Promise.all(Array.from({ length: Math.min(SCAN_PARALLEL, pages) }, worker));
    if (cancelled()) return;
    s.scan = assembleScan(per);
  }

  let retryOpen: (() => void) | undefined;
  let lastQuery: LogQuery | null = null;

  /**
   * Opens a session for `q` and shows it when ready (atomic swap). Resolves to the indexes of the anchor and the
   * selected commit in the new session, or null when a newer call superseded this one.
   */
  async function open(q: LogQuery, o: OpenOptions): Promise<OpenResult | null> {
    const gen = ++openGen;
    lastQuery = q;
    retryOpen = () => void open(q, { ...o, reason: "refresh" }).then(() => undefined);
    setLoading(true);
    setError(null);
    try {
      if (q.repoIds.length === 0) {
        swap(null);
        return { info: { sessionId: 0, total: 0, maxLanes: 0, truncated: false, skipped: [] }, anchorIndex: null, selectedIndex: null };
      }
      const [inf] = await Promise.all([api.logOpen(q), ensureRefs(q.repoIds)]);
      const s: Sess = {
        info: inf, gen, cache: new PageCache(CACHE_PAGES), inflight: new Map(), pending: new Set(),
        scan: emptyScan, signature: logSignature(q.repoIds), closed: false, retried: false,
      };
      const cancelled = () => gen !== openGen;
      if (cancelled()) {
        closeSess(s);
        return null;
      }
      const wantScan = inf.total <= BLOCK_LIMIT;
      if (wantScan) await scanSession(s, cancelled);
      const [anchorIndex, selectedIndex] = await Promise.all([
        o.anchor ? findIn(s, o.anchor.oid, o.anchor.repoId) : Promise.resolve(null),
        o.selected ? findIn(s, o.selected.oid, o.selected.repoId) : Promise.resolve(null),
      ]);
      // Pages around the places that will be shown, so the swap does not flash empty rows.
      const focus = anchorIndex ?? selectedIndex ?? 0;
      const fp = Math.floor(focus / PAGE);
      for (const p of [fp, fp + 1, fp - 1]) {
        if (p < 0 || p * PAGE >= inf.total || s.cache.has(p)) continue;
        store(s, p, await loadPage(s, p));
      }
      if (cancelled()) {
        closeSess(s);
        return null;
      }
      swap(s);
      if (!wantScan) {
        void scanSession(s, () => s.closed || gen !== openGen).then(() => {
          if (!s.closed && s === untrackedSess) setScanTick((n) => n + 1);
        });
      }
      return { info: inf, anchorIndex, selectedIndex };
    } catch (e) {
      if (gen === openGen) setError(asApiError(e));
      return null;
    } finally {
      if (gen === openGen) setLoading(false);
    }
  }

  function swap(next: Sess | null): void {
    const prev = untrackedSess;
    untrackedSess = next;
    pageSignals.clear();
    batch(() => {
      setSess(next);
      setScanTick((n) => n + 1);
      setPageTick((n) => n + 1);
    });
    closeSess(prev);
  }

  onCleanup(() => {
    openGen++;
    closeSess(untrackedSess);
    untrackedSess = null;
  });

  return {
    info, total, scan, signature, loading, error, pageTick,
    rowAt, ensure, getRow, getRows, find, open,
    lastQuery: () => lastQuery,
  };
}

export type LogSession = ReturnType<typeof createLogSession>;
export type { Mark };
