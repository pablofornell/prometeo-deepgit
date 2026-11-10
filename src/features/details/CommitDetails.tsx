/**
 * "Changed files" tab of the right column (DESIGN.md 5.8, 5.9): identity, subject, body, people, parents / branches /
 * push state and the changed files (tree or list). Reads `selectedCommit()`; clicking a file or pressing Enter on it
 * opens it in the "File changes" tab. The commit actions go to the column header (`HeaderSlot name="details"`).
 */
import { type JSX, For, Match, Show, Switch, batch, createEffect, createMemo, createSignal, on, untrack } from "solid-js";
import * as api from "../../api/tauri";
import type { CommitDetails as CommitDetailsData, FileChange, RefLabel } from "../../api/types";
import {
  Avatar, Button, EmptyState, HeaderSlot, Icon, IconButton, RefPill, RepoChip, SegmentedControl, StatusLetter, Tree, copyText, createExpanded, fileIconFor,
  formatRelative, openContextMenu, openMenu, plural, shortOid, splitPath, statusColorVar, toast, type MenuItem, type TreeRowInfo,
} from "../../components/ui";
import * as actions from "../../state/actions";
import { repoVersion } from "../../state/events";
import { loadPersisted, savePersisted } from "../../state/persist";
import { refsVersion, repoRefs } from "../../state/refs";
import { followFile } from "../../state/fileFollow";
import { mainTab, selectFile, selectedCommit, selectedFile, setDetailsTab, setSelectedCommit } from "../../state/selection";
import { isMultiRepo, repoById, repoVars, summary } from "../../state/workspace";
import { committerDiffers, pushState, whenText, type PushState } from "./commitText";
import { buildFileTree, dirIds, fileId, flatFiles, totals, type DirNode, type FileNode, type TreeNode } from "./fileTree";
import { canOpenLinks, openLink } from "./links";
import { inline, parseBody, type Block, type Inline } from "./messageText";
import "./details.css";

type FileView = "tree" | "list";
type Status = "idle" | "loading" | "ready" | "error";

const MAX_BRANCH_PILLS = 4;
/** Above this many files the tree starts collapsed to the first level. */
const EXPAND_ALL_LIMIT = 150;

const [fileView, setFileViewSignal] = createSignal<FileView>(loadPersisted<FileView>("details.fileView", "tree"));
const setFileView = (v: FileView) => {
  setFileViewSignal(v);
  savePersisted("details.fileView", v);
};

async function copy(text: string, what: string): Promise<void> {
  if (await copyText(text)) toast({ kind: "success", title: `Copied ${what}`, timeout: 2000 });
}

/** Message text with `code`, URLs and issue keys styled. */
function Inlines(props: { text: string }): JSX.Element {
  return (
    <For each={inline(props.text)}>
      {(p: Inline) => {
        switch (p.t) {
          case "code":
            return <code class="dg-details-code">{p.text}</code>;
          case "issue":
            return <span class="dg-details-issue">{p.text}</span>;
          case "url":
            return canOpenLinks ? (
              <a class="dg-details-link" href={p.href} title={p.href} onClick={(e) => { e.preventDefault(); void openLink(p.href); }}>
                {p.text}
              </a>
            ) : (
              <span class="dg-details-link is-plain">{p.text}</span>
            );
          default:
            return p.text;
        }
      }}
    </For>
  );
}

function renderBlock(b: Block): JSX.Element {
  switch (b.t) {
    case "p":
      return <p><Inlines text={b.text} /></p>;
    case "list":
      return (
        <ul>
          <For each={b.items}>{(it) => <li><Inlines text={it} /></li>}</For>
        </ul>
      );
    case "code":
      return <pre class="dg-details-pre">{b.text}</pre>;
    case "trailers":
      return (
        <div class="dg-details-trailers">
          <For each={b.lines}>
            {(l) => (
              <div>
                {l.key}: <Inlines text={l.value} />
              </div>
            )}
          </For>
        </div>
      );
  }
}

