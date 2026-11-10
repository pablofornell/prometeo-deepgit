/**
 * The conflicts dialog (dialog "conflicts"), after IntelliJ's `MultipleFileMergeDialog`: the conflicted files of the
 * given repos grouped by repo, with the state of each file on the Yours and Theirs side, and the buttons
 * Accept Yours, Accept Theirs and Merge… (the merge window). "Resolve simple conflicts automatically" merges every text
 * file whose changes do not collide and saves only the files that end fully resolved.
 *
 * Keys in the list: Up / Down move, Shift extends, Ctrl+A selects all, Enter or double click opens the merge window.
 */
import { For, type JSX, Show, createEffect, createSignal, on, onCleanup } from "solid-js";
import * as api from "../../api/tauri";
import { toApiError } from "../../api/tauri";
import type { ConflictEntry, ConflictLabels, ConflictSide, SideStatus } from "../../api/types";
import { Button, Dialog, type DialogComponentProps, EmptyState, Icon, RepoChip, Spinner, fileIconFor, joinNames, plural, splitPath, toast } from "../../components/ui";
import * as actions from "../../state/actions";
import type { ConflictsProps, ConflictsResult } from "../../state/dialogs";
import { subscribeRepoChanged } from "../../state/events";
import { refreshSummaries, repoById, summary } from "../../state/workspace";
import { canMergeAsText } from "./MergeFileDialog";
import { MergeModel, normalizeText } from "./model";
import { expectedOids } from "./resolve";
import "./merge.css";

interface RepoData {
  entries: ConflictEntry[];
  labels: ConflictLabels | null;
  error: string | null;
  loaded: boolean;
}

type Item = { kind: "repo"; key: string; repoId: string } | { kind: "file"; key: string; repoId: string; entry: ConflictEntry };

const SEP = "\u0000";
const fileKey = (repoId: string, path: string) => repoId + SEP + path;

const STATUS_TEXT: Record<SideStatus, string> = { modified: "Modified", added: "Added", deleted: "Deleted", missing: "-" };
/** Colour of a status in the table: the same tokens as the status letters of the changes list. */
const STATUS_COLOR: Record<SideStatus, string> = { modified: "var(--dg-status-modified)", added: "var(--dg-status-added)", deleted: "var(--dg-status-deleted)", missing: "var(--dg-text-secondary)" };

const OP: Record<string, string> = { merging: "merge", rebasing: "rebase", cherryPicking: "cherry-pick", reverting: "revert" };

