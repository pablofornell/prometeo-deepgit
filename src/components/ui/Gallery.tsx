/**
 * Visual catalogue of every UI primitive, for development: open `http://localhost:1420/#gallery`.
 * It doubles as a usage reference (each section is a small working example).
 */
import { For, type JSX, createSignal } from "solid-js";
import {
  AheadBehind, Avatar, Badge, Button, Checkbox, Dialog, EmptyState, Icon, IconButton, Kbd, Pill, Popup, ProgressBar, RefPills, RepoChip,
  SearchField, SegmentedControl, Select, Spinner, StatusLetter, TextField, Tree, VirtualList, createExpanded, iconNames, openContextMenu,
  openDialog, openMenu, toast, tip, type DialogComponentProps, type MenuItem,
} from "./index";

function Section(props: { title: string; children: JSX.Element }): JSX.Element {
  return (
    <section class="dg-gal-section">
      <h3>{props.title}</h3>
      <div class="dg-gal-row">{props.children}</div>
    </section>
  );
}

function DemoDialog(props: { value: string } & DialogComponentProps<string>): JSX.Element {
  const [v, setV] = createSignal(props.value);
  return (
    <Dialog
      title="New branch"
      onClose={() => props.close()}
      primary={{ label: "Create branch", disabled: !v().trim(), onClick: () => props.close(v().trim()) }}
      footerLeft={<Checkbox checked label="Check out" onChange={() => {}} />}
    >
      <TextField value={v()} onInput={setV} placeholder="Branch name" />
    </Dialog>
  );
}

const MENU: MenuItem[] = [
  { label: "Checkout", icon: "checkout", shortcut: "Enter", onSelect: () => toast({ kind: "info", title: "Checkout" }) },
  { label: "New branch from main…", icon: "newBranch", shortcut: "Ctrl+Alt+N" },
  { separator: true },
  { label: "Show tags", checked: true },
  { label: "Compare", submenu: [{ label: "With HEAD" }, { label: "With working tree" }, { label: "More", submenu: [{ label: "Deep item" }] }] },
  { label: "Merge into main", disabled: true, tooltip: "Already merged" },
  { separator: true },
  { label: "Delete", icon: "delete", danger: true, shortcut: "Delete" },
];