function MessageBody(props: { body: string }): JSX.Element {
  const blocks = createMemo(() => parseBody(props.body));
  return (
    <Show when={blocks().length > 0}>
      <div class="dg-details-body dg-selectable">
        <For each={blocks()}>{renderBlock}</For>
      </div>
    </Show>
  );
}

function PushLine(props: { state: PushState }): JSX.Element {
  return (
    <Switch>
      <Match when={props.state.kind === "unpushed" && props.state}>
        {(s) => {
          const st = () => s() as Extract<PushState, { kind: "unpushed" }>;
          return (
            <span class="dg-details-warn">
              <Icon name="push" size={14} />
              Not on {st().remote}.{st().ahead ? ` ${plural(st().ahead as number, "commit")} to push.` : ""}
            </span>
          );
        }}
      </Match>
      <Match when={props.state.kind === "pushed" && props.state}>
        {(s) => {
          const remotes = () => (s() as Extract<PushState, { kind: "pushed" }>).remotes;
          return (
            <span class="dg-details-muted" title={remotes().join("\n")}>
              On {remotes()[0]}
              <Show when={remotes().length > 1}> and {remotes().length - 1} more</Show>
            </span>
          );
        }}
      </Match>
    </Switch>
  );
}

export function CommitDetails(): JSX.Element {
  const [details, setDetails] = createSignal<CommitDetailsData | null>(null);
  const [status, setStatus] = createSignal<Status>("idle");
  const [error, setError] = createSignal("");
  const [branches, setBranches] = createSignal<string[] | null>(null);
  const [parentSubjects, setParentSubjects] = createSignal<Record<string, string>>({});
  const [parentIdx, setParentIdx] = createSignal(0);
  const [showAllBranches, setShowAllBranches] = createSignal(false);
  const [retry, setRetry] = createSignal(0);
  const [expanded, ex] = createExpanded();
  const [dirSel, setDirSel] = createSignal<string | null>(null);

  let seq = 0;
  let branchSeq = 0;

  // ---------------------------------------------------------------- loading

  /** Branches that contain the commit: derived from refs, so it is refreshed when the repo changes. */
  const loadBranches = (repoId: string, oid: string) => {
    const mine = ++branchSeq;
    void api.branchesContaining(repoId, oid).then(
      (b) => mine === branchSeq && setBranches(b),
      () => mine === branchSeq && setBranches((old) => old ?? []),
    );
  };

  // A commit never changes: details are loaded only when the (repo, oid) key changes (or on "Try again").
  const commitKey = createMemo(() => {
    const sel = selectedCommit();
    return sel ? `${sel.repoId}:${sel.oid}` : "";
  });

  createEffect(() => {
    const key = commitKey();
    retry();
    const sel = untrack(selectedCommit);
    const mine = ++seq;
    branchSeq++;
    if (!sel) {
      batch(() => {
        setDetails(null);
        setBranches(null);
        setStatus("idle");
      });
      return;
    }
    batch(() => {
      setDetails(null);
      setBranches(null);
      setParentSubjects({});
      setParentIdx(0);
      setShowAllBranches(false);
      setDirSel(null);
      setError("");
      setStatus("loading");
    });
    api.commitDetails(sel.repoId, sel.oid).then(
      (d) => {
        if (mine !== seq || key !== commitKey()) return;
        batch(() => {
          setDetails(d);
          setStatus("ready");
        });
        loadBranches(sel.repoId, d.oid);
        for (const p of d.parents) {
          if (untrack(parentSubjects)[p] !== undefined) continue;
          void api.commitDetails(sel.repoId, p).then(
            (pd) => mine === seq && setParentSubjects((m) => ({ ...m, [p]: pd.subject })),
            () => undefined,
          );
        }
      },
      (e: unknown) => {
        if (mine !== seq) return;
        batch(() => {
          setDetails(null);
          setError(e instanceof Object && "message" in e ? String((e as { message: unknown }).message) : String(e));
          setStatus("error");
        });
      },
    );
  });

  // Repo changed (fetch, build, new branch): keep the shown details, refresh only what depends on refs. A failed load is retried.
  createEffect(
    on(
      () => {
        const sel = selectedCommit();
        return sel ? repoVersion(sel.repoId) + refsVersion(sel.repoId) : 0;
      },
      () => {
        const sel = untrack(selectedCommit);
        if (!sel) return;
        const d = untrack(details);
        if (d) loadBranches(sel.repoId, d.oid);
        else if (untrack(status) === "error") setRetry((n) => n + 1);
      },
      { defer: true },
    ),
  );

  const repo = () => {
    const s = selectedCommit();
    return s ? repoById(s.repoId) : undefined;
  };

  // ---------------------------------------------------------------- files

  const files = () => details()?.files ?? [];
  const tree = createMemo(() => buildFileTree(files()));
  const list = createMemo(() => flatFiles(files()));
  const sums = createMemo(() => totals(files()));

  // Expand folders when a new commit arrives.
  createEffect(
    on(
      () => details()?.oid,
      () => {
        const t = tree();
        ex.set(new Set(files().length <= EXPAND_ALL_LIMIT ? dirIds(t) : t.filter((n) => n.kind === "dir").map((n) => n.id)));
      },
    ),
  );

  const specFor = (d: CommitDetailsData) => ({ kind: "commit" as const, oid: d.oid, parent: parentIdx() === 0 ? null : d.parents[parentIdx()] ?? null });

  /** Selects a file; `reveal` also opens the "File changes" tab (click, Enter, menu), a keyboard move in the tree does not. */
  const openFile = (f: FileChange, reveal = true) => {
    const d = details();
    if (!d) return;
    selectFile({ repoId: d.repoId, spec: specFor(d), path: f.path, oldPath: f.oldPath ?? undefined }, { reveal });
  };

  // The commit changed while a file was open: keep it (pointed at the new commit) when the new commit changes the same
  // path, otherwise drop it and return to "Changed files". Only in the Log: Local changes files do not depend on the commit.
  createEffect(
    on(
      () => details()?.oid,
      (oid) => {
        const d = untrack(details);
        const f = untrack(selectedFile);
        if (!oid || !d || !f || untrack(mainTab) !== "log") return;
        const next = followFile(f, d, untrack(parentIdx));
        if (next === f) return;
        if (next) selectFile(next, { reveal: false });
        else {
          if (f.spec.kind === "commit") selectFile(null);
          setDetailsTab("files");
        }
      },
      { defer: true },
    ),
  );
  // The new commit could not be loaded: the old file means nothing any more.
  createEffect(
    on(status, (st) => {
      if (st !== "error" || untrack(mainTab) !== "log") return;
      if (untrack(selectedFile)?.spec.kind === "commit") selectFile(null);
      setDetailsTab("files");
    }, { defer: true }),
  );

  // The selected row follows the file in the selection store (e.g. chosen from the palette). A folder picked with the
  // arrow keys wins until another file is selected, so the keys can walk over folders.
  const selectedId = createMemo(() => {
    const dir = dirSel();
    if (dir) return dir;
    const f = selectedFile();
    const d = details();
    return f && d && f.repoId === d.repoId && f.spec.kind === "commit" && f.spec.oid === d.oid ? fileId(f.path) : null;
  });
  createEffect(on(selectedFile, () => setDirSel(null), { defer: true }));

  // Switching the parent re-opens the shown file against the new parent.
  createEffect(
    on(parentIdx, () => {
      const d = details();
      const f = selectedFile();
      if (d && f && f.repoId === d.repoId && f.spec.kind === "commit" && f.spec.oid === d.oid) {
        const change = d.files.find((x) => x.path === f.path);
        if (change) openFile(change, false);
      }
    }, { defer: true }),
  );

  const fileMenu = (f: FileChange): MenuItem[] => [
    { label: "Show file changes", icon: "sideBySide", onSelect: () => openFile(f) },
    { separator: true },
    { label: "Copy path", icon: "copy", onSelect: () => void copy(f.path, "path") },
    { label: "Copy file name", onSelect: () => void copy(splitPath(f.path).name, "file name") },
    ...(f.oldPath ? [{ label: "Copy old path", onSelect: () => void copy(f.oldPath as string, "old path") }] : []),
  ];

  // ---------------------------------------------------------------- header actions

  const commitMenu = (e: MouseEvent) => {
    const d = details();
    if (!d) return;
    const s = summary(d.repoId);
    const atHead = !!s?.headOid && s.headOid === d.oid;
    const label = `${repo()?.name ?? ""} @ ${shortOid(d.oid)}`;
    const current = s?.branch ?? "HEAD";
    openMenu(e.currentTarget as HTMLElement, [
      { label: "Copy hash", icon: "copy", onSelect: () => void copy(shortOid(d.oid), shortOid(d.oid)) },
      { label: "Copy full hash", onSelect: () => void copy(d.oid, "hash") },
      { label: "Copy subject", onSelect: () => void copy(d.subject, "subject") },
      { separator: true },
      { label: "Checkout revision", icon: "checkout", disabled: atHead, tooltip: atHead ? "HEAD is already here" : "Detached HEAD at this commit", onSelect: () => void actions.checkout(d.repoId, d.oid) },
      { label: "New branch here…", icon: "newBranch", onSelect: () => void actions.createBranch([d.repoId], d.oid, { startLabel: label }) },
      { label: "New tag here…", icon: "tag", onSelect: () => void actions.tagCreate([d.repoId], d.oid, label) },
      { separator: true },
      { label: `Revert commit ${shortOid(d.oid)}`, icon: "revert", onSelect: () => void actions.revert(d.repoId, d.oid) },
      { label: `Reset ${current} to here…`, icon: "reset", disabled: atHead, tooltip: atHead ? "HEAD is already here" : undefined, onSelect: () => void actions.reset([d.repoId], d.oid, label) },
    ]);
  };

  const parentMenu = (e: MouseEvent) => {
    const d = details();
    if (!d) return;
    openMenu(
      e.currentTarget as HTMLElement,
      d.parents.map((p, i) => ({
        label: `${i === 0 ? "First parent" : i === 1 ? "Second parent" : `Parent ${i + 1}`} (${shortOid(p)})`,
        checked: i === parentIdx(),
        onSelect: () => setParentIdx(i),
      })),
    );
  };

  // ---------------------------------------------------------------- derived display

  const refLabels = createMemo<RefLabel[]>(() => {
    const b = branches();
    const d = details();
    if (!b || !d) return [];
    const remotes = new Set(repoRefs(d.repoId)()?.remote.map((r) => r.fullName) ?? []);
    const cur = summary(d.repoId)?.branch ?? null;
    return b
      .map((name): RefLabel => (remotes.has(name) ? { kind: "remote", name, isCurrent: false } : { kind: "local", name, isCurrent: name === cur }))
      .sort((x, y) => Number(y.isCurrent) - Number(x.isCurrent));
  });

  // Tags of the shown commit come from the live refs cache (tags by peeled oid), so creating or deleting one updates the
  // pills without reloading the details. Until the refs are loaded the tags sent with the details are used.
  const tags = createMemo<RefLabel[]>(() => {
    const d = details();
    if (!d) return [];
    const refs = repoRefs(d.repoId)();
    if (!refs) return d.refs.filter((r) => r.kind === "tag");
    return refs.tags.filter((t) => t.oid === d.oid).map((t): RefLabel => ({ kind: "tag", name: t.name, isCurrent: false }));
  });

  const push = createMemo<PushState>(() => {
    const d = details();
    const b = branches();
    if (!d || !b) return { kind: "none" };
    const refs = repoRefs(d.repoId)();
    const s = summary(d.repoId);
    return pushState({
      branches: b,
      remoteBranches: new Set(refs?.remote.map((r) => r.fullName) ?? []),
      remotes: refs?.remotes.map((r) => r.name) ?? [],
      current: { branch: s?.branch ?? null, upstream: s?.upstream ?? null, ahead: s?.ahead ?? 0 },
    });
  });

  // ---------------------------------------------------------------- file rows

  const renderFileRow = (n: TreeNode, info: TreeRowInfo, flat = false): JSX.Element => {
    if (n.kind === "dir") {
      return (
        <>
          <Icon name={info.expanded ? "folderOpen" : "folder"} size={16} class="dg-details-ficon" />
          <span class="dg-details-dname" title={n.name}>{n.name}</span>
        </>
      );
    }
    const c = n.change;
    const { dir, name } = splitPath(c.path);
    return (
      <>
        <Icon name={fileIconFor(c.path)} size={16} class="dg-details-ficon" />
        <span class="dg-details-fname" classList={{ "is-del": c.status === "deleted", "is-sel": info.selected }} style={{ color: statusColorVar(c.status) }} title={c.path}>
          {name}
        </span>
        <Show when={flat && dir}>
          <span class="dg-details-fdir" title={c.path}>{dir.replace(/\/$/, "")}</span>
        </Show>
        <Show when={c.oldPath}>
          <span class="dg-details-from" title={c.oldPath ?? ""}>from {splitPath(c.oldPath ?? "").name}</span>
        </Show>
        <span class="dg-details-grow" />
        <Show when={c.binary} fallback={<>
          <Show when={(c.additions ?? 0) > 0}><span class="dg-details-n dg-details-n-add">+{c.additions}</span></Show>
          <Show when={(c.deletions ?? 0) > 0}><span class="dg-details-n dg-details-n-del">−{c.deletions}</span></Show>
        </>}>
          <span class="dg-details-from">binary</span>
        </Show>
        <StatusLetter status={c.status} />
      </>
    );
  };

  /** Click or arrow keys: the row is selected, the diff follows quietly (the click handler below opens the tab). */
  const onSelectNode = (n: TreeNode) => {
    if (n.kind === "file") {
      setDirSel(null);
      openFile(n.change, false);
    } else setDirSel(n.id);
  };
  /** Enter or double-click on a file: show its changes. */
  const onActivateNode = (n: TreeNode) => {
    if (n.kind === "file") {
      setDirSel(null);
      openFile(n.change);
    }
  };
  // A click on a file row opens "File changes"; the Tree reports clicks and arrow keys with the same callback, so the
  // click is told apart here (the row's own handler has already selected the file when this runs).
  const onFilesClick = (e: MouseEvent) => {
    const row = (e.target as Element | null)?.closest?.(".dg-tree-row");
    if (!row || (e.target as Element).closest(".dg-tree-chev") || !row.querySelector(".dg-details-fname")) return;
    if (selectedFile()?.spec.kind === "commit") setDetailsTab("diff");
  };

  // ---------------------------------------------------------------- view

  return (
    <div class="dg-details">
      <HeaderSlot name="details">
        <Show when={details()}>
          {(d) => (
            <>
              <IconButton icon="copy" label="Copy hash" shortcut="Ctrl+Shift+C" onClick={() => void copy(shortOid(d().oid), shortOid(d().oid))} />
              <IconButton icon="cherryPick" label={`Cherry-pick onto ${summary(d().repoId)?.branch ?? "HEAD"}`} onClick={() => void actions.cherryPick(d().repoId, [d().oid])} />
              <IconButton icon="more" label="More" onClick={commitMenu} />
            </>
          )}
        </Show>
      </HeaderSlot>

      <Switch>
        <Match when={!selectedCommit()}>
          <EmptyState icon="commit" title="Select a commit">Its message, files and diff appear here.</EmptyState>
        </Match>
        <Match when={status() === "error"}>
          <EmptyState
            icon="error"
            title="Could not load the commit"
            actions={<Button size="small" icon="refresh" onClick={() => setRetry(retry() + 1)}>Try again</Button>}
          >
            {error()}
          </EmptyState>
        </Match>
        <Match when={!details()}>
          <div class="dg-details-skeleton" role="status" aria-label="Loading commit">
            <div class="dg-details-skel" style={{ width: "40%" }} />
            <div class="dg-details-skel dg-details-skel-h" style={{ width: "85%" }} />
            <div class="dg-details-skel" style={{ width: "95%" }} />
            <div class="dg-details-skel" style={{ width: "70%" }} />
            <div class="dg-details-skel dg-details-skel-av" />
            <div class="dg-details-skel" style={{ width: "55%" }} />
            <div class="dg-details-skel" style={{ width: "65%" }} />
          </div>
        </Match>
        <Match when={details()}>
          {(d) => (
              <>
                <div class="dg-details-scroll">
                  <div class="dg-details-pad" classList={{ "dg-tint-strong": !!repo() && isMultiRepo() }} style={repoVars(repo())}>
                    <div class="dg-details-id">
                      <Show when={repo()}>{(r) => <RepoChip name={r().name} repo={r()} />}</Show>
                      <button type="button" class="dg-details-hash" title="Copy hash" onClick={() => void copy(shortOid(d().oid), shortOid(d().oid))}>
                        {d().oid}
                      </button>
                    </div>
                    <h2 class="dg-details-subject dg-selectable"><Inlines text={d().subject} /></h2>
                    <MessageBody body={d().body} />

                    <div class="dg-details-person">
                      <Avatar name={d().author.name} email={d().author.email} size={32} />
                      <div class="dg-details-person-text dg-selectable">
                        <div>
                          <b>{d().author.name}</b> <span class="dg-details-muted">{d().author.email}</span>
                        </div>
                        <div class="dg-details-muted" title={`Author time zone ${d().author.tz}`}>
                          Authored {whenText(d().author.time)} <span class="dg-details-faint">· {formatRelative(d().author.time)}</span>
                        </div>
                        <Show when={committerDiffers(d().author, d().committer)}>
                          <div class="dg-details-muted">
                            Committed
                            <Show when={d().committer.name !== d().author.name || d().committer.email.toLowerCase() !== d().author.email.toLowerCase()}> by {d().committer.name}</Show>{" "}
                            {whenText(d().committer.time)}
                          </div>
                        </Show>
                      </div>
                    </div>

                    <dl class="dg-details-meta">
                      <dt>{d().parents.length > 1 ? "Parents" : "Parent"}</dt>
                      <dd class="dg-details-parents">
                        <Show when={d().parents.length > 0} fallback={<span class="dg-details-muted">none (root commit)</span>}>
                          <For each={d().parents}>
                            {(p) => (
                              <span class="dg-details-parent">
                                <button type="button" class="dg-details-hashlink" title={`Select ${p}`} onClick={() => setSelectedCommit({ repoId: d().repoId, oid: p })}>
                                  {shortOid(p)}
                                </button>
                                <span class="dg-details-muted dg-details-ellipsis" title={parentSubjects()[p]}>{parentSubjects()[p] ?? ""}</span>
                              </span>
                            )}
                          </For>
                        </Show>
                      </dd>
                      <dt>Branches</dt>
                      <dd>
                        <Show when={branches()} fallback={<span class="dg-details-muted">Loading…</span>}>
                          <Show when={refLabels().length > 0} fallback={<span class="dg-details-muted">none</span>}>
                            <span class="dg-details-pills">
                              <For each={refLabels().slice(0, showAllBranches() ? refLabels().length : MAX_BRANCH_PILLS)}>{(l) => <RefPill label={l} />}</For>
                              <Show when={!showAllBranches() && refLabels().length > MAX_BRANCH_PILLS}>
                                <button type="button" class="dg-details-more" title={refLabels().slice(MAX_BRANCH_PILLS).map((l) => l.name).join("\n")} onClick={() => setShowAllBranches(true)}>
                                  +{refLabels().length - MAX_BRANCH_PILLS}
                                </button>
                              </Show>
                            </span>
                          </Show>
                        </Show>
                      </dd>
                      <Show when={tags().length > 0}>
                        <dt>Tags</dt>
                        <dd><span class="dg-details-pills"><For each={tags()}>{(l) => <RefPill label={l} />}</For></span></dd>
                      </Show>
                      <Show when={push().kind !== "none"}>
                        <dt>Push state</dt>
                        <dd><PushLine state={push()} /></dd>
                      </Show>
                    </dl>
                  </div>
                </div>

                <div class="dg-details-fhead">
                  <span class="dg-details-title">Changed files</span>
                  <span class="dg-details-count">{files().length}</span>
                  <Show when={sums().additions > 0}><span class="dg-details-n dg-details-n-add">+{sums().additions}</span></Show>
                  <Show when={sums().deletions > 0}><span class="dg-details-n dg-details-n-del">−{sums().deletions}</span></Show>
                  <span class="dg-details-grow" />
                  <SegmentedControl
                    label="File view"
                    value={fileView()}
                    onChange={setFileView}
                    options={[
                      { value: "tree", icon: "tree", title: "Tree" },
                      { value: "list", icon: "list", title: "List" },
                    ]}
                  />
                </div>

                <Show when={d().parents.length > 1}>
                  <div class="dg-details-against">
                    <span class="dg-details-muted">Changes against</span>
                    <button type="button" class="dg-details-against-btn" onClick={parentMenu}>
                      {parentIdx() === 0 ? "first parent" : parentIdx() === 1 ? "second parent" : `parent ${parentIdx() + 1}`}
                      <Icon name="chevronDown" size={12} />
                    </button>
                  </div>
                </Show>

                <div class="dg-details-files" onClick={onFilesClick}>
                  <Show when={files().length > 0} fallback={<div class="dg-details-nofiles">No files changed{d().parents.length > 1 ? " against the first parent" : ""}.</div>}>
                    <Show
                      when={fileView() === "tree"}
                      fallback={
                        <Tree<FileNode>
                          roots={list()}
                          getId={(n) => n.id}
                          getChildren={() => undefined}
                          expanded={expanded()}
                          onExpandedChange={ex.set}
                          selectedId={selectedId()}
                          onSelect={onSelectNode}
                          onActivate={onActivateNode}
                          onContextMenu={(n, e) => openContextMenu(e, fileMenu(n.change))}
                          guides={false}
                          ariaLabel="Changed files"
                          renderNode={(n, info) => renderFileRow(n, info, true)}
                        />
                      }
                    >
                      <Tree<TreeNode>
                        roots={tree()}
                        getId={(n) => n.id}
                        getChildren={(n) => (n.kind === "dir" ? (n as DirNode).children : undefined)}
                        expanded={expanded()}
                        onExpandedChange={ex.set}
                        selectedId={selectedId()}
                        onSelect={onSelectNode}
                        onActivate={(n) => (n.kind === "file" ? onActivateNode(n) : ex.toggle(n.id))}
                        onContextMenu={(n, e) => n.kind === "file" && openContextMenu(e, fileMenu(n.change))}
                        ariaLabel="Changed files"
                        renderNode={(n, info) => renderFileRow(n, info)}
                      />
                    </Show>
                  </Show>
                </div>
              </>
          )}
        </Match>
      </Switch>
    </div>
  );
}
