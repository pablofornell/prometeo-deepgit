/**
 * The Log tab (DESIGN.md 5.5, 5.6, 5.7, 11.1, 11.5): filter bar, operation banners, column header and a virtualized
 * commit list with a per-row SVG graph, date groups, the "Uncommitted changes" row and the overview ruler.
 * Other features talk to the log only through the selection store (`selectedCommit`, `setSelectedCommit`).
 */
import { type JSX, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from "solid-js";
import type { CommitRow, LogQuery } from "../../api/types";
import { Button, EmptyState, HeaderSlot, IconButton, VirtualList, type VirtualListApi, copyText, openContextMenu, plural, toast } from "../../components/ui";
import { dateWidthSample } from "../../state/dateFormat";
import { register } from "../../state/keymap";
import { notifyRepoChanged, repoVersion } from "../../state/events";
import { refsVersion } from "../../state/refs";
import { loadPersisted, savePersisted } from "../../state/persist";
import { mainTab, selectedCommit, setChangesRepoId, setMainTab, setSelectedCommit } from "../../state/selection";
import { setSetting, settings } from "../../state/settings";
import { activeProject, focusedRepo, refreshSummaries, repoById, selectOnlyRepo, selectedRepoIds, selectedRepos, summary } from "../../state/workspace";
import { resetAuthors, mergeAuthors } from "./authors";
import { OperationBanners, SkippedBanner } from "./Banner";
import { DisplayMap, dateGroupLabel } from "./dateGroups";
import { FilterBar } from "./FilterBar";
import { activeFilters, clearAllFilters, hasContentFilter, query, text } from "./filters";
import { appearanceRev } from "../../state/metrics";
import { autoGraphWidth, cssPx, maxLanesOf, readGraphMetrics } from "./graph";
import { CommitRowView, DateRowView, type RowCtx, type WipInfo, WipRowView } from "./LogRow";
import { type PickedCommit, commitMenu, refAtTarget, refMenu } from "./menus";
import { parseTextFilter } from "./query";
import { Ruler } from "./Ruler";
import type { Mark } from "./scan";
import { type OpenReason, createLogSession, logSignature } from "./session";
import "./log.css";

// ---------------------------------------------------------------- columns

interface Cols {
  /** null = automatic (from the lanes in view). */
  graph: number | null;
  repo: number;
  author: number;
  /** null = automatic (fits a date in the user's date format). */
  date: number | null;
  hash: number;
  hidden: { repo: boolean; author: boolean; date: boolean; hash: boolean };
}

const DEFAULT_COLS: Cols = { graph: null, repo: 104, author: 124, date: null, hash: 66, hidden: { repo: false, author: false, date: false, hash: false } };
const LIMITS: Record<"graph" | "repo" | "author" | "date" | "hash", [number, number]> = {
  graph: [30, 220], repo: [64, 260], author: [70, 260], date: [48, 240], hash: [56, 120],
};
/** The fixed width the date column had before it became automatic: a saved value equal to it was never chosen by the user. */
const OLD_DATE_WIDTH = 88;
/** Left and right padding of a cell. */
const CELL_PAD = 16;
/** Share of its width the automatic graph gives up (its right lanes are cut) before a column is dropped. */
const GRAPH_GIVE = 0.25;
const clamp = (n: number, [lo, hi]: [number, number]) => Math.min(hi, Math.max(lo, n));
/** Debounce of the reload that follows `repo-changed` events; plain file edits then skip the reload. */
const REFRESH_DELAY_MS = 800;
/** The subject column keeps at least this width (DESIGN.md 5.5 "Columns"). */
const MIN_SUBJECT = 200;
/** Cell padding of the subject column (left 4, right 8). */
const SUBJECT_PAD = 12;
/** Largest range selected with Shift+click. */
const MAX_RANGE = 2000;

const keyOf = (repoId: string, oid: string): string => `${repoId}:${oid}`;

type Picked = PickedCommit;

export function LogView(): JSX.Element {
  const ctl = createLogSession();
  let root: HTMLDivElement | undefined;
  let searchInput: HTMLInputElement | undefined;
  let listApi: VirtualListApi | undefined;
  const listEl = () => listApi?.element();

  const rowH = createMemo(() => cssPx(settings.comfortableRows ? "--dg-log-row-height-comfortable" : "--dg-log-row-height", settings.comfortableRows ? 28 : 24));
  const metrics = createMemo(() => readGraphMetrics(rowH()));
  const multiRepo = () => selectedRepoIds().length > 1;

  // ---------------------------------------------------------------- columns state

  const saved = loadPersisted<Partial<Cols>>("log.cols", {});
  const [cols, setCols] = createSignal<Cols>({
    ...DEFAULT_COLS,
    ...saved,
    date: typeof saved.date === "number" && saved.date !== OLD_DATE_WIDTH ? saved.date : null,
    hidden: { ...DEFAULT_COLS.hidden, ...(saved.hidden ?? {}) },
  });
  const persistCols = () => savePersisted("log.cols", cols());
  const [visibleLanes, setVisibleLanes] = createSignal(1);
  const [rootWidth, setRootWidth] = createSignal(0);
  const rulerWidth = () => cssPx("--dg-log-ruler-width", 14);
  const baseGraphWidth = () => (settings.showGraph ? cols().graph ?? autoGraphWidth(visibleLanes(), metrics()) : 0);
  /** 0 before the log is in the page; bumped when a new measure of the text is due. */
  const [measureRev, setMeasureRev] = createSignal(0);
  /** Width that fits a date of the user's format at the current font size (measured: the format, the locale and the font decide it). */
  const autoDateWidth = createMemo(() => {
    appearanceRev();
    const sample = dateWidthSample(settings.dateFormat);
    if (measureRev() === 0 || !root) return clamp(Math.ceil(sample.length * 6.6) + CELL_PAD, LIMITS.date);
    const probe = document.createElement("span");
    probe.className = "dg-log-date";
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;";
    probe.textContent = sample;
    root.appendChild(probe);
    const w = probe.getBoundingClientRect().width;
    probe.remove();
    return clamp(Math.ceil(w) + CELL_PAD + 2, LIMITS.date);
  });
  /** Width of a column as chosen by the user, or its automatic width. */
  const widthOf = (c: "repo" | "author" | "date" | "hash"): number => (c === "date" ? cols().date ?? autoDateWidth() : cols()[c]);

  /**
   * Columns that are off: chosen by the user, or dropped (hash, author, date, repository) to keep the subject at 200 px.
   * An automatic graph first gives up a quarter of its width, so a wider date format ("2026-11-10 14:32") does not
   * drop the date column for a few pixels.
   */
  const hiddenCols = createMemo(() => {
    const user = cols().hidden;
    const off = { repo: user.repo || !multiRepo(), author: user.author, date: user.date, hash: user.hash };
    const w = rootWidth();
    if (w <= 0) return off;
    const budget = w - rulerWidth() - MIN_SUBJECT;
    const base = baseGraphWidth();
    const graph = settings.showGraph && cols().graph === null ? Math.max(Math.min(base, LIMITS.graph[0]), Math.ceil(base * (1 - GRAPH_GIVE))) : base;
    const used = () => graph + (["repo", "author", "date", "hash"] as const).reduce((n, c) => n + (off[c] ? 0 : widthOf(c)), 0);
    for (const c of ["hash", "author", "date", "repo"] as const) {
      if (used() <= budget) break;
      off[c] = true;
    }
    return off;
  });
  const colWidth = (c: "repo" | "author" | "date" | "hash") => (hiddenCols()[c] ? 0 : widthOf(c));
  const graphWidth = () => {
    const base = baseGraphWidth();
    const w = rootWidth();
    if (w <= 0 || base === 0) return base;
    const others = (["repo", "author", "date", "hash"] as const).reduce((n, c) => n + colWidth(c), 0);
    return Math.min(base, Math.max(LIMITS.graph[0], w - rulerWidth() - MIN_SUBJECT - others));
  };
  /** Width of the subject column: what the other columns leave (cell padding included). */
  const subjectWidth = () => {
    const w = rootWidth();
    if (w <= 0) return 600;
    const others = (["repo", "author", "date", "hash"] as const).reduce((n, c) => n + colWidth(c), 0);
    return Math.max(0, w - rulerWidth() - graphWidth() - others - SUBJECT_PAD);
  };

  // ---------------------------------------------------------------- derived display model

  const wip = createMemo<WipInfo | null>(() => {
    if (hasContentFilter()) return null;
    const dirty = selectedRepos().filter((r) => {
      const s = summary(r.id);
      return !!s && s.staged + s.unstaged + s.untracked + s.conflicted > 0;
    });
    if (dirty.length === 0) return null;
    const files = dirty.reduce((n, r) => {
      const s = summary(r.id)!;
      return n + s.staged + s.unstaged + s.untracked + s.conflicted;
    }, 0);
    const head = ctl.scan().heads.get(dirty[0].id);
    return { repos: dirty, files, lane: head?.lane ?? 0, headRow: head?.row ?? null };
  });

  const map = createMemo(() => {
    const sc = ctl.scan();
    // the group names follow the date format ("October 2026" or "2026-10")
    const format = settings.dateFormat;
    const labels = format === "relative" ? sc.groupLabels : sc.groupKeys.map((k) => dateGroupLabel(k, format));
    return new DisplayMap(ctl.total(), wip() !== null, sc.groupStarts, labels);
  });

  // ---------------------------------------------------------------- scrolling

  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewHeight, setViewHeight] = createSignal(0);
  const [range, setRange] = createSignal<[number, number]>([0, 0]);

  const onScroll = () => setScrollTop(listEl()?.scrollTop ?? 0);

  /** Commit index at or next to a display index (for page loading). */
  const nearCommit = (d: number): number => {
    const it = map().itemAt(Math.max(0, d));
    if (it.kind === "commit") return it.ci;
    if (it.kind === "date") return map().groupStarts[it.group] ?? 0;
    return 0;
  };

  const onRange = (start: number, end: number) => {
    setRange([start, end]);
    ctl.ensure(nearCommit(start), nearCommit(Math.max(start, end - 1)) + 1);
  };

  // Lanes in the viewport decide the automatic graph column width (DESIGN.md 5.5 "Columns").
  createEffect(() => {
    const [s, e] = range();
    const m = map();
    ctl.pageTick();
    const rows: (CommitRow | undefined)[] = [];
    const lo = nearCommit(s);
    const hi = Math.min(ctl.total() - 1, nearCommit(Math.max(s, e - 1)));
    for (let ci = lo; ci <= hi; ci++) rows.push(ctl.rowAt(ci));
    void m;
    setVisibleLanes(Math.max(1, maxLanesOf(rows)));
  });

  // After a session swap the cache is new: load what is on screen.
  createEffect(on(ctl.info, () => {
    const [s, e] = untrack(range);
    if (e > s) ctl.ensure(nearCommit(s), nearCommit(e - 1) + 1);
  }));

  const stickyLabel = createMemo(() => {
    const st = scrollTop();
    if (st <= 0) return null;
    const h = rowH();
    const d0 = Math.floor(st / h);
    const m = map();
    if (m.itemAt(d0).kind === "date" && st - d0 * h === 0) return null;
    return m.stickyAt(d0)?.label ?? null;
  });

  const isVisible = (d: number): boolean => {
    const el = listEl();
    if (!el) return false;
    const top = d * rowH();
    return top >= el.scrollTop && top + rowH() <= el.scrollTop + el.clientHeight;
  };

  /** Scrolls display row `d` into view, below the sticky group label. */
  function ensureVisible(d: number, align: "auto" | "center" = "auto"): void {
    const el = listEl();
    if (!listApi || !el) return;
    if (align === "auto" && isVisible(d) && !(el.scrollTop > 0 && stickyLabel() !== null && d * rowH() < el.scrollTop + rowH())) return;
    listApi.scrollToIndex(d, align);
    if (align === "auto" && el.scrollTop > 0 && d * rowH() < el.scrollTop + rowH() && map().stickyAt(Math.floor(el.scrollTop / rowH())) !== null) {
      el.scrollTop = Math.max(0, d * rowH() - rowH());
    }
  }

  // ---------------------------------------------------------------- selection

  const [multi, setMulti] = createSignal<Map<string, Picked>>(new Map());
  let anchorCi: number | null = null;
  let navigating = false;
  const history: { repoId: string; oid: string }[] = [];
  let histPos = -1;

  const isSelected = (key: string) => multi().has(key);
  const selCi = createMemo(() => {
    const sc = selectedCommit();
    return sc ? multi().get(keyOf(sc.repoId, sc.oid))?.ci ?? null : null;
  });
  const selDisplay = createMemo(() => {
    const ci = selCi();
    return ci === null ? null : map().displayOf(ci);
  });

  function pushHistory(repoId: string, oid: string): void {
    if (navigating) return;
    const last = history[histPos];
    if (last && last.repoId === repoId && last.oid === oid) return;
    history.length = histPos + 1;
    history.push({ repoId, oid });
    if (history.length > 100) history.shift();
    histPos = history.length - 1;
  }

  /** Applies a click or a keyboard move to the selection. Several commits can be selected inside one repo. */
  async function select(row: CommitRow, ci: number, mode: "single" | "toggle" | "range"): Promise<void> {
    const p: Picked = { repoId: row.repoId, oid: row.oid, ci };
    const key = keyOf(row.repoId, row.oid);
    const cur = selectedCommit();
    const sameRepo = !cur || cur.repoId === row.repoId;
    if (mode === "single" || !sameRepo) {
      setMulti(new Map([[key, p]]));
      anchorCi = ci;
      setSelectedCommit({ repoId: row.repoId, oid: row.oid });
      pushHistory(row.repoId, row.oid);
      return;
    }
    if (mode === "toggle") {
      const next = new Map(multi());
      if (next.has(key) && next.size > 1) {
        next.delete(key);
        const [last] = [...next.values()].slice(-1);
        setMulti(next);
        setSelectedCommit({ repoId: last.repoId, oid: last.oid });
      } else {
        next.set(key, p);
        setMulti(next);
        setSelectedCommit({ repoId: row.repoId, oid: row.oid });
      }
      anchorCi = ci;
      return;
    }
    const from = anchorCi ?? selCi() ?? ci;
    const lo = Math.min(from, ci);
    const hi = Math.min(Math.max(from, ci), lo + MAX_RANGE);
    const rows = await ctl.getRows(lo, hi + 1);
    const next = new Map<string, Picked>();
    rows.forEach((r, i) => {
      if (r.repoId === row.repoId) next.set(keyOf(r.repoId, r.oid), { repoId: r.repoId, oid: r.oid, ci: lo + i });
    });
    next.set(key, p);
    setMulti(next);
    setSelectedCommit({ repoId: row.repoId, oid: row.oid });
  }

  async function selectIndex(ci: number, reveal: "auto" | "center" | null = "auto", mode: "single" | "range" = "single"): Promise<void> {
    const row = await ctl.getRow(ci);
    if (!row) return;
    await select(row, ci, mode);
    if (reveal) ensureVisible(map().displayOf(ci), reveal);
  }

  // A commit selected by another feature (palette, details, sidebar): find it in the log and scroll to it.
  let adoptToken = 0;
  createEffect(() => {
    const sc = selectedCommit();
    if (!sc) {
      if (untrack(multi).size > 0) setMulti(new Map());
      return;
    }
    if (untrack(multi).has(keyOf(sc.repoId, sc.oid))) return;
    const token = ++adoptToken;
    void ctl.find(sc.oid, sc.repoId).then((ci) => {
      if (token !== adoptToken || ci === null) return;
      setMulti(new Map([[keyOf(sc.repoId, sc.oid), { repoId: sc.repoId, oid: sc.oid, ci }]]));
      anchorCi = ci;
      ensureVisible(map().displayOf(ci), isVisible(map().displayOf(ci)) ? "auto" : "center");
    });
  });

  async function selectHead(): Promise<void> {
    const ids = selectedRepoIds();
    const repoId = [selectedCommit()?.repoId, focusedRepo()?.id].find((id): id is string => !!id && ids.includes(id)) ?? ids[0];
    if (!repoId) return;
    const head = summary(repoId)?.headOid ?? null;
    const ci = head ? await ctl.find(head, repoId) : (ctl.scan().heads.get(repoId)?.row ?? null);
    if (ci !== null) await selectIndex(ci, isVisible(map().displayOf(ci)) ? "auto" : "center");
  }

  async function selectParent(): Promise<void> {
    const ci = selCi();
    if (ci === null) return;
    const row = await ctl.getRow(ci);
    const parent = row?.parents[0];
    if (!parent) return;
    const pi = await ctl.find(parent, row?.repoId);
    if (pi !== null) await selectIndex(pi, "auto");
  }

  async function goHistory(delta: -1 | 1): Promise<void> {
    const pos = histPos + delta;
    const e = history[pos];
    if (!e) return;
    histPos = pos;
    navigating = true;
    try {
      const ci = await ctl.find(e.oid, e.repoId);
      if (ci !== null) await selectIndex(ci, isVisible(map().displayOf(ci)) ? "auto" : "center");
    } finally {
      navigating = false;
    }
  }

  async function copyHash(): Promise<void> {
    const sc = selectedCommit();
    if (sc && (await copyText(sc.oid))) toast({ kind: "info", title: "Hash copied", body: sc.oid.slice(0, 12), timeout: 2500 });
  }

  function focusDetails(): void {
    // DESIGN.md 8: "Enter - Focus the file list of the commit". The details island is found by its label.
    const aside = document.querySelector<HTMLElement>('[aria-label="Commit details"]');
    const target = ['[role="tree"]', '[role="listbox"]', ".dg-vlist", '[tabindex="0"]', "button"].map((q) => aside?.querySelector<HTMLElement>(q)).find((el) => !!el);
    (target ?? aside)?.focus();
  }

  // ---------------------------------------------------------------- keyboard

  let shiftNav = false;
  const onListKey = (e: KeyboardEvent) => {
    shiftNav = e.shiftKey && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "PageDown" || e.key === "PageUp");
    if (e.key === "Enter") {
      e.preventDefault();
      focusDetails();
    } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "c" && !window.getSelection()?.toString()) {
      e.preventDefault();
      void copyHash();
    }
  };

  /** The list asks to select display row `d` (arrow keys, page keys, Home, End): skip rows that are not commits. */
  const onNavigate = (d: number) => {
    const m = map();
    const cur = selDisplay();
    const dir = cur !== null && d < cur ? -1 : 1;
    let item = m.itemAt(d);
    let at = d;
    while (item.kind !== "commit") {
      at += dir;
      if (at < 0 || at >= m.count) return;
      item = m.itemAt(at);
    }
    void selectIndex(item.ci, "auto", shiftNav ? "range" : "single");
  };

  onMount(() => {
    if (!root) return;
    setRootWidth(root.clientWidth);
    setMeasureRev(1);
    // measured again when the web fonts are in (the first measure may see the fallback font)
    void document.fonts?.ready.then(() => setMeasureRev((n) => n + 1));
    const ro = new ResizeObserver(() => root && setRootWidth(root.clientWidth));
    ro.observe(root);
    onCleanup(() => ro.disconnect());
  });

  const inList = () => !!listEl()?.contains(document.activeElement);
  const onLogTab = () => mainTab() === "log";
  // DESIGN.md 8 "Esc - Return focus to the log": from the details or diff islands back to the commit list
  // (Esc in the "File changes" tab goes back to "Changed files" first: `diff.back` in state/shortcuts.ts.)
  const inDetailsOrDiff = () => {
    const el = document.activeElement as HTMLElement | null;
    return !!el?.closest?.('[aria-label="Details"]') && !el.closest('[data-details-view="diff"]');
  };

  onMount(() => {
    const offs = [
      register("log.focusFilter", "Ctrl+F", () => {
        searchInput?.focus();
        searchInput?.select();
      }, { title: "Focus the text filter", group: "Log", when: onLogTab, allowInInput: true }),
      register("log.clearFilters", "Ctrl+Shift+F", () => clearAllFilters(), { title: "Clear all filters", group: "Log", when: () => onLogTab() && activeFilters().length > 0 }),
      register("log.copyHash", "Ctrl+Shift+C", () => void copyHash(), { title: "Copy the hash of the selected commit", group: "Log", when: () => onLogTab() && !!selectedCommit() && inList() }),
      register("log.selectHead", "H", () => void selectHead(), { title: "Select HEAD", group: "Log", when: () => onLogTab() && inList() }),
      register("log.selectParent", "P", () => void selectParent(), { title: "Select the first parent", group: "Log", when: () => onLogTab() && inList() }),
      register("log.focusList", "Esc", () => {
        const el = listEl();
        if (!el) return false;
        el.focus();
        return true;
      }, { title: "Return focus to the log", group: "Tool windows", when: () => onLogTab() && !inList() && inDetailsOrDiff() }),
      register("log.back", "Alt+Left", () => void goHistory(-1), { title: "Back in the selection history", group: "Log", when: () => onLogTab() && inList() }),
      register("log.forward", "Alt+Right", () => void goHistory(1), { title: "Forward in the selection history", group: "Log", when: () => onLogTab() && inList() }),
    ];
    onCleanup(() => offs.forEach((off) => off()));
  });

  // ---------------------------------------------------------------- loading and reloading

  let initialSelectDone = false;

  /** Top commit on screen: the log keeps it where it is when it reloads. */
  function captureAnchor(): { oid: string; repoId: string; offset: number } | null {
    const el = listEl();
    if (!el) return null;
    const h = rowH();
    const m = map();
    for (let d = Math.floor(el.scrollTop / h); d < Math.min(m.count, Math.floor(el.scrollTop / h) + 6); d++) {
      const it = m.itemAt(d);
      if (it.kind !== "commit") continue;
      const row = untrack(() => ctl.rowAt(it.ci));
      if (row) return { oid: row.oid, repoId: row.repoId, offset: d * h - el.scrollTop };
    }
    return null;
  }

  async function reload(q: LogQuery, reason: OpenReason): Promise<void> {
    const anchor = reason === "refresh" ? untrack(captureAnchor) : null;
    const sel = untrack(selectedCommit);
    const res = await ctl.open(q, { reason, anchor: anchor ? { oid: anchor.oid, repoId: anchor.repoId } : null, selected: sel ? { oid: sel.oid, repoId: sel.repoId } : null });
    if (!res) return;
    const m = untrack(map);
    const el = listEl();
    if (el) {
      if (res.anchorIndex !== null && anchor) el.scrollTop = Math.max(0, m.displayOf(res.anchorIndex) * rowH() - anchor.offset);
      else if (res.selectedIndex !== null) ensureVisible(m.displayOf(res.selectedIndex), "center");
      else if (reason !== "refresh") el.scrollTop = 0;
      setScrollTop(el.scrollTop);
    }
    mergeAuthors(ctl.scan().authors);
    if (sel) {
      if (res.selectedIndex !== null) {
        setMulti(new Map([[keyOf(sel.repoId, sel.oid), { repoId: sel.repoId, oid: sel.oid, ci: res.selectedIndex }]]));
        anchorCi = res.selectedIndex;
      } else {
        setMulti(new Map());
        // The commit is gone (amend, rebase, reset): DESIGN.md 5.5 "Virtualization" rule 5 selects HEAD.
        if (reason === "refresh") void selectHead();
      }
    } else if (!initialSelectDone && res.info.total > 0) {
      initialSelectDone = true;
      void selectHead();
    }
  }

  createEffect(on(query, (q) => void reload(q, "query")));

  // A scan that finishes after the swap (big logs) adds date groups: keep the commit at the top where it is.
  createEffect(on(map, (m, prev) => {
    const el = untrack(listEl);
    if (!prev || !el || untrack(ctl.info) === null) return;
    const h = untrack(rowH);
    const topD = Math.floor(el.scrollTop / h);
    const it = prev.itemAt(topD);
    if (el.scrollTop === 0 || it.kind !== "commit" || prev.total !== m.total) return;
    el.scrollTop = Math.max(0, m.displayOf(it.ci) * h + (el.scrollTop - topD * h));
  }));

  // New project: forget the authors of the previous one.
  createEffect(on(() => activeProject()?.id, () => resetAuthors(), { defer: true }));

  // Repos changed on disk or by an action: reload when HEAD or a ref moved (not for plain file edits). The refs cache
  // reloads a moment after `repo-changed` (slow with many refs), so its version is tracked too: a fetch whose refs
  // arrive after the first debounce still reaches the log (the signature check below skips no-op reloads).
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(on(() => {
    const ids = selectedRepoIds();
    return ids.map((id) => `${repoVersion(id)}:${refsVersion(id)}:${summary(id)?.headOid ?? ""}`).join(",");
  }, () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      const q = untrack(query);
      if (logSignature(q.repoIds) !== untrack(ctl.signature)) void reload(q, "refresh");
    }, REFRESH_DELAY_MS);
  }, { defer: true }));
  onCleanup(() => clearTimeout(refreshTimer));

  const refresh = () => {
    for (const id of selectedRepoIds()) notifyRepoChanged(id);
    void refreshSummaries();
    void reload(untrack(query), "refresh");
  };

  // ---------------------------------------------------------------- rows

  const needle = () => parseTextFilter(text()).text;

  const ctx: RowCtx = {
    rowAt: ctl.rowAt,
    displayMap: map,
    metrics,
    graphWidth,
    subjectWidth,
    minSubject: () => cssPx("--dg-log-subject-min-width", 120),
    multiRepo,
    laneColor: (color) => `var(--dg-lane-${color % 10})`,
    repoName: (id) => repoById(id)?.name ?? id,
    isSelected,
    needle,
    wip,
    onRowClick: (e, ci, row) => {
      if (e.button !== 0) return;
      void select(row, ci, e.ctrlKey || e.metaKey ? "toggle" : e.shiftKey ? "range" : "single");
    },
    onRowMenu: (e, ci, row) => {
      if (!multi().has(keyOf(row.repoId, row.oid))) void select(row, ci, "single");
      const picked = multi().has(keyOf(row.repoId, row.oid)) ? [...multi().values()] : [{ repoId: row.repoId, oid: row.oid, ci }];
      openContextMenu(e, () => commitMenu(row, picked, { multiRepo: multiRepo(), onlyRepo: selectOnlyRepo }));
    },
    onRowOpen: focusDetails,
    onRefMenu: (e, ci, row) => {
      const ref = refAtTarget(e.target, row);
      if (!ref) return;
      e.stopPropagation();
      if (!multi().has(keyOf(row.repoId, row.oid))) void select(row, ci, "single");
      openContextMenu(e, () => refMenu(row.repoId, ref));
    },
    onWipClick: () => {
      const repos = wip()?.repos ?? [];
      setChangesRepoId(repos.length === 1 ? repos[0].id : null);
      setMainTab("changes");
    },
  };

  const renderRow = (d: number): JSX.Element => {
    const item = createMemo(() => map().itemAt(d));
    const kind = createMemo(() => item().kind);
    const ci = createMemo(() => {
      const it = item();
      return it.kind === "commit" ? it.ci : -1;
    });
    return (
      <Switch>
        <Match when={kind() === "wip" && wip()}>{(w) => <WipRowView ctx={ctx} wip={w()} />}</Match>
        <Match when={kind() === "date"}>
          <DateRowView
            ctx={ctx}
            display={d}
            group={(item() as { group: number }).group}
            label={(item() as { label: string }).label}
          />
        </Match>
        <Match when={kind() === "commit"}>
          <CommitRowView ctx={ctx} ci={ci()} />
        </Match>
      </Switch>
    );
  };

  // ---------------------------------------------------------------- column header

  function startResize(e: PointerEvent, col: "graph" | "repo" | "author" | "date" | "hash", sign: 1 | -1, current: number): void {
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const move = (ev: PointerEvent) => setCols((c) => ({ ...c, [col]: clamp(current + sign * (ev.clientX - x0), LIMITS[col]) }));
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      persistCols();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }

  const resetCol = (col: "graph" | "repo" | "author" | "date" | "hash") => {
    setCols((c) => ({ ...c, [col]: DEFAULT_COLS[col] }));
    persistCols();
  };

  function headerMenu(e: MouseEvent): void {
    const toggle = (c: "repo" | "author" | "date" | "hash") => {
      setCols((cur) => ({ ...cur, hidden: { ...cur.hidden, [c]: !cur.hidden[c] } }));
      persistCols();
    };
    openContextMenu(e, [
      { heading: true, label: "Columns" },
      { label: "Graph", checked: settings.showGraph, onSelect: () => setSetting("showGraph", !settings.showGraph) },
      { label: "Repository", checked: !cols().hidden.repo, disabled: !multiRepo(), tooltip: multiRepo() ? undefined : "Only in the combined log", onSelect: () => toggle("repo") },
      { label: "Author", checked: !cols().hidden.author, onSelect: () => toggle("author") },
      { label: "Date", checked: !cols().hidden.date, onSelect: () => toggle("date") },
      { label: "Hash", checked: !cols().hidden.hash, onSelect: () => toggle("hash") },
      { separator: true },
      { label: "Reset column widths", onSelect: () => { setCols({ ...DEFAULT_COLS }); persistCols(); } },
    ]);
  }

  const Handle = (p: { col: "graph" | "repo" | "author" | "date" | "hash"; side: "left" | "right"; width: () => number }): JSX.Element => (
    <span
      class="dg-log-resize"
      classList={{ "is-left": p.side === "left", "is-right": p.side === "right" }}
      role="separator"
      aria-orientation="vertical"
      title="Drag to resize, double-click to reset"
      onPointerDown={(e) => startResize(e, p.col, p.side === "left" ? -1 : 1, p.width())}
      onDblClick={() => resetCol(p.col)}
    />
  );

  // ---------------------------------------------------------------- state of the body

  const filtersOn = () => activeFilters();
  const showEmpty = () => !ctl.loading() && !ctl.error() && ctl.info() !== null && ctl.total() === 0 && wip() === null;
  const conflictLabel = createMemo(() => {
    const names = selectedRepos().filter((r) => (summary(r.id)?.conflicted ?? 0) > 0).map((r) => r.name);
    return names.length ? `Conflicts in ${names.join(", ")}` : null;
  });

  const pickMark = (m: Mark) => void selectIndex(m.row, "center");

  const cssVars = () => ({
    "--lg-graph": graphWidth() + "px",
    "--lg-repo": colWidth("repo") + "px",
    "--lg-author": colWidth("author") + "px",
    "--lg-date": colWidth("date") + "px",
    "--lg-hash": colWidth("hash") + "px",
    "--lg-row": rowH() + "px",
  });

  return (
    <div
      ref={root}
      class="dg-log"
      style={cssVars()}
      attr:data-single={multiRepo() ? undefined : ""}
      attr:data-hide-graph={settings.showGraph ? undefined : ""}
      attr:data-hide-author={hiddenCols().author ? "" : undefined}
      attr:data-hide-date={hiddenCols().date ? "" : undefined}
      attr:data-hide-hash={hiddenCols().hash ? "" : undefined}
      attr:data-hide-repo={hiddenCols().repo ? "" : undefined}
    >
      <HeaderSlot name="main">
        <Show when={mainTab() === "log"}>
          <IconButton icon="refresh" label="Refresh" shortcut="Ctrl+R" onClick={refresh} />
        </Show>
      </HeaderSlot>

      <FilterBar inputRef={(el) => (searchInput = el)} />
      <SkippedBanner skipped={ctl.info()?.skipped ?? []} onRetry={() => void reload(untrack(query), "retry")} />
      <OperationBanners />

      <div class="dg-log-head" role="row" onContextMenu={headerMenu}>
        <span class="dg-log-h dg-log-h-graph">
          <Handle col="graph" side="right" width={graphWidth} />
        </span>
        <span class="dg-log-h dg-log-h-subject">Subject</span>
        <span class="dg-log-h dg-log-repo">
          Repository
          <Handle col="repo" side="left" width={() => colWidth("repo")} />
        </span>
        <span class="dg-log-h dg-log-author">
          Author
          <Handle col="author" side="left" width={() => colWidth("author")} />
        </span>
        <span class="dg-log-h dg-log-date">
          Date
          <Handle col="date" side="left" width={() => colWidth("date")} />
        </span>
        <span class="dg-log-h dg-log-hash">
          Hash
          <Handle col="hash" side="left" width={() => colWidth("hash")} />
        </span>
        <span />
      </div>

      <div class="dg-log-body">
        <Show when={ctl.loading()}>
          <div class="dg-log-loading" role="progressbar" aria-label="Loading the log">
            <i />
          </div>
        </Show>

        <div class="dg-log-list" classList={{ "is-hidden": showEmpty() || !!ctl.error() }}>
          <VirtualList
            class="dg-log-vlist"
            role="grid"
            ariaLabel="Commits"
            count={map().count}
            rowHeight={rowH()}
            overscan={20}
            onRangeChange={onRange}
            selectedIndex={selDisplay()}
            onSelect={onNavigate}
            onKeyDown={onListKey}
            renderRow={renderRow}
            apiRef={(a) => {
              listApi = a;
              const el = a.element();
              if (!el) return;
              el.addEventListener("scroll", onScroll, { passive: true });
              setViewHeight(el.clientHeight);
              const ro = new ResizeObserver(() => setViewHeight(el.clientHeight));
              ro.observe(el);
              onCleanup(() => {
                ro.disconnect();
                el.removeEventListener("scroll", onScroll);
              });
            }}
          />
          <Show when={stickyLabel()}>
            {(label) => <div class="dg-log-sticky" aria-hidden="true">{label()}</div>}
          </Show>
          <Ruler
            marks={ctl.scan().marks}
            count={map().count}
            rowHeight={rowH()}
            displayOf={(ci) => map().displayOf(ci)}
            selectedDisplay={selDisplay()}
            conflictLabel={conflictLabel()}
            scrollTop={scrollTop()}
            viewHeight={viewHeight()}
            scrollTo={(top) => {
              const el = listEl();
              if (el) el.scrollTop = Math.max(0, top);
            }}
            onPickMark={pickMark}
          />
        </div>

        <Switch>
          <Match when={ctl.error()}>
            {(err) => (
              <EmptyState
                icon="error"
                title="Could not load the log"
                actions={<Button variant="primary" onClick={() => void reload(untrack(query), "retry")}>Retry</Button>}
              >
                {err().message}
              </EmptyState>
            )}
          </Match>
          <Match when={showEmpty()}>
            <Show
              when={filtersOn().length > 0}
              fallback={
                <EmptyState icon="log" title="No commits yet">
                  {plural(selectedRepoIds().length, "repository", "repositories")} shown. Commits appear here after the first commit.
                </EmptyState>
              }
            >
              <EmptyState
                icon="filter"
                title="No commits match these filters"
                actions={<Button variant="primary" onClick={clearAllFilters}>Clear filters</Button>}
              >
                {plural(filtersOn().length, "filter")} {filtersOn().length === 1 ? "is" : "are"} active: {filtersOn().map((f) => f.label).join(", ")}.
              </EmptyState>
            </Show>
          </Match>
        </Switch>
      </div>
    </div>
  );
}
