/**
 * Diff viewer (DESIGN.md 5.10): side-by-side and unified, word-level highlights, syntax colours, collapsed
 * unchanged regions, change navigation, per-hunk actions. Rows have a fixed height and only the visible
 * window is in the DOM, so a 20 000 line diff scrolls like a short one.
 *
 *   <DiffViewer repoId={id} spec={{ kind: "commit", oid, parent: null }} path="src/a.rs" />
 */
import { type JSX, Match, Show, Switch, batch, createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, untrack } from "solid-js";
import * as api from "../../api/tauri";
import type { DiffSpec, FileDiff, HunkRef } from "../../api/types";
import { Button, EmptyState, Icon, IconButton, SegmentedControl, Spinner, StatusLetter, copyText, fileIconFor, openMenu, shortOid, splitDragging, splitPath, statusColorVar, toast, type MenuItem } from "../../components/ui";
import { confirmAction } from "../../state/dialogs";
import { repoVersion } from "../../state/events";
import { cssPx } from "../../state/metrics";
import { settings, type DiffMode } from "../../state/settings";
import { chooseDiffMode, collapseOn, explicitDiffMode, ignoreWs, lineNumbersOn, setCollapseOn, setIgnoreWs, setLineNumbersOn, setSyntaxOn, setWordDiffOn, syntaxOn, wordDiffOn } from "./diffPrefs";
import { activateDiff, releaseDiff, type DiffController } from "./diffKeys";
import { NARROW_DIFF_PX, effectiveDiffMode } from "./diffMode";
import {
  BIG_DIFF_LINES, CONTEXT, FULL_CONTEXT, buildItems, countLines, isWhitespaceOnly, statusOf, toSideBySide, toUnified, usableFull,
  type ChangeMark, type Model, type SbsRow, type UniRow,
} from "./diffModel";
import { SbsHalf, UnifiedRow, type RowCtx } from "./DiffRows";
import { hunkHash } from "./hunkHash";
import { stepToward, targetScrollLeft } from "./pointerScroll";
import { languageFor } from "./syntax";
import "./diff.css";

export interface DiffViewerProps {
  repoId: string;
  spec: DiffSpec;
  path: string;
  oldPath?: string;
  /** Called by the "Stage hunk" strip (Local changes, unstaged diff). `info` is the hunk header and diff context the user sees. */
  onStageHunk?: (hunkIndex: number, info?: { expected: HunkRef; context: number }) => void;
  /** Called by the "Unstage hunk" strip (staged diff). */
  onUnstageHunk?: (hunkIndex: number, info?: { expected: HunkRef; context: number }) => void;
  onDiscardHunk?: (hunkIndex: number, info?: { expected: HunkRef; context: number }) => void;
  /** Extra controls placed in the diff header (right side). */
  toolbarExtra?: JSX.Element;
}

/** Diff line height in px (`--dg-line-height-code`, follows the editor font size). */
const rowH = (): number => cssPx("--dg-line-height-code", 20);
const OVERSCAN = 15;
/** Syntax colours are off above this many characters (DESIGN.md 5.10: 1 MB). */
const SYNTAX_MAX_CHARS = 1_000_000;

type View = { kind: "sbs"; m: Model<SbsRow> } | { kind: "uni"; m: Model<UniRow> };
type Status = "loading" | "ready" | "error";

const fmt = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