export function ConflictsDialog(props: ConflictsProps & DialogComponentProps<ConflictsResult>): JSX.Element {
  const [data, setData] = createSignal<Record<string, RepoData>>({});
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  const [cursor, setCursor] = createSignal<string | null>(null);
  const [anchor, setAnchor] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal<string | null>(null);
  let listEl: HTMLDivElement | undefined;

  // ------------------------------------------------------------ data

  const seq = new Map<string, number>();
  async function load(repoId: string): Promise<void> {
    const n = (seq.get(repoId) ?? 0) + 1;
    seq.set(repoId, n);
    try {
      const entries = await api.conflicts(repoId);
      // the header names the branches; one file is enough to read them (best effort)
      const labels = entries.length > 0 ? await api.conflictVersions(repoId, entries[0].path).then((v) => v.labels, () => null) : null;
      if (seq.get(repoId) !== n) return;
      setData((d) => ({ ...d, [repoId]: { entries, labels, error: null, loaded: true } }));
    } catch (e) {
      if (seq.get(repoId) !== n) return;
      setData((d) => ({ ...d, [repoId]: { entries: d[repoId]?.entries ?? [], labels: null, error: toApiError(e).message, loaded: true } }));
    }
  }
  const loadAll = () => props.repoIds.forEach((id) => void load(id));
  loadAll();
  const off = subscribeRepoChanged((id) => props.repoIds.includes(id) && void load(id));
  onCleanup(off);

  const items = (): Item[] => {
    const out: Item[] = [];
    for (const repoId of props.repoIds) {
      const d = data()[repoId];
      if (!d || (d.entries.length === 0 && !d.error)) continue;
      out.push({ kind: "repo", key: "r" + SEP + repoId, repoId });
      for (const entry of d.entries) out.push({ kind: "file", key: fileKey(repoId, entry.path), repoId, entry });
    }
    return out;
  };
  const files = () => items().filter((i): i is Extract<Item, { kind: "file" }> => i.kind === "file");
  const loaded = () => props.repoIds.every((id) => data()[id]?.loaded);
  const total = () => files().length;
  const chosen = () => files().filter((f) => selected().has(f.key));
  const errorOf = (repoId: string) => data()[repoId]?.error ?? null;

  // a reload drops the selection of files that are gone and keeps the cursor near where it was
  createEffect(
    on(files, (cur, prev) => {
      const alive = new Set(cur.map((f) => f.key));
      const kept = [...selected()].filter((k) => alive.has(k));
      if (kept.length !== selected().size) setSelected(new Set(kept));
      const c = cursor();
      if (c && !alive.has(c)) {
        const i = prev ? prev.findIndex((f) => f.key === c) : -1;
        const next = cur[Math.min(Math.max(i, 0), cur.length - 1)]?.key ?? null;
        setCursor(next);
        setAnchor(next);
        if (next) setSelected(new Set([next]));
      } else if (!c && cur.length > 0) {
        setCursor(cur[0].key);
        setAnchor(cur[0].key);
        setSelected(new Set([cur[0].key]));
      }
    }),
  );

  // the list takes the focus when it first shows (Dialog focuses before the files are loaded)
  let focused = false;
  createEffect(() => {
    if (focused || !loaded() || total() === 0) return;
    focused = true;
    queueMicrotask(() => listEl?.focus());
  });

  // ------------------------------------------------------------ selection

  const select = (f: Item, e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
    if (f.kind !== "file") return;
    const all = files().map((x) => x.key);
    const additive = e.ctrlKey || e.metaKey;
    if (e.shiftKey && anchor()) {
      const a = all.indexOf(anchor() as string);
      const b = all.indexOf(f.key);
      const range = all.slice(Math.min(a, b), Math.max(a, b) + 1);
      setSelected(new Set(additive ? [...selected(), ...range] : range));
    } else if (additive) {
      const next = new Set(selected());
      if (!next.delete(f.key)) next.add(f.key);
      setSelected(next);
      setAnchor(f.key);
    } else {
      setSelected(new Set([f.key]));
      setAnchor(f.key);
    }
    setCursor(f.key);
  };

  const move = (delta: number, extend: boolean) => {
    const all = files();
    if (all.length === 0) return;
    const i = Math.max(0, Math.min(all.length - 1, (all.findIndex((f) => f.key === cursor()) ?? 0) + delta));
    select(all[i], { ctrlKey: false, metaKey: false, shiftKey: extend });
    listEl?.querySelector<HTMLElement>(`[data-key="${CSS.escape(all[i].key)}"]`)?.scrollIntoView({ block: "nearest" });
  };

  // ------------------------------------------------------------ actions

  const byRepo = (list: ReturnType<typeof files>): Map<string, string[]> => {
    const m = new Map<string, string[]>();
    for (const f of list) m.set(f.repoId, [...(m.get(f.repoId) ?? []), f.entry.path]);
    return m;
  };

  const accept = async (side: ConflictSide, list = chosen()) => {
    if (list.length === 0 || busy()) return;
    setBusy(side);
    try {
      for (const [repoId, paths] of byRepo(list)) await actions.acceptSide(repoId, paths, side, { offerContinue: false });
    } finally {
      setBusy(null);
    }
  };

  const merge = async (f: Extract<Item, { kind: "file" }> | undefined = chosen()[0]) => {
    if (!f || busy()) return;
    await actions.openMerge(f.repoId, f.entry.path, { offerContinue: false });
    listEl?.focus();
  };

  /** Merges every text file whose changes do not collide; a file is saved only when it ends fully resolved. */
  const resolveAutomatically = async () => {
    if (busy()) return;
    setBusy("auto");
    let resolved = 0;
    let tried = 0;
    try {
      for (const f of files()) {
        const e = f.entry;
        if (e.binary || e.ours === "deleted" || e.theirs === "deleted" || e.ours === "missing" || e.theirs === "missing") continue;
        tried++;
        try {
          const v = await api.conflictVersions(f.repoId, e.path);
          if (!canMergeAsText(v)) continue;
          const text = (b: typeof v.base) => normalizeText(b?.text ?? "", v.eol);
          const model = new MergeModel(text(v.base), text(v.ours), text(v.theirs));
          const n = model.resolveAutomatically();
          if (model.unresolved().length > 0 || (n === 0 && model.chunks.length > 0)) continue;
          const res = await actions.saveResolution(f.repoId, e.path, model.resultText(), expectedOids(v), true);
          if (res.ok.length > 0) resolved++;
        } catch {
          /* this file stays in the list: the user can open it */
        }
      }
    } finally {
      setBusy(null);
    }
    toast(
      resolved > 0
        ? { kind: "success", title: `Resolved ${resolved} of ${plural(tried, "file")} automatically`, body: resolved < tried ? "The others need a decision. Open them with Merge…." : undefined }
        : { kind: "info", title: "Nothing to resolve automatically", body: tried === 0 ? "Only files that both sides changed can be merged automatically." : "Every file has changes that collide. Open them with Merge…." },
    );
  };

  const opRepos = () => props.repoIds.filter((id) => (summary(id)?.state ?? "clean") !== "clean" && (summary(id)?.state ?? "") !== "bisecting");
  const proceed = async (repoId: string) => {
    setBusy("continue");
    try {
      const res = await actions.opContinue(repoId);
      if (res.ok.length > 0) {
        await refreshSummaries([repoId]);
        if (opRepos().length === 0) props.close({ closed: true });
      }
    } finally {
      setBusy(null);
    }
  };

  // ------------------------------------------------------------ keyboard

  const onKey = (e: KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
        e.preventDefault();
        return move(e.key === "ArrowDown" ? 1 : -1, e.shiftKey);
      case "Home":
      case "End":
        e.preventDefault();
        return move(e.key === "Home" ? -1e6 : 1e6, e.shiftKey);
      case "Enter":
        e.preventDefault();
        e.stopPropagation();
        return void merge();
      case "a":
      case "A":
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          setSelected(new Set(files().map((f) => f.key)));
        }
    }
  };

  // ------------------------------------------------------------ render

  const headerLabel = (repoId: string): string => {
    const l = data()[repoId]?.labels;
    const op = OP[summary(repoId)?.state ?? ""] ?? "";
    if (!l) return op ? `${op} in progress` : "";
    return `${op ? op + ": " : ""}Yours ${l.ours} · Theirs ${l.theirs}`;
  };

  const message = () => {
    const n = total();
    if (n === 0) return "";
    const names = props.repoIds.filter((id) => (data()[id]?.entries.length ?? 0) > 0).map((id) => repoById(id)?.name ?? id);
    return `${plural(n, "file")} ${n === 1 ? "has" : "have"} conflicts${names.length > 0 ? ` in ${joinNames(names)}` : ""}. Pick a side for a whole file, or merge it by hand.`;
  };

  return (
    <Dialog title="Conflicts" width="wide" cancelLabel="Close" onClose={() => props.close({ closed: true })}>
      <Show
        when={loaded()}
        fallback={
          <div class="dg-cf-loading">
            <Spinner />
          </div>
        }
      >
        <Show
          when={total() > 0 || props.repoIds.some(errorOf)}
          fallback={
            <div class="dg-cf-done">
              <EmptyState icon="check" title="All conflicts are resolved">
                <Show when={opRepos().length > 0} fallback="Nothing is left to resolve.">
                  Continue to finish what you started.
                </Show>
              </EmptyState>
              <For each={opRepos()}>
                {(id) => (
                  <div class="dg-cf-continue">
                    <RepoChip name={repoById(id)?.name ?? id} repo={repoById(id)} />
                    <span>{OP[summary(id)?.state ?? ""] ?? "operation"} in progress</span>
                    <span class="dg-grow" />
                    <Button variant="primary" disabled={busy() !== null} onClick={() => void proceed(id)}>
                      Continue {OP[summary(id)?.state ?? ""] ?? ""}
                    </Button>
                  </div>
                )}
              </For>
            </div>
          }
        >
          <p class="dg-cf-message dg-selectable">{message()}</p>
          <div
            ref={listEl}
            class="dg-cf-table"
            role="listbox"
            aria-multiselectable="true"
            aria-label="Conflicted files"
            tabindex={0}
            onKeyDown={onKey}
          >
            <div class="dg-cf-head" role="presentation">
              <span>Name</span>
              <span>Yours</span>
              <span>Theirs</span>
            </div>
            <For each={props.repoIds.filter((id) => errorOf(id))}>
              {(id) => (
                <div class="dg-cf-error" role="alert">
                  <Icon name="error" size={14} /> {repoById(id)?.name ?? id}: {errorOf(id)}
                  <Button size="small" variant="ghost" onClick={() => void load(id)}>Retry</Button>
                </div>
              )}
            </For>
            <For each={items()}>
              {(item) =>
                item.kind === "repo" ? (
                  <div class="dg-cf-group" role="presentation">
                    <RepoChip name={repoById(item.repoId)?.name ?? item.repoId} repo={repoById(item.repoId)} />
                    <span class="dg-cf-group-label" title={headerLabel(item.repoId)}>{headerLabel(item.repoId)}</span>
                  </div>
                ) : (
                  <div
                    class="dg-cf-row"
                    classList={{ "is-selected": selected().has(item.key), "is-cursor": cursor() === item.key }}
                    role="option"
                    aria-selected={selected().has(item.key)}
                    data-key={item.key}
                    title={item.entry.path}
                    onClick={(e) => select(item, e)}
                    onDblClick={() => void merge(item)}
                  >
                    <span class="dg-cf-name">
                      <Icon name={fileIconFor(item.entry.path)} size={16} class="dg-cf-icon" />
                      <span class="dg-cf-file">{splitPath(item.entry.path).name}</span>
                      <span class="dg-cf-dir">{splitPath(item.entry.path).dir}</span>
                      <Show when={item.entry.binary}>
                        <span class="dg-cf-tag">binary</span>
                      </Show>
                    </span>
                    <span class="dg-cf-status" style={{ color: STATUS_COLOR[item.entry.ours] }}>{STATUS_TEXT[item.entry.ours]}</span>
                    <span class="dg-cf-status" style={{ color: STATUS_COLOR[item.entry.theirs] }}>{STATUS_TEXT[item.entry.theirs]}</span>
                  </div>
                )
              }
            </For>
          </div>
          <div class="dg-cf-actions">
            <Button disabled={chosen().length === 0 || busy() !== null} title="Keep your version of the selected files" onClick={() => void accept("ours")}>
              Accept Yours
            </Button>
            <Button disabled={chosen().length === 0 || busy() !== null} title="Keep their version of the selected files" onClick={() => void accept("theirs")}>
              Accept Theirs
            </Button>
            <Button
              variant="primary"
              disabled={chosen().length !== 1 || busy() !== null}
              title={chosen().length > 1 ? "Select one file to merge it" : "Open the merge window"}
              shortcut="Enter"
              onClick={() => void merge()}
            >
              Merge…
            </Button>
            <span class="dg-grow" />
            <Button
              disabled={total() === 0 || busy() !== null}
              title="Merge the files whose changes do not collide. Only files that end fully resolved are saved."
              onClick={() => void resolveAutomatically()}
            >
              {busy() === "auto" ? "Resolving…" : "Resolve simple conflicts automatically"}
            </Button>
          </div>
        </Show>
      </Show>
    </Dialog>
  );
}
