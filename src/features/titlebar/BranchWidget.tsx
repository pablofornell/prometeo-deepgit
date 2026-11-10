/** Branch widget (DESIGN.md 5.1 #3): the current branch of the project and the popup that switches it. Ctrl+Shift+`. */
import { type JSX, Show, createMemo, createSignal, onCleanup } from "solid-js";
import { AheadBehind, Icon } from "../../components/ui";
import { register } from "../../state/keymap";
import { focusedRepo, projectRepos, summary } from "../../state/workspace";
import { BranchPopup } from "./BranchPopup";

interface WidgetInfo {
  /** Branch name, short hash for a detached HEAD, or "N branches". */
  name: string;
  /** Secondary text ("3 of 12 repos"); empty for a single repo. */
  sub: string;
  detached: boolean;
  /** Single repo: upstream state. */
  ahead: number;
  behind: number;
  upstream: string | null;
}

/** The branch shown by the widget: single repo = its branch; several = the branch most repos have checked out. */
function describe(): WidgetInfo {
  const repos = projectRepos();
  if (repos.length <= 1) {
    const s = repos[0] ? summary(repos[0].id) : undefined;
    return { name: s?.branch ?? (s?.headOid ? s.headOid.slice(0, 7) : "no branch"), sub: "", detached: !!s && !s.branch, ahead: s?.ahead ?? 0, behind: s?.behind ?? 0, upstream: s?.upstream ?? null };
  }
  const counts = new Map<string, number>();
  for (const r of repos) {
    const b = summary(r.id)?.branch;
    if (b) counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  const preferred = summary(focusedRepo()?.id ?? "")?.branch ?? null;
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] === preferred ? -1 : b[0] === preferred ? 1 : a[0].localeCompare(b[0])));
  const top = ranked[0];
  const none = { ahead: 0, behind: 0, upstream: null, detached: false };
  if (!top) return { name: "no branch", sub: "", ...none };
  if (top[1] < 2) return { name: `${ranked.length} branches`, sub: `${repos.length} repos`, ...none };
  return { name: top[0], sub: top[1] === repos.length ? `all ${repos.length} repos` : `${top[1]} of ${repos.length} repos`, ...none };
}

export function BranchWidget(): JSX.Element {
  let button: HTMLButtonElement | undefined;
  const [open, setOpen] = createSignal(false);
  const info = createMemo(describe);

  const offs = [register("branch.popup", "Ctrl+Shift+`", () => setOpen(!open()), { title: "Branches", group: "Global", when: () => projectRepos().length > 0, allowInOverlay: true })];
  onCleanup(() => offs.forEach((off) => off()));

  return (
    <>
      <button
        type="button"
        ref={button}
        class="dg-titlebar-dd dg-titlebar-branch"
        classList={{ "is-open": open() }}
        aria-haspopup="dialog"
        aria-expanded={open()}
        data-tip="Branches"
        data-tip-shortcut="Ctrl+Shift+`"
        onClick={() => setOpen(!open())}
      >
        <Icon name={info().detached ? "detachedHead" : "branch"} />
        <span class="dg-titlebar-dd-main" classList={{ "is-mono": info().detached }}>{info().name}</span>
        <Show when={info().sub}>
          <span class="dg-titlebar-dd-sub">{info().sub}</span>
        </Show>
        <AheadBehind ahead={info().ahead} behind={info().behind} upstream={info().upstream} />
        <Icon name="chevronDown" size={14} class="dg-titlebar-chev" />
      </button>
      <BranchPopup open={open()} anchor={() => button} onClose={() => setOpen(false)} />
    </>
  );
}