export function DiffViewer(props: DiffViewerProps): JSX.Element {
  const [diff, setDiff] = createSignal<FileDiff | null>(null);
  const [full, setFull] = createSignal<FileDiff | null>(null);
  const [status, setStatus] = createSignal<Status>("loading");
  const [error, setError] = createSignal("");
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
  const [wantFull, setWantFull] = createSignal(false);
  const [fullTooLarge, setFullTooLarge] = createSignal(false);
  const [showBig, setShowBig] = createSignal(false);
  const [active, setActive] = createSignal(0);
  const [retry, setRetry] = createSignal(0);
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewH, setViewH] = createSignal(0);
  // Width of the whole viewer (last measured while visible). A narrow pane shows unified unless the user chose a layout this session.
  const [width, setWidth] = createSignal(0);
  const narrow = () => width() > 0 && width() < NARROW_DIFF_PX;
  // The layout shown feeds back into the choice (hysteresis band) and is held while a splitter drag is in progress.
  // Only a unified layout that came from the narrow fallback is held in the band; a changed saved setting applies at once.
  let fellBack = false;
  const mode = createMemo<DiffMode>((shown) => {
    const explicit = explicitDiffMode();
    if (!explicit && shown && splitDragging()) return shown;
    const saved = settings.diffMode;
    const m = effectiveDiffMode(explicit, saved, width(), shown ? (fellBack ? "unified" : saved) : null);
    fellBack = !explicit && m === "unified" && saved !== "unified";
    return m;
  });

  let loadedKey = "";
  let root: HTMLDivElement | undefined;
  // Scroll offsets seen while the viewer was visible, put back when a hidden tab is shown again (a hidden element may lose them).
  let seenTop = 0;
  let seenLeft = 0;
  let seq = 0;
  let fullSeq = 0;
  let primary: HTMLDivElement | undefined;
  let left: HTMLDivElement | undefined;

  // ---------------------------------------------------------------- loading

  createEffect(() => {
    const repoId = props.repoId;
    const spec = props.spec;
    const path = props.path;
    const oldPath = props.oldPath ?? null;
    repoVersion(repoId);
    retry();
    const fileKey = `${repoId}\u0000${JSON.stringify(spec)}\u0000${path}\u0000${oldPath ?? ""}`;
    const mine = ++seq;
    untrack(() => {
      if (fileKey === loadedKey) return;
      batch(() => {
        setDiff(null);
        setFull(null);
        setExpanded(new Set<string>());
        setWantFull(false);
        setFullTooLarge(false);
        setShowBig(false);
        setActive(0);
        setError("");
        setStatus("loading");
      });
    });
    api.fileDiff(repoId, spec, path, oldPath, CONTEXT).then(
      (d) => {
        if (mine !== seq) return;
        batch(() => {
          loadedKey = fileKey;
          setDiff(d);
          if (!(wantFull() || !collapseOn())) setFull(null);
          setStatus("ready");
        });
      },
      (e: unknown) => {
        if (mine !== seq) return;
        batch(() => {
          loadedKey = "";
          setDiff(null);
          setError(e instanceof Object && "message" in e ? String((e as { message: unknown }).message) : String(e));
          setStatus("error");
        });
      },
    );
  });

  // The whole-file diff, loaded when a fold is opened or "collapse unchanged lines" is off.
  const needFull = () => wantFull() || !collapseOn();
  createEffect(() => {
    const d = diff();
    if (!d || !needFull() || d.binary || d.tooLarge || d.hunks.length === 0) return;
    const mine = ++fullSeq;
    const { repoId, spec, path } = untrack(() => ({ repoId: props.repoId, spec: props.spec, path: props.path }));
    api.fileDiff(repoId, spec, path, untrack(() => props.oldPath) ?? null, FULL_CONTEXT).then(
      (f) => {
        if (mine !== fullSeq || diff() !== d) return;
        const ok = usableFull(f);
        if (ok) {
          setFull(ok);
          return;
        }
        // Too large to expand: keep the hunk view, drop the request, tell the user.
        batch(() => {
          setWantFull(false);
          setFullTooLarge(f.tooLarge);
        });
      },
      () => {
        if (mine === fullSeq) setWantFull(false);
      },
    );
  });

  // ---------------------------------------------------------------- model

  const lang = createMemo(() => languageFor(props.path));
  const totalChars = createMemo(() => {
    let n = 0;
    for (const h of diff()?.hunks ?? []) for (const l of h.lines) n += l.text.length;
    return n;
  });
  const syntaxEnabled = () => syntaxOn() && totalChars() <= SYNTAX_MAX_CHARS;
  const counts = createMemo(() => {
    const d = diff();
    return d ? countLines(d) : { additions: 0, deletions: 0 };
  });
  const big = () => counts().additions + counts().deletions > BIG_DIFF_LINES && !showBig();

  const items = createMemo(() => {
    const d = diff();
    if (!d || d.binary || d.tooLarge || big()) return [];
    return buildItems(d, full(), { expanded: expanded(), expandAll: !collapseOn() });
  });
  const view = createMemo<View>(() =>
    mode() === "unified" ? { kind: "uni", m: toUnified(items(), ignoreWs()) } : { kind: "sbs", m: toSideBySide(items(), ignoreWs()) },
  );
  const sbsRows = createMemo(() => {
    const v = view();
    return v.kind === "sbs" ? v.m.rows : [];
  });
  const uniRows = createMemo(() => {
    const v = view();
    return v.kind === "uni" ? v.m.rows : [];
  });
  const rowCount = () => view().m.rows.length;
  const changes = (): ChangeMark[] => view().m.changes;
  const maxCols = () => view().m.maxCols;
  // Digits of the largest line number in the loaded diff (the whole file included), at least 3. Sizes the line number gutter.
  const lnDigits = createMemo(() => {
    let max = 0;
    for (const d of [diff(), full()]) {
      for (const h of d?.hunks ?? []) max = Math.max(max, h.oldStart + h.oldLines - 1, h.newStart + h.newLines - 1);
    }
    return Math.max(3, String(max).length);
  });

  // ---------------------------------------------------------------- window

  const range = createMemo<readonly [number, number]>(
    () => {
      const first = Math.floor(scrollTop() / rowH());
      return [Math.max(0, first - OVERSCAN), Math.min(rowCount(), first + Math.ceil(viewH() / rowH()) + 1 + OVERSCAN)] as const;
    },
    [0, 0] as const,
    { equals: (a, b) => a[0] === b[0] && a[1] === b[1] },
  );
  const indexes = createMemo(() => {
    const [s, e] = range();
    const out: number[] = [];
    for (let i = s; i < e; i++) out.push(i);
    return out;
  });

  let observer: ResizeObserver | undefined;
  const attachPrimary = (el: HTMLDivElement, split: boolean) => {
    primary = el;
    if (!split) left = undefined;
    observer?.disconnect();
    observer?.observe(el);
    setViewH(el.clientHeight);
    setScrollTop(el.scrollTop);
    seenTop = el.scrollTop;
    seenLeft = el.scrollLeft;
  };
  const onResize = () => {
    if (!primary || primary.clientHeight === 0) return;
    // Visible again after a hidden tab: restore the scroll position, then measure.
    if (primary.scrollTop !== seenTop || primary.scrollLeft !== seenLeft) {
      primary.scrollTop = seenTop;
      primary.scrollLeft = seenLeft;
      if (left) {
        left.scrollTop = seenTop;
        left.scrollLeft = seenLeft;
      }
    }
    setViewH(primary.clientHeight);
    setScrollTop(primary.scrollTop);
  };
  let rootObserver: ResizeObserver | undefined;
  onMount(() => {
    observer = new ResizeObserver(onResize);
    if (primary) observer.observe(primary);
    // A hidden tab measures 0: keep the last real width so the layout does not flip while the tab is hidden.
    const measureWidth = () => root && root.clientWidth > 0 && setWidth(root.clientWidth);
    rootObserver = new ResizeObserver(measureWidth);
    if (root) {
      rootObserver.observe(root);
      measureWidth();
    }
  });
  onCleanup(() => {
    observer?.disconnect();
    rootObserver?.disconnect();
  });

  const onPrimaryScroll = () => {
    if (!primary) return;
    if (primary.clientHeight > 0) {
      seenTop = primary.scrollTop;
      seenLeft = primary.scrollLeft;
    }
    setScrollTop(primary.scrollTop);
    if (left) {
      if (left.scrollTop !== primary.scrollTop) left.scrollTop = primary.scrollTop;
      if (left.scrollLeft !== primary.scrollLeft) left.scrollLeft = primary.scrollLeft;
    }
  };
  const onLeftScroll = () => {
    if (!primary || !left) return;
    if (primary.scrollLeft !== left.scrollLeft) primary.scrollLeft = left.scrollLeft;
    if (primary.scrollTop !== left.scrollTop) primary.scrollTop = left.scrollTop;
  };
  const onLeftWheel = (e: WheelEvent) => {
    if (!primary || e.shiftKey || Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
    primary.scrollTop += e.deltaMode === 1 ? e.deltaY * rowH() : e.deltaY;
    e.preventDefault();
  };

  // ---------------------------------------------------------------- pointer scroll (long lines)

  // The pointer position sets a target per pane. One animation loop eases each pane toward its target.
  const panTargets = new Map<HTMLDivElement, number>();
  let panFrame = 0;
  const stopPointerScroll = () => {
    panTargets.clear();
    if (panFrame) cancelAnimationFrame(panFrame);
    panFrame = 0;
  };
  const panTick = () => {
    panFrame = 0;
    for (const [pane, target] of panTargets) {
      const next = stepToward(pane.scrollLeft, target);
      pane.scrollLeft = next;
      // Stop at the target. Also stop when the browser rounds the position to within a pixel of it.
      if (next === target || Math.abs(target - pane.scrollLeft) < 1) panTargets.delete(pane);
    }
    if (panTargets.size > 0) panFrame = requestAnimationFrame(panTick);
  };
  // `pane` is the pane under the pointer. Both panes get the same ratio, each with its own overflow.
  const onPanePointerMove = (e: PointerEvent, pane: HTMLDivElement | undefined) => {
    if (!settings.diffPointerScroll || e.pointerType !== "mouse" || !pane) return;
    // A button is down (a text selection drag): leave the scroll position alone.
    if (e.buttons !== 0) {
      stopPointerScroll();
      return;
    }
    const rect = pane.getBoundingClientRect();
    for (const p of [primary, left]) {
      if (!p) continue;
      const max = p.scrollWidth - p.clientWidth;
      if (max <= 0) {
        panTargets.delete(p);
        continue;
      }
      panTargets.set(p, targetScrollLeft(e.clientX, rect.left, rect.width, max));
    }
    if (panTargets.size > 0 && !panFrame) panFrame = requestAnimationFrame(panTick);
  };
  createEffect(
    on(
      () => settings.diffPointerScroll,
      (enabled) => {
        if (!enabled) stopPointerScroll();
      },
      { defer: true },
    ),
  );
  onCleanup(stopPointerScroll);

  const scrollToRow = (row: number) => {
    if (!primary) return;
    const top = row * rowH();
    const vh = primary.clientHeight;
    if (top < primary.scrollTop + rowH() || top + rowH() * 3 > primary.scrollTop + vh) primary.scrollTop = Math.max(0, top - Math.floor(vh / 3));
  };

  // ---------------------------------------------------------------- change navigation

  const goTo = (i: number): boolean => {
    const list = changes();
    if (i < 0 || i >= list.length) return false;
    setActive(i);
    scrollToRow(list[i].row);
    return true;
  };
  const controller: DiffController = {
    next: () => goTo(active() + 1),
    prev: () => goTo(active() - 1),
    toggleIgnoreWhitespace: () => setIgnoreWs(ignoreWs() === "off" ? "all" : "off"),
    toggleMode: () => chooseDiffMode(mode() === "sideBySide" ? "unified" : "sideBySide"),
  };
  onMount(() => activateDiff(controller));
  onCleanup(() => releaseDiff(controller));

  // Keep the focused change in view when the layout switches.
  createEffect(
    on(
      mode,
      () => queueMicrotask(() => goTo(Math.min(active(), changes().length - 1))),
      { defer: true },
    ),
  );
  createEffect(() => {
    const n = changes().length;
    if (active() >= n && n > 0) setActive(n - 1);
  });

  // ---------------------------------------------------------------- hunk actions and folds

  // Hunk indexes refer to `diff().hunks`, which is always loaded with `CONTEXT` (the full diff only adds lines).
  // Read at click time, so the header matches the hunk the user pointed at.
  const hunkInfo = (i: number) => {
    const h = diff()?.hunks[i];
    return h ? { expected: { oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, hash: hunkHash(h.lines) }, context: CONTEXT } : undefined;
  };

  const discardHunk = async (i: number) => {
    const r = await confirmAction({
      title: "Discard hunk",
      message: `Discard this change in ${props.path}? This cannot be undone.`,
      confirmLabel: "Discard hunk",
      danger: true,
    });
    // built after the dialog closed: from the diff shown now, not the one shown when it opened
    if (r) props.onDiscardHunk?.(i, hunkInfo(i));
  };

  const ctx: RowCtx = {
    lang,
    syntax: syntaxEnabled,
    words: wordDiffOn,
    active,
    actions: () => ({
      stage: props.onStageHunk ? (i: number) => props.onStageHunk?.(i, hunkInfo(i)) : undefined,
      unstage: props.onUnstageHunk ? (i: number) => props.onUnstageHunk?.(i, hunkInfo(i)) : undefined,
      discard: props.onDiscardHunk ? discardHunk : undefined,
    }),
    expanding: () => wantFull() && !full(),
    onFold: (id) => {
      batch(() => {
        setExpanded(new Set([...expanded(), id]));
        if (!fullTooLarge()) setWantFull(true);
      });
    },
  };

  // ---------------------------------------------------------------- captions

  const commitKey = createMemo(() => (props.spec.kind === "commit" ? `${props.repoId}:${props.spec.oid}` : null));
  const [parents] = createResource(commitKey, (key) => {
    const i = key.indexOf(":");
    return api.commitDetails(key.slice(0, i), key.slice(i + 1)).then(
      (d) => d.parents,
      () => [] as string[],
    );
  });
  const captions = createMemo<{ l: [string, string]; r: [string, string] }>(() => {
    const s = props.spec;
    if (s.kind === "commit") {
      const parent = s.parent ?? parents()?.[0] ?? "";
      return { l: [parent ? shortOid(parent) : "", "parent"], r: [shortOid(s.oid), "this commit"] };
    }
    if (s.kind === "staged") return { l: ["HEAD", ""], r: ["Index", ""] };
    return { l: ["Index", ""], r: ["Working tree", ""] };
  });

  // ---------------------------------------------------------------- toolbar

  const path = () => splitPath(props.path);
  const fileStatus = () => {
    const d = diff();
    return d ? statusOf(d, props.path, props.oldPath) : "modified";
  };
  const wsOnly = createMemo(() => {
    const d = diff();
    return d ? isWhitespaceOnly(d) : false;
  });

  const copyPath = async () => {
    if (await copyText(props.path)) toast({ kind: "success", title: "Copied path", body: props.path, timeout: 2000 });
  };

  const optionsMenu = (e: MouseEvent) => {
    const ws = ignoreWs();
    const items: MenuItem[] = [
      { label: "Ignore whitespace", heading: true },
      { label: "Off", checked: ws === "off", onSelect: () => setIgnoreWs("off") },
      { label: "Trailing", checked: ws === "trailing", onSelect: () => setIgnoreWs("trailing") },
      { label: "All", checked: ws === "all", shortcut: "Ctrl+Alt+W", onSelect: () => setIgnoreWs("all") },
      { separator: true },
      { label: "Word diff", checked: wordDiffOn(), onSelect: () => setWordDiffOn(!wordDiffOn()) },
      { label: "Syntax colours", checked: syntaxOn(), onSelect: () => setSyntaxOn(!syntaxOn()) },
      { label: "Collapse unchanged lines", checked: collapseOn(), onSelect: () => setCollapseOn(!collapseOn()) },
      { label: "Show line numbers", checked: lineNumbersOn(), onSelect: () => setLineNumbersOn(!lineNumbersOn()) },
      { separator: true },
      { label: "Copy path", icon: "copy", onSelect: () => void copyPath() },
    ];
    openMenu(e.currentTarget as HTMLElement, items);
  };

  // ---------------------------------------------------------------- body

  const hasBody = () => {
    const d = diff();
    return !!d && !d.binary && !d.tooLarge && d.hunks.length > 0 && !big();
  };

  const rowBox = (i: number, children: JSX.Element) => (
    <div class="dg-diff-rowbox" style={{ top: i * rowH() + "px" }}>
      {children}
    </div>
  );

  const spacerStyle = () => ({ height: rowCount() * rowH() + "px", "--dgd-cols": String(maxCols() + 2) });

  return (
    <div
      ref={root}
      class="dg-diff"
      tabindex={-1}
      classList={{ "has-no-ln": !lineNumbersOn(), "is-narrow": narrow() }}
      style={{ "--dgd-ln-digits": String(lnDigits()) }}
      onPointerDown={() => activateDiff(controller)}
      onFocusIn={() => activateDiff(controller)}
    >
      <div class="dg-diff-head">
        <Icon name={fileIconFor(props.path)} size={16} class="dg-diff-file-icon" />
        <span class="dg-diff-path" title={props.oldPath && props.oldPath !== props.path ? `${props.oldPath} → ${props.path}` : props.path}>
          <Show when={props.oldPath && props.oldPath !== props.path}>
            <span class="dg-diff-dir">{props.oldPath} → </span>
          </Show>
          <span class="dg-diff-dir">{path().dir}</span>
          <span class="dg-diff-name" style={diff() ? { color: statusColorVar(fileStatus()) } : undefined}>{path().name}</span>
        </span>
        <Show when={diff()}>
          <StatusLetter status={fileStatus()} />
          <Show when={counts().additions > 0}>
            <span class="dg-diff-n dg-diff-n-add">+{fmt(counts().additions)}</span>
          </Show>
          <Show when={counts().deletions > 0}>
            <span class="dg-diff-n dg-diff-n-del">−{fmt(counts().deletions)}</span>
          </Show>
          <Show when={fullTooLarge()}>
            <span class="dg-diff-chip" role="status" title="The whole file is too large to show unchanged lines">
              File too large to expand
            </span>
          </Show>
          <Show when={wsOnly()}>
            <span class="dg-diff-chip" title="Every change in this file is whitespace only">
              whitespace only
            </span>
          </Show>
        </Show>
        <IconButton icon="copy" label="Copy path" size="small" iconSize={14} onClick={() => void copyPath()} />
        <span class="dg-diff-grow" />
        {props.toolbarExtra}
        <Show when={changes().length > 0}>
          <span class="dg-diff-nav">
            <IconButton icon="arrowUp" label="Previous change" shortcut="Shift+F7" iconSize={14} disabled={active() <= 0} onClick={() => goTo(active() - 1)} />
            <span class="dg-diff-nav-text">
              {narrow() ? `${active() + 1}/${changes().length}` : `Change ${active() + 1} of ${changes().length}`}
            </span>
            <IconButton icon="arrowDown" label="Next change" shortcut="F7" iconSize={14} disabled={active() >= changes().length - 1} onClick={() => goTo(active() + 1)} />
          </span>
          <span class="dg-diff-vsep" />
        </Show>
        <SegmentedControl
          label="Diff layout"
          value={mode()}
          onChange={chooseDiffMode}
          options={[
            { value: "sideBySide", label: narrow() ? undefined : "Side by side", icon: "sideBySide", title: "Side by side  Ctrl+Alt+D" },
            { value: "unified", label: narrow() ? undefined : "Unified", icon: "unified", title: "Unified  Ctrl+Alt+D" },
          ]}
        />
        <IconButton icon="more" label="Diff options" onClick={optionsMenu} />
      </div>

      <Switch>
        <Match when={status() === "error"}>
          <EmptyState
            icon="error"
            title="Could not load the diff"
            actions={
              <Button size="small" icon="refresh" onClick={() => setRetry(retry() + 1)}>
                Try again
              </Button>
            }
          >
            {error()}
          </EmptyState>
        </Match>
        <Match when={status() === "loading" && !diff()}>
          <div class="dg-diff-center" role="status">
            <Spinner />
            <span>Loading diff…</span>
          </div>
        </Match>
        <Match when={diff()?.binary}>
          <EmptyState icon="fileBinary" title="Binary file">
            {props.path} cannot be shown as text.
          </EmptyState>
        </Match>
        <Match when={diff()?.tooLarge}>
          <EmptyState icon="warning" title="This diff is too large to show">
            It has more than 20 000 lines. Use a terminal or an external diff tool for this file.
          </EmptyState>
        </Match>
        <Match when={diff() && big()}>
          <EmptyState
            icon="warning"
            title={`This diff has ${fmt(counts().additions + counts().deletions)} changed lines.`}
            actions={
              <Button variant="primary" size="small" onClick={() => setShowBig(true)}>
                Show diff
              </Button>
            }
          >
            Rendering it can take a moment.
          </EmptyState>
        </Match>
        <Match when={diff() && diff()?.hunks.length === 0}>
          <EmptyState icon="check" title="No changes">
            This file has no textual changes.
          </EmptyState>
        </Match>
        <Match when={hasBody()}>
          <Show
            when={mode() === "sideBySide"}
            fallback={
              <div class="dg-diff-body dg-diff-body-uni" classList={{ "is-busy": status() === "loading" }}>
                <div class="dg-diff-cap">
                  <span class="dg-diff-cap-hash">{captions().l[0]}</span>
                  <span class="dg-diff-cap-label">{captions().l[1]}</span>
                  <Icon name="arrowRight" size={12} />
                  <span class="dg-diff-cap-hash">{captions().r[0]}</span>
                  <span class="dg-diff-cap-label">{captions().r[1]}</span>
                </div>
                <div
                  class="dg-diff-pane"
                  tabindex={0}
                  ref={(el) => attachPrimary(el, false)}
                  onScroll={onPrimaryScroll}
                  onPointerMove={(e) => onPanePointerMove(e, primary)}
                  onPointerLeave={stopPointerScroll}
                >
                  <div class="dg-diff-spacer" style={spacerStyle()}>
                    <For each={indexes()}>
                      {(i) => rowBox(i, <Show when={uniRows()[i]} keyed>{(r) => <UnifiedRow row={r} ctx={ctx} />}</Show>)}
                    </For>
                  </div>
                </div>
                <Ruler changes={changes()} count={rowCount()} active={active()} onJump={goTo} />
              </div>
            }
          >
            <div class="dg-diff-body dg-diff-body-sbs" classList={{ "is-busy": status() === "loading" }}>
              <div class="dg-diff-cap">
                <span class="dg-diff-cap-hash">{captions().l[0]}</span>
                <span class="dg-diff-cap-label">{captions().l[1]}</span>
              </div>
              <div class="dg-diff-cap dg-diff-cap-r">
                <span class="dg-diff-cap-hash">{captions().r[0]}</span>
                <span class="dg-diff-cap-label">{captions().r[1]}</span>
              </div>
              <div
                class="dg-diff-pane dg-diff-pane-l"
                tabindex={-1}
                ref={(el) => (left = el)}
                onScroll={onLeftScroll}
                onWheel={onLeftWheel}
                onPointerMove={(e) => onPanePointerMove(e, left)}
                onPointerLeave={stopPointerScroll}
              >
                <div class="dg-diff-spacer" style={spacerStyle()}>
                  <For each={indexes()}>
                    {(i) => rowBox(i, <Show when={sbsRows()[i]} keyed>{(r) => <SbsHalf row={r} side="l" ctx={ctx} />}</Show>)}
                  </For>
                </div>
              </div>
              <div class="dg-diff-gap" aria-hidden="true" />
              <div
                class="dg-diff-pane dg-diff-pane-r"
                tabindex={0}
                ref={(el) => attachPrimary(el, true)}
                onScroll={onPrimaryScroll}
                onPointerMove={(e) => onPanePointerMove(e, primary)}
                onPointerLeave={stopPointerScroll}
              >
                <div class="dg-diff-spacer" style={spacerStyle()}>
                  <For each={indexes()}>
                    {(i) => rowBox(i, <Show when={sbsRows()[i]} keyed>{(r) => <SbsHalf row={r} side="r" ctx={ctx} />}</Show>)}
                  </For>
                </div>
              </div>
              <Ruler changes={changes()} count={rowCount()} active={active()} onJump={goTo} />
            </div>
          </Show>
        </Match>
      </Switch>
    </div>
  );
}

/** The 12 px strip at the right edge: one mark per change, click to jump. */
function Ruler(props: { changes: ChangeMark[]; count: number; active: number; onJump: (i: number) => void }): JSX.Element {
  return (
    <div class="dg-diff-ruler" aria-hidden="true">
      <For each={props.changes}>
        {(c, i) => (
          <i
            class={"dg-diff-rm dg-diff-rm-" + c.kind}
            classList={{ "is-focus": i() === props.active }}
            style={{ top: (c.row / Math.max(1, props.count)) * 100 + "%", height: ((c.end - c.row + 1) / Math.max(1, props.count)) * 100 + "%" }}
            onClick={() => props.onJump(i())}
          />
        )}
      </For>
    </div>
  );
}