export function Gallery(): JSX.Element {
  const [text, setText] = createSignal("");
  const [check, setCheck] = createSignal(true);
  const [sel, setSel] = createSignal("mixed");
  const [seg, setSeg] = createSignal("sideBySide");
  const [popup, setPopup] = createSignal(false);
  const [expanded, ex] = createExpanded(["a"]);
  const [picked, setPicked] = createSignal<string | null>("a1");
  const [vsel, setVsel] = createSignal(2);
  let popBtn!: HTMLButtonElement;
  const tree = [
    { id: "a", label: "api-gateway", kids: [{ id: "a1", label: "main" }, { id: "a2", label: "feature/PAY-2318-refunds", kids: [{ id: "a21", label: "nested" }] }] },
    { id: "b", label: "ledger-service", kids: [{ id: "b1", label: "main" }] },
  ];
  type TNode = { id: string; label: string; kids?: TNode[] };
  return (
    <div class="dg-gal dg-selectable">
      <h2>DeepGit UI gallery</h2>
      <Section title="Buttons">
        <Button>Cancel</Button>
        <Button variant="primary">Commit</Button>
        <Button variant="danger">Discard 3 files</Button>
        <Button variant="ghost" icon="plus">Add</Button>
        <Button disabled>Disabled</Button>
        <Button size="small">Small</Button>
        <Button size="small" variant="primary" title="Resolve conflicts" shortcut="Ctrl+Enter">Resolve conflicts</Button>
        <IconButton icon="refresh" label="Refresh" shortcut="Ctrl+R" />
        <IconButton icon="eye" label="Highlight path" active />
        <IconButton icon="more" label="More" disabled />
        <IconButton icon="fetch" label="Fetch" size="large" iconSize={16} />
      </Section>
      <Section title="Fields">
        <TextField value={text()} onInput={setText} placeholder="Branch name" />
        <TextField value="bad name" error onInput={() => {}} />
        <SearchField size="filter" value={text()} onInput={setText} placeholder="Filter by text or hash" shortcut="Ctrl+F" />
        <Checkbox checked={check()} onChange={setCheck} label="Amend" />
        <Checkbox checked={false} indeterminate onChange={() => {}} label="Some" />
        <Checkbox checked disabled onChange={() => {}} label="Disabled" />
        <Select value={sel()} onChange={setSel} options={[{ value: "soft", label: "Soft" }, { value: "mixed", label: "Mixed" }, { value: "hard", label: "Hard" }]} />
        <SegmentedControl value={seg()} onChange={setSeg} options={[{ value: "sideBySide", label: "Side by side", icon: "sideBySide" }, { value: "unified", label: "Unified", icon: "unified" }]} />
        <SegmentedControl value="tree" onChange={() => {}} options={[{ value: "tree", icon: "tree", title: "Tree" }, { value: "list", icon: "list", title: "List" }]} />
      </Section>
      <Section title="Badges, pills, chips">
        <Badge>14</Badge><Badge tone="accent">3</Badge><Badge tone="error">2 conflicts</Badge><Pill>gone</Pill><Pill tone="head">HEAD</Pill>
        {["api-gateway", "ledger-service", "refunds-worker", "web-checkout", "shared-proto", "docs-site"].map((name) => <RepoChip name={name} />)}
        <AheadBehind ahead={3} behind={0} upstream="origin/main" /><AheadBehind ahead={0} behind={12} /><AheadBehind ahead={2} behind={1} />
        <StatusLetter status="added" /><StatusLetter status="modified" /><StatusLetter status="deleted" /><StatusLetter status="renamed" /><StatusLetter status="conflicted" /><StatusLetter status="untracked" />
      </Section>
      <Section title="Ref pills">
        <RefPills refs={[{ kind: "local", name: "feature/PAY-2318-refunds", isCurrent: true }, { kind: "remote", name: "origin/feature/PAY-2318-refunds", isCurrent: false }, { kind: "tag", name: "v2.4.0", isCurrent: false }]} />
        <RefPills refs={[{ kind: "local", name: "main", isCurrent: false }, { kind: "remote", name: "origin/main", isCurrent: false }]} />
        <RefPills refs={[{ kind: "head", name: "HEAD", isCurrent: true }, { kind: "stash", name: "stash@{0}", isCurrent: false }]} />
        <RefPills refs={[{ kind: "tag", name: "v1", isCurrent: false }, { kind: "tag", name: "v2", isCurrent: false }, { kind: "tag", name: "v3", isCurrent: false }]} />
      </Section>
      <Section title="Avatars, keys, progress">
        <Avatar name="Lucía Martín" email="lucia.martin@acme.dev" /><Avatar name="Noah Fischer" email="noah.fischer@acme.dev" /><Avatar name="Marta Kowalczyk" email="marta@acme.dev" size={32} />
        <Kbd keys="Ctrl+Shift+A" /><Kbd keys="Shift Shift" /><Kbd keys="Alt+9" small />
        <Spinner /><ProgressBar value={7} max={12} /><ProgressBar indeterminate />
      </Section>
      <Section title="Menus, dialogs, toasts, popup, tooltip">
        <Button onContextMenu={(e) => openContextMenu(e, MENU)}>Right-click me</Button>
        <Button onClick={(e) => openMenu(e.currentTarget, MENU)}>Dropdown menu</Button>
        <Button onClick={async () => toast({ kind: "info", title: "Dialog result", body: String(await openDialog(DemoDialog, { value: "feature/x" })) })}>Open dialog</Button>
        <Button ref={popBtn} onClick={() => setPopup(!popup())}>Popup</Button>
        <Popup open={popup()} anchor={() => popBtn} onClose={() => setPopup(false)}><div style={{ padding: "12px", width: "220px" }}>Anchored popup content</div></Popup>
        <Button onClick={() => toast({ kind: "success", title: "Checked out in 2 repos", body: "feature/PAY-2318-refunds in api-gateway and ledger-service. 9 repos skipped.", actions: [{ label: "Open matrix", onClick: () => {} }, { label: "Show in console", onClick: () => {} }] })}>Toast success</Button>
        <Button onClick={() => toast({ kind: "warning", title: "Conflicts in ledger-service", body: "Rebase stopped." })}>Toast warning</Button>
        <Button onClick={() => toast({ kind: "error", title: "Push rejected by origin", body: "The remote has 2 new commits. Pull, then push again.", actions: [{ label: "Show in console", onClick: () => {} }] })}>Toast error</Button>
        <span {...tip("A tooltip with a shortcut", "Ctrl+T")} style={{ padding: "4px 8px", "box-shadow": "inset 0 0 0 1px var(--dg-border)", "border-radius": "4px" }}>Hover me</span>
      </Section>
      <Section title="Tree and VirtualList (100 000 rows)">
        <div class="dg-gal-box">
          <Tree<TNode> roots={tree} getId={(n) => n.id} getChildren={(n) => n.kids} expanded={expanded()} onExpandedChange={ex.set} selectedId={picked()} onSelect={(_, id) => setPicked(id)}
            renderNode={(n, i) => (<><Icon name={i.hasChildren ? "repo" : "branch"} /><span>{n.label}</span></>)} />
        </div>
        <div class="dg-gal-box">
          <VirtualList count={100000} rowHeight={24} selectedIndex={vsel()} onSelect={setVsel}
            renderRow={(i) => <div class="dg-tree-row" classList={{ "is-selected": vsel() === i }} onClick={() => setVsel(i)} style={{ "padding-left": "8px" }}>Row {i.toLocaleString()}</div>} />
        </div>
        <div class="dg-gal-box"><EmptyState icon="log" title="Select a commit">Its message, files and diff appear here.</EmptyState></div>
      </Section>
      <Section title={`Icons (${iconNames.length})`}>
        <For each={iconNames}>{(n) => <span class="dg-gal-icon" title={n}><Icon name={n} size={16} /><small>{n}</small></span>}</For>
      </Section>
    </div>
  );
}
