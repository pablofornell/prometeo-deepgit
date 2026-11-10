/** Sync strip (DESIGN.md 11.2): one segment per repo showing where the focused repo's current branch lives. */
import { For, type JSX, Show, createMemo } from "solid-js";
import { Icon } from "../../components/ui";
import { branchColumn, setMatrixBranch, type CellState } from "../../state/branchTable";
import { openBottomTool } from "../../state/layout";
import { focusedRepo, projectRepos, repoColor, setFocusedRepoId, summary } from "../../state/workspace";

/** Segments get a minimum width above this many repos and the strip scrolls. */
const SCROLL_ABOVE = 24;

const tipFor = (name: string, branch: string, state: CellState): string => {
  switch (state) {
    case "current": return `${name}: ${branch} is checked out`;
    case "local": return `${name}: ${branch} exists locally`;
    case "remote": return `${name}: only origin/${branch}`;
    default: return `${name}: no ${branch}`;
  }
};

export function SyncStrip(): JSX.Element {
  const branch = () => summary(focusedRepo()?.id ?? "")?.branch ?? null;
  const col = createMemo(() => branchColumn(branch()));
  const visible = () => projectRepos().length > 1 && (col()?.present ?? 0) > 1;

  const openMatrix = () => {
    setMatrixBranch(branch());
    openBottomTool("matrix");
  };

  return (
    <Show when={visible() && col()}>
      {(c) => (
        <div class="dg-sidebar-sync">
          <div class="dg-sidebar-sync-top">
            <Icon name="matrix" size={14} />
            <span class="dg-sidebar-sync-name" title={c().name}>{c().name}</span>
            <button type="button" class="dg-sidebar-sync-link" onClick={openMatrix}>Matrix</button>
          </div>
          <div class="dg-sidebar-sync-scroll">
            <div class="dg-sidebar-sync-bar" classList={{ "is-wide": projectRepos().length > SCROLL_ABOVE }} style={{ "--n": projectRepos().length }} role="list">
              <For each={projectRepos()}>
                {(r) => {
                  const state = () => c().cells[r.id]?.state ?? "missing";
                  return (
                    <button
                      type="button"
                      role="listitem"
                      class={`dg-sidebar-seg is-${state()}`}
                      style={{ "--rc": repoColor(r) }}
                      aria-label={tipFor(r.name, c().name, state())}
                      data-tip={tipFor(r.name, c().name, state())}
                      onClick={() => setFocusedRepoId(r.id)}
                    />
                  );
                }}
              </For>
            </div>
          </div>
          <div class="dg-sidebar-sync-legend">
            <span><i class="dg-sidebar-sw is-current" />{c().current} current</span>
            <Show when={c().local > 0}>
              <span><i class="dg-sidebar-sw is-local" />{c().local} local</span>
            </Show>
            <Show when={c().remoteOnly > 0}>
              <span><i class="dg-sidebar-sw is-remote" />{c().remoteOnly} on origin</span>
            </Show>
            <Show when={c().missing > 0}>
              <span><i class="dg-sidebar-sw is-missing" />{c().missing} missing</span>
            </Show>
          </div>
        </div>
      )}
    </Show>
  );
}
