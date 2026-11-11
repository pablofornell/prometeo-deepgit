/**
 * "Files" tab of the main island. It shows the project files in a tree, a text search of the project, and a basic editor.
 * Each open file keeps its own undo history. The tree shows the git status of files and folders.
 * A save checks that the file did not change on disk.
 *
 * This is not a full IDE. There is no rename, no create and no replace.
 * A clean tab reloads when its file changes on disk. A tab with unsaved changes keeps its text.
 * Shortcuts work on this tab only: Ctrl+S saves, Ctrl+P opens a file by name, Ctrl+Shift+F searches the project,
 * and Ctrl+F finds text in the file.
 */
import { type JSX, For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from "solid-js";
import type { EditorState, Text } from "@codemirror/state";
import { openSearchPanel } from "@codemirror/search";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import * as api from "../../api/tauri";
import type { FileStatus, TextFile } from "../../api/types";
import {
  Button, Dialog, EmptyState, Icon, IconButton, Kbd, Spinner, Splitter, StatusLetter, Tree, createExpanded, fileIconFor, loadSplitSize, openDialog, splitPath,
  statusColorVar, tip, toast, type DialogComponentProps, type TreeRowInfo,
} from "../../components/ui";
import { confirmAction } from "../../state/dialogs";
import { repoVersion } from "../../state/events";
import { shortcutLabel, register, trackOverlay } from "../../state/keymap";
import { mainTab } from "../../state/selection";
import { projectRepos } from "../../state/workspace";
import { createFileState, saveText } from "./editor";
import { ProjectSearch, type SearchApi, type SearchOpen } from "./ProjectSearch";
import { QuickOpen, type QuickFile } from "./QuickOpen";
import {
  SEP, buildTree, closeTab, errorText, folderStatus, folderStatuses, isStaleVersion, matchRange, openTab, repoNode, scopeId, statusMap, tabLabels, type TreeNode,
} from "./model";
import "./files.css";

type Kind = "loading" | "text" | "binary" | "tooLarge" | "error";

/** The data of an open file that the tab strip and the editor area need. The editor state is kept apart. */
interface TabInfo {
  key: string;
  repoId: string;
  /** The path relative to the repo. */
  path: string;
  kind: Kind;
  /** The version of the file on disk. The editor loaded or saved this version. */
  version: string;
  dirty: boolean;
  error?: string;
}

interface RepoData {
  files: string[];
  truncated: boolean;
  error?: string;
}

interface RepoStatus {
  files: Map<string, FileStatus>;
  folders: Map<string, FileStatus>;
}

const NO_STATUS: RepoStatus = { files: new Map(), folders: new Map() };
const TREE_KEY = "files-tree";
const REFRESH_MS = 300;
const TOO_MANY = "Too many files: the list shows the first 100 000.";
const BINARY = "Binary file. DeepGit does not show it.";
const TOO_LARGE = "This file is larger than 2 MiB. DeepGit does not open it.";

/** Asks what to do with a file that changed on disk after it opened. */
function ChangedOnDisk(props: { name: string } & DialogComponentProps<"overwrite" | "reload">): JSX.Element {
  return (
    <Dialog
      title="The file changed on disk."
      onClose={() => props.close()}
      primary={{ label: "Overwrite", danger: true, onClick: () => props.close("overwrite") }}
      footerLeft={<Button onClick={() => props.close("reload")}>Reload</Button>}
    >
      <p class="dg-selectable" style={{ "line-height": "18px" }}>
        {`${props.name} changed on disk after you opened it. Overwrite the file with your text, or reload it and lose your changes.`}
      </p>
    </Dialog>
  );
}

export function FilesView(): JSX.Element {
  // ---- layout
  const [treeW, setTreeW] = createSignal(loadSplitSize(TREE_KEY, 260));
  const [leftTab, setLeftTab] = createSignal<"files" | "search">("files");
  const [quick, setQuick] = createSignal(false);
  trackOverlay(quick);

  // ---- project files and their git status
  const [lists, setLists] = createSignal<Map<string, RepoData>>(new Map());
  const [statuses, setStatuses] = createSignal<Map<string, RepoStatus>>(new Map());
  const [loaded, setLoaded] = createSignal(false);
  const [sel, setSel] = createSignal<TreeNode | null>(null);
  const [expanded, ex] = createExpanded();
  let expandedFor = "";

  // ---- open tabs. The order and the data are signals. The editor states are plain maps, because they hold the documents.
  const [order, setOrder] = createSignal<string[]>([]);
  const [infos, setInfos] = createSignal<Record<string, TabInfo>>({});
  const [activeKey, setActiveSig] = createSignal<string | null>(null);
  let current: string | null = null;
  const states = new Map<string, EditorState>();
  /** The document as it is on disk. The tab is dirty when its document differs. */
  const saved = new Map<string, Text>();
  const scrolls = new Map<string, number>();
  let view: EditorView | undefined;
  let editorEl: HTMLDivElement | undefined;
  let searchApi: SearchApi | undefined;

  const tabList = createMemo(() => {
    const m = infos();
    return order().map((k) => m[k]).filter((t): t is TabInfo => !!t);
  });
  // Two root files can have one name (README.md in two repos). The repo name tells them apart.
  const labels = createMemo(() => {
    const list = tabList();
    const names = new Map(projectRepos().map((r): [string, string] => [r.id, r.name]));
    const multi = projectRepos().length > 1;
    return tabLabels(
      list.map((t) => t.path),
      list.map((t) => (multi ? names.get(t.repoId) ?? "" : "")),
    );
  });
  const active = createMemo(() => {
    const k = activeKey();
    return k ? infos()[k] : undefined;
  });
  const tabOf = (key: string): TabInfo | undefined => infos()[key];

  const patch = (key: string, p: Partial<TabInfo>): void => {
    if (!untrack(() => infos()[key])) return;
    setInfos((m) => ({ ...m, [key]: { ...m[key], ...p } }));
  };
  const isDirty = (key: string): boolean => {
    const st = states.get(key);
    const base = saved.get(key);
    return !!st && !!base && !st.doc.eq(base);
  };
  /** Returns the 1-based line of the cursor. Returns 1 when the tab has no editor. */
  const lineOf = (key: string): number => {
    const st = states.get(key);
    return st ? st.doc.lineAt(st.selection.main.head).number : 1;
  };
  const statusOf = (repoId: string): RepoStatus => statuses().get(repoId) ?? NO_STATUS;

  /** Runs after each change of the editor on screen. It keeps the state and the dirty flag. */
  const onUpdate = (u: ViewUpdate): void => {
    const key = current;
    if (!key) return;
    states.set(key, u.state);
    if (u.docChanged) {
      const d = isDirty(key);
      if (untrack(() => tabOf(key)?.dirty) !== d) patch(key, { dirty: d });
    }
  };

  /** Shows `st` in the editor. It restores the scroll position when the tab had one. */
  const show = (key: string, st: EditorState, keepScroll = false): void => {
    if (!view) return;
    const top = keepScroll ? view.scrollDOM.scrollTop : scrolls.get(key);
    if (view.state !== st) view.setState(st);
    if (top === undefined) return;
    // The editor measures the document again after the swap. Set the position on the next frame.
    requestAnimationFrame(() => {
      if (view && current === key) view.scrollDOM.scrollTop = top;
    });
  };

  /** Shows the tab `key`. It does not reload the file. */
  const activate = (key: string | null): void => {
    if (current && view) scrolls.set(current, view.scrollDOM.scrollTop);
    current = key;
    setActiveSig(key);
    const st = key ? states.get(key) : undefined;
    if (key && st) show(key, st);
  };

  const selectTab = (key: string): void => {
    activate(key);
    if (tabOf(key)?.kind === "text") view?.focus();
  };

  /** Reads the file of a tab from disk and shows it. `line` is the line of the cursor. */
  const readInto = async (key: string, line?: number): Promise<void> => {
    const t = tabOf(key);
    if (!t) return;
    let f: TextFile;
    try {
      f = await api.readTextFile(t.repoId, t.path);
    } catch (e) {
      if (!tabOf(key)) return;
      if (states.has(key)) {
        // The reload failed. The unsaved text stays.
        toast({ kind: "error", title: `Could not reload ${splitPath(t.path).name}`, body: errorText(e) });
        return;
      }
      patch(key, { kind: "error", version: "", dirty: false, error: errorText(e) });
      return;
    }
    applyRead(key, f, line);
  };

  /** Puts a file read from disk into its tab. Text gets a new editor state. Binary and large files get a note. */
  const applyRead = (key: string, f: TextFile, line = 1): void => {
    const t = tabOf(key);
    if (!t) return;
    if (f.binary || f.tooLarge) {
      states.delete(key);
      saved.delete(key);
      patch(key, { kind: f.tooLarge ? "tooLarge" : "binary", version: "", dirty: false, error: undefined });
      return;
    }
    const st = createFileState(f.content, t.path, onUpdate, line);
    states.set(key, st);
    saved.set(key, st.doc);
    patch(key, { kind: "text", version: f.version, dirty: false, error: undefined });
    if (current === key) show(key, st, true);
  };

  const addTab = (key: string, repoId: string, path: string): void => {
    const keys = [...order()];
    openTab(keys, key);
    setOrder(keys);
    setInfos((m) => ({ ...m, [key]: { key, repoId, path, kind: "loading", version: "", dirty: false } }));
  };

  /** Opens a file in a tab, or shows its open tab. `after` runs when the text is on screen. */
  const openFile = async (repoId: string, path: string, after?: () => void): Promise<void> => {
    const key = scopeId(repoId, path);
    const have = tabOf(key);
    if (have?.kind === "text") {
      activate(key);
      after?.();
      return;
    }
    if (!have) addTab(key, repoId, path);
    else patch(key, { kind: "loading", error: undefined });
    activate(key);
    await readInto(key);
    if (current === key && tabOf(key)?.kind === "text") after?.();
  };

  /** Selects the match of a search hit in its open tab. Centres the match and focuses the editor. */
  const revealHit = (o: SearchOpen): void => {
    const key = scopeId(o.repoId, o.path);
    const st = states.get(key);
    if (!st || current !== key || !view || o.hit.line > st.doc.lines) return;
    const line = st.doc.line(o.hit.line);
    const m = matchRange(line.text, o.hit.column, o.query, o);
    const anchor = line.from + m.from;
    const head = line.from + m.to;
    view.dispatch({ selection: { anchor, head }, effects: EditorView.scrollIntoView(anchor, { y: "center" }) });
    view.focus();
  };

  const openHit = (o: SearchOpen): void => {
    void openFile(o.repoId, o.path, () => revealHit(o));
  };

  /** Writes the tab to disk. If the file changed on disk, the user chooses: overwrite it, or reload it and drop the edits. */
  const saveTab = async (key: string, overwrite = false): Promise<void> => {
    const t = tabOf(key);
    const st = states.get(key);
    if (!t || !st || t.kind !== "text") return;
    if (!overwrite && !isDirty(key)) return;
    const doc = st.doc;
    const text = saveText(st);
    const name = splitPath(t.path).name;
    try {
      const version = await api.writeTextFile(t.repoId, t.path, text, overwrite ? null : t.version);
      if (!tabOf(key)) return;
      saved.set(key, doc);
      patch(key, { version, dirty: isDirty(key) });
    } catch (e) {
      const msg = errorText(e);
      if (!isStaleVersion(msg)) {
        toast({ kind: "error", title: `Could not save ${name}`, body: msg });
        return;
      }
      const choice = await openDialog(ChangedOnDisk, { name });
      if (choice === "overwrite") await saveTab(key, true);
      else if (choice === "reload") await readInto(key, lineOf(key));
    }
  };

  /** Removes a tab. The right neighbour becomes the active tab. If there is none, the left neighbour does. */
  const removeTab = (key: string): void => {
    const keys = [...order()];
    const next = closeTab(keys, key, current);
    setOrder(keys);
    if (next !== current) activate(next);
    states.delete(key);
    saved.delete(key);
    scrolls.delete(key);
    setInfos((m) => {
      const rest = { ...m };
      delete rest[key];
      return rest;
    });
  };

  /** Closes a tab. A tab with unsaved changes asks first. */
  const requestClose = async (key: string): Promise<void> => {
    const t = tabOf(key);
    if (!t) return;
    if (isDirty(key)) {
      const r = await confirmAction({
        title: `Discard changes in ${splitPath(t.path).name}?`,
        message: "The unsaved changes in this file are lost.",
        confirmLabel: "Discard",
        danger: true,
        cancelLabel: "Cancel",
      });
      if (!r) return;
    }
    removeTab(key);
  };

  /** Reads the open tabs that have no unsaved changes. A tab whose file changed shows the new text. */
  const syncOpenFiles = async (): Promise<void> => {
    const clean = untrack(tabList).filter((t) => t.kind === "text" && !isDirty(t.key));
    await Promise.all(
      clean.map(async (t) => {
        let f: TextFile;
        try {
          f = await api.readTextFile(t.repoId, t.path);
        } catch {
          return; // the file is gone or unreadable: the tab keeps its text
        }
        const now = tabOf(t.key);
        if (!now || now.kind !== "text" || isDirty(t.key) || now.version === f.version) return;
        applyRead(t.key, f, lineOf(t.key));
      }),
    );
  };

  // ---- loading the project files and their status

  const listOne = async (repoId: string): Promise<RepoData> => {
    try {
      const l = await api.listFiles(repoId);
      return { files: l.files, truncated: l.truncated };
    } catch (e) {
      return { files: [], truncated: false, error: errorText(e) };
    }
  };

  const statusOne = async (repoId: string): Promise<RepoStatus> => {
    try {
      const files = statusMap(await api.workingTree(repoId));
      return { files, folders: folderStatuses(files) };
    } catch {
      return NO_STATUS;
    }
  };

  let token = 0;
  const refreshAll = async (): Promise<void> => {
    const my = ++token;
    const repos = untrack(projectRepos);
    if (repos.length === 0) {
      setLists(new Map());
      setStatuses(new Map());
      setLoaded(true);
      return;
    }
    const [ls, sts] = await Promise.all([
      Promise.all(repos.map(async (r) => [r.id, await listOne(r.id)] as const)),
      Promise.all(repos.map(async (r) => [r.id, await statusOne(r.id)] as const)),
    ]);
    if (my !== token) return;
    setLists(new Map(ls));
    setStatuses(new Map(sts));
    setLoaded(true);
    // A project with several repos opens with its repos expanded. This happens once for each set of repos.
    const key = repos.map((r) => r.id).join(",");
    if (repos.length > 1 && key !== expandedFor) ex.set(new Set(repos.map((r) => r.id + SEP)));
    expandedFor = key;
    void syncOpenFiles();
  };

  // The lists load when the tab is shown. While the tab is shown, a repo change reloads them after a short delay.
  let shown = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    if (mainTab() !== "files") {
      // Hidden: no refresh runs. The hidden editor has no scroll position to keep.
      shown = false;
      clearTimeout(timer);
      return;
    }
    for (const r of projectRepos()) repoVersion(r.id);
    const first = !shown;
    shown = true;
    clearTimeout(timer);
    if (first) untrack(() => void refreshAll());
    else timer = setTimeout(() => void refreshAll(), REFRESH_MS);
  });
  onCleanup(() => clearTimeout(timer));

  // Close the tabs of a repo that left the project. Keep the tabs with unsaved changes.
  createEffect(
    on(
      () => projectRepos().map((r) => r.id).join(","),
      (ids) => {
        const alive = new Set(ids.split(","));
        for (const t of untrack(tabList)) if (!alive.has(t.repoId) && !isDirty(t.key)) removeTab(t.key);
      },
      { defer: true },
    ),
  );

  // ---- the tree

  const roots = createMemo<TreeNode[]>(() => {
    const repos = projectRepos();
    const data = lists();
    if (repos.length === 1) return buildTree(data.get(repos[0].id)?.files ?? [], repos[0].id);
    return repos.filter((r) => data.has(r.id)).map((r) => repoNode(r.id, r.name, data.get(r.id)?.files ?? []));
  });
  const truncated = createMemo(() => [...lists().values()].some((d) => d.truncated));
  const notices = createMemo(() => {
    const names = new Map(projectRepos().map((r): [string, string] => [r.id, r.name]));
    return [...lists()].filter(([, d]) => d.error).map(([id, d]) => `${names.get(id) ?? id}: ${d.error}`);
  });
  const quickFiles = createMemo<QuickFile[]>(() => {
    const data = lists();
    const out: QuickFile[] = [];
    for (const r of projectRepos()) for (const path of data.get(r.id)?.files ?? []) out.push({ repoId: r.id, repoName: r.name, path });
    return out;
  });

  const renderNode = (n: TreeNode, info: TreeRowInfo): JSX.Element => {
    if (n.kind === "repo") {
      return (
        <>
          <Icon name="repo" size={16} class="dg-fe-ficon" />
          <span class="dg-fe-dname is-repo" title={n.name}>
            {n.name}
          </span>
        </>
      );
    }
    if (n.kind === "dir") {
      const s = () => folderStatus(n.path, statusOf(n.repoId).folders);
      return (
        <>
          <Icon name={info.expanded ? "folderOpen" : "folder"} size={16} class="dg-fe-ficon" />
          <span class="dg-fe-dname" style={{ color: s() ? statusColorVar(s()!) : undefined }} title={n.path}>
            {n.name}
          </span>
        </>
      );
    }
    const s = () => statusOf(n.repoId).files.get(n.path) ?? null;
    return (
      <>
        <Icon name={fileIconFor(n.path)} size={16} class="dg-fe-ficon" />
        <span class="dg-fe-fname" style={{ color: s() ? statusColorVar(s()!) : undefined }} title={n.path}>
          {n.name}
        </span>
        <span class="dg-fe-grow" />
        <Show when={s()}>{(v) => <StatusLetter status={v()} />}</Show>
      </>
    );
  };

  const openNode = (n: TreeNode): void => {
    if (n.kind === "file") void openFile(n.repoId, n.path);
  };

  // A click on a file row opens the file. A key press only moves the selection. The Tree reports both as a selection.
  // The mousedown event notes the press, because the selection re-renders the row before the click.
  let pressOnRow = false;
  const releasePress = (): void => {
    // Runs after the click. The click follows the mouseup.
    setTimeout(() => (pressOnRow = false), 0);
  };
  const onTreeDown = (e: MouseEvent): void => {
    const el = e.target as Element | null;
    pressOnRow = !!el?.closest?.(".dg-tree-row") && !el.closest(".dg-tree-chev");
    if (pressOnRow) window.addEventListener("mouseup", releasePress, { once: true });
  };
  const onTreeSelect = (n: TreeNode): void => {
    setSel(n);
    if (!pressOnRow) return;
    pressOnRow = false;
    openNode(n);
  };

  const emptyTree = (): string => (projectRepos().length === 0 ? "Add a project to see its files." : "No files in this project.");

  // ---- quick open

  const pickQuick = (f: QuickFile): void => {
    setQuick(false);
    void openFile(f.repoId, f.path, () => view?.focus());
  };
  const closeQuick = (): void => {
    setQuick(false);
    if (tabOf(current ?? "")?.kind === "text") queueMicrotask(() => view?.focus());
  };

  // ---- shortcuts. They work on this tab only.

  onMount(() => {
    view = new EditorView({ parent: editorEl });
    const inFiles = () => mainTab() === "files";
    const offs = [
      register(
        "files.save",
        "Ctrl+S",
        () => {
          const k = current;
          if (!k || tabOf(k)?.kind !== "text") return false;
          void saveTab(k);
        },
        { title: "Save the file", group: "Files", when: inFiles, allowInInput: true },
      ),
      register(
        "files.quickOpen",
        "Ctrl+P",
        () => {
          if (projectRepos().length === 0) return false;
          setQuick(true);
        },
        { title: "Open a file by name", group: "Files", when: inFiles, allowInInput: true },
      ),
      register(
        "files.searchProject",
        "Ctrl+Shift+F",
        () => {
          // A single line of the editor selection becomes the query.
          let prefill: string | undefined;
          if (view && tabOf(current ?? "")?.kind === "text") {
            const m = view.state.selection.main;
            const text = m.empty ? "" : view.state.sliceDoc(m.from, m.to);
            if (text !== "" && !/[\r\n]/.test(text)) prefill = text;
          }
          setLeftTab("search");
          searchApi?.focus(prefill);
        },
        { title: "Search the project", group: "Files", when: inFiles, allowInInput: true },
      ),
      register(
        "files.find",
        "Ctrl+F",
        () => {
          if (!view || tabOf(current ?? "")?.kind !== "text") return false;
          view.focus();
          openSearchPanel(view);
        },
        { title: "Find in the file", group: "Files", when: inFiles, allowInInput: true },
      ),
    ];
    onCleanup(() => {
      offs.forEach((off) => off());
      view?.destroy();
      view = undefined;
    });
  });

  const quickKey = () => shortcutLabel("files.quickOpen") || "Ctrl+P";
  const searchKey = () => shortcutLabel("files.searchProject") || "Ctrl+Shift+F";

  return (
    <div class="dg-fe">
      <aside class="dg-fe-side" style={{ width: treeW() + "px" }} aria-label="Project files">
        <div class="dg-shell-head dg-fe-head" role="tablist" aria-label="Project files tabs">
          <button type="button" role="tab" aria-selected={leftTab() === "files"} class="dg-shell-tab" classList={{ "is-on": leftTab() === "files" }} onClick={() => setLeftTab("files")}>
            Files
          </button>
          <button type="button" role="tab" aria-selected={leftTab() === "search"} class="dg-shell-tab" classList={{ "is-on": leftTab() === "search" }} onClick={() => setLeftTab("search")}>
            Search
          </button>
          <span class="dg-grow" />
          <IconButton icon="refresh" label="Refresh the file list" onClick={() => void refreshAll()} />
          <IconButton icon="collapse" label="Collapse all" onClick={() => ex.clear()} />
        </div>
        <div class="dg-fe-pane" hidden={leftTab() !== "files"}>
          <Show when={truncated()}>
            <div class="dg-fe-notice">{TOO_MANY}</div>
          </Show>
          <For each={notices()}>{(n) => <div class="dg-fe-notice is-error">{n}</div>}</For>
          <Show when={roots().length > 0} fallback={<Show when={loaded()} fallback={<div class="dg-fe-loading"><Spinner /></div>}><div class="dg-fe-empty">{emptyTree()}</div></Show>}>
            <div class="dg-fe-tree" onMouseDown={onTreeDown}>
              <Tree<TreeNode>
                roots={roots()}
                getId={(n) => n.id}
                getChildren={(n) => (n.kind === "file" ? undefined : n.children)}
                expanded={expanded()}
                onExpandedChange={ex.set}
                selectedId={sel()?.id ?? null}
                onSelect={onTreeSelect}
                onActivate={(n) => (n.kind === "file" ? openNode(n) : ex.toggle(n.id))}
                ariaLabel="Project files"
                renderNode={renderNode}
              />
            </div>
          </Show>
        </div>
        <div class="dg-fe-pane" hidden={leftTab() !== "search"}>
          <ProjectSearch apiRef={(a) => (searchApi = a)} onOpen={openHit} />
        </div>
      </aside>
      <Splitter orientation="vertical" size={treeW()} onSize={setTreeW} min={180} max={520} defaultSize={260} persistKey={TREE_KEY} />
      <section class="dg-fe-main">
        <div class="dg-shell-head dg-fe-tabs" role="tablist" aria-label="Open files">
          <For each={tabList()}>
            {(t, i) => (
              <div
                class="dg-shell-tab dg-fe-tab"
                role="tab"
                tabindex={0}
                aria-selected={activeKey() === t.key}
                classList={{ "is-on": activeKey() === t.key, "is-dirty": t.dirty }}
                {...tip(t.path)}
                onClick={() => selectTab(t.key)}
                onMouseDown={(e) => {
                  if (e.button !== 1) return;
                  e.preventDefault();
                  void requestClose(t.key);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") selectTab(t.key);
                }}
              >
                <Icon name={fileIconFor(t.path)} size={16} />
                <span class="dg-fe-tab-name">{labels()[i()]?.name}</span>
                <Show when={labels()[i()]?.hint}>
                  <span class="dg-fe-tab-hint">{labels()[i()]?.hint}</span>
                </Show>
                <span class="dg-fe-dot" title="Unsaved changes">
                  ●
                </span>
                <IconButton
                  class="dg-fe-close"
                  icon="close"
                  label="Close tab"
                  size="small"
                  iconSize={12}
                  onClick={(e) => {
                    e.stopPropagation();
                    void requestClose(t.key);
                  }}
                />
              </div>
            )}
          </For>
        </div>
        <div class="dg-fe-body">
          <div class="dg-fe-editor" ref={(el) => (editorEl = el)} hidden={active()?.kind !== "text"} />
          <Show when={!active()}>
            <EmptyState icon="file" title="Select a file to open it">
              Press <Kbd keys={quickKey()} small /> to open a file by name, or <Kbd keys={searchKey()} small /> to search the project.
            </EmptyState>
          </Show>
          <Show when={active()?.kind === "loading"}>
            <div class="dg-fe-loading">
              <Spinner />
            </div>
          </Show>
          <Show when={active()?.kind === "binary"}>
            <EmptyState icon="fileBinary" title={BINARY} />
          </Show>
          <Show when={active()?.kind === "tooLarge"}>
            <EmptyState icon="fileBinary" title={TOO_LARGE} />
          </Show>
          <Show when={active()?.kind === "error"}>
            <EmptyState icon="error" title="Could not open the file">
              {active()?.error}
            </EmptyState>
          </Show>
        </div>
      </section>
      <Show when={quick()}>
        <QuickOpen files={quickFiles} multi={projectRepos().length > 1} onPick={pickQuick} onClose={closeQuick} />
      </Show>
    </div>
  );
}
