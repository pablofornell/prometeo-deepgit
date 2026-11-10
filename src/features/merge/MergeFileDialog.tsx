/**
 * The merge window of one conflicted file (dialog "mergeFile"): a large modal. It loads the three versions and shows
 * the three-pane editor, or, when the file cannot be merged line by line (a side deleted it, binary, not UTF-8), the
 * choice between the two whole versions.
 */
import { type JSX, Match, Show, Suspense, Switch, createResource, lazy, onCleanup, onMount } from "solid-js";
import * as api from "../../api/tauri";
import { toApiError } from "../../api/tauri";
import type { ConflictVersions } from "../../api/types";
import { Button, type DialogComponentProps, Icon, IconButton, RepoChip, Spinner, splitPath } from "../../components/ui";
import type { MergeFileProps, MergeFileResult } from "../../state/dialogs";
import { trackOverlay } from "../../state/keymap";
import { repoById } from "../../state/workspace";
import { SideChoice } from "./SideChoice";
import "./merge.css";

/** The editor (CodeMirror, about 320 kB) is loaded the first time a merge window shows the three panes. */
const ThreeWay = lazy(() => import("./ThreeWay").then((m) => ({ default: m.ThreeWay })));

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), .cm-content';

/** True when the three panes can show the file: both sides exist and every version is UTF-8 text. */
export function canMergeAsText(v: ConflictVersions): boolean {
  return !!v.ours && !!v.theirs && !v.ours.binary && !v.theirs.binary && !v.base?.binary;
}

export function MergeFileDialog(props: MergeFileProps & DialogComponentProps<MergeFileResult>): JSX.Element {
  let box: HTMLDivElement | undefined;
  const previous = document.activeElement as HTMLElement | null;
  trackOverlay(() => true);
  const [versions, { refetch }] = createResource(() => api.conflictVersions(props.repoId, props.path));
  const repo = () => repoById(props.repoId);
  const split = () => splitPath(props.path);

  onMount(() => box?.focus());
  onCleanup(() => previous?.focus?.());

  /** Esc closes while loading or after an error; the views handle Esc themselves (they may ask first). */
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      props.close();
    } else if (e.key === "Tab" && box) {
      const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === box)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div class="dg-scrim dg-mg-scrim" onKeyDown={onKeyDown} onMouseDown={(e) => e.target === e.currentTarget && e.preventDefault()}>
      <div ref={box} class="dg-mg-window" role="dialog" aria-modal="true" aria-label={`Merge ${props.path}`} tabindex={-1}>
        <header class="dg-mg-title">
          <Icon name="conflict" size={16} class="dg-mg-title-icon" />
          <h2>
            Merge <span class="dg-mg-title-name">{split().name}</span>
          </h2>
          <span class="dg-mg-title-dir" title={props.path}>{split().dir}</span>
          <Show when={repo()}>{(r) => <RepoChip name={r().name} repo={r()} />}</Show>
          <span class="dg-grow" />
          <IconButton icon="close" label="Close" onClick={() => props.close()} />
        </header>
        <Switch>
          <Match when={versions.error}>
            <div class="dg-mg-state" role="alert">
              <Icon name="error" size={20} />
              <p>{toApiError(versions.error).message}</p>
              <div class="dg-mg-state-actions">
                <Button onClick={() => void refetch()}>Retry</Button>
                <Button onClick={() => props.close()}>Close</Button>
              </div>
            </div>
          </Match>
          <Match when={versions.loading}>
            <div class="dg-mg-state">
              <Spinner />
              <p>Loading the three versions…</p>
            </div>
          </Match>
          <Match when={versions()}>
            {(v) => (
              <Show
                when={canMergeAsText(v())}
                fallback={<SideChoice repoId={props.repoId} path={props.path} versions={v()} done={props.close} />}
              >
                <Suspense
                  fallback={
                    <div class="dg-mg-state">
                      <Spinner />
                      <p>Loading the editor…</p>
                    </div>
                  }
                >
                  <ThreeWay repoId={props.repoId} path={props.path} versions={v()} done={props.close} />
                </Suspense>
              </Show>
            )}
          </Match>
        </Switch>
      </div>
    </div>
  );
}
