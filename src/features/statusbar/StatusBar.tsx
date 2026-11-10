/** Status bar (DESIGN.md 5.19): command ticker (11.3), progress area (5.17), focused repo, branch, fetch age, theme. */
import { For, type JSX, Show, createMemo, createSignal } from "solid-js";
import { AheadBehind, Icon, Popup, ProgressBar, RepoIcon, Spinner, THEME_ICONS } from "../../components/ui";
import * as actions from "../../state/actions";
import { activities } from "../../state/activity";
import { autoFetchLine, autoFetchStatus } from "../../state/autoFetch";
import { consoleEntries, formatCommand, isBackgroundEntry, lastUserEntry } from "../../state/console";
import { fetchAge } from "../../state/fetchAge";
import { openBottomTool, setSidebarVisible } from "../../state/layout";
import { runBinding } from "../../state/keymap";
import { resolvedTheme, settings, toggleTheme } from "../../state/settings";
import { focusedRepo, repoById, summary } from "../../state/workspace";
import { middleTruncate } from "./format";
import "./statusbar.css";

/** The ticker shows at most this many characters of the command; the middle is cut. */
const MAX_COMMAND_CHARS = 72;
/** Entries of one multi-repo command start within this window. */
const SAME_BATCH_MS = 10_000;

export function StatusBar(): JSX.Element {
  let progressBtn: HTMLButtonElement | undefined;
  const [progressOpen, setProgressOpen] = createSignal(false);

  /** How many repos ran the same command as the last user entry just before it ("× 12"). */
  const batchSize = createMemo(() => {
    const last = lastUserEntry();
    if (!last) return 1;
    const key = last.args.join(" ");
    let repos = 0;
    const seen = new Set<string | null>();
    for (const e of consoleEntries()) {
      if (isBackgroundEntry(e) || e.args.join(" ") !== key || Math.abs(e.startedAt - last.startedAt) > SAME_BATCH_MS) continue;
      if (!seen.has(e.repoId)) repos++;
      seen.add(e.repoId);
    }
    return repos;
  });

  const repo = () => focusedRepo();
  const s = () => (repo() ? summary(repo()!.id) : undefined);
  const branchText = () => s()?.branch ?? (s()?.headOid ? s()!.headOid!.slice(0, 7) : "no branch");
  const age = fetchAge;
  const first = () => activities()[0];

  return (
    <div class="dg-statusbar">
      <Show when={lastUserEntry()}>
        {(e) => {
          const failed = () => e().exitCode !== null && e().exitCode !== 0;
          const owner = () => (e().repoId ? repoById(e().repoId!) : undefined);
          return (
            <button
              type="button"
              class="dg-statusbar-widget dg-statusbar-ticker"
              data-tip={formatCommand(e())}
              aria-label={`Last command: ${formatCommand(e())}. Open the Git console`}
              onClick={() => openBottomTool("console")}
            >
              <Show when={e().exitCode !== null} fallback={<Spinner size={14} />}>
                <Icon name={failed() ? "error" : "check"} size={14} class={failed() ? "dg-statusbar-bad" : "dg-statusbar-ok"} />
              </Show>
              <span class="dg-statusbar-cmd">
                <Show when={batchSize() < 2 && owner()}>
                  {(o) => <span class="dg-statusbar-cmd-repo">{o().name}</span>}
                </Show>
                {middleTruncate(formatCommand(e()), MAX_COMMAND_CHARS)}
                <Show when={batchSize() > 1}> × {batchSize()}</Show>
              </span>
              <Show when={e().exitCode !== null}>
                <span class="dg-statusbar-dim">{(e().durationMs / 1000).toFixed(1)} s</span>
              </Show>
            </button>
          );
        }}
      </Show>

      <Show when={first()}>
        {(a) => (
          <>
            <button type="button" ref={progressBtn} class="dg-statusbar-widget dg-statusbar-progress" aria-label="Show running operations" onClick={() => setProgressOpen(!progressOpen())}>
              <span class="dg-statusbar-plabel">{a().label}</span>
              <ProgressBar value={a().done} max={Math.max(1, a().total)} />
              <span class="dg-statusbar-dim">{a().done} / {a().total}</span>
              <Show when={activities().length > 1}>
                <span class="dg-statusbar-dim">+{activities().length - 1}</span>
              </Show>
            </button>
            <Popup open={progressOpen()} anchor={() => progressBtn} placement="top-start" onClose={() => setProgressOpen(false)} class="dg-statusbar-pop" label="Running operations">
              <For each={activities()}>
                {(x) => (
                  <div class="dg-statusbar-pop-row">
                    <span class="dg-statusbar-pop-label">{x.label}</span>
                    <ProgressBar value={x.done} max={Math.max(1, x.total)} width={120} />
                    <span class="dg-statusbar-dim">{x.done} / {x.total}</span>
                  </div>
                )}
              </For>
            </Popup>
          </>
        )}
      </Show>

      <span class="dg-statusbar-fill" />

      <Show when={repo()}>
        {(r) => (
          <>
            <button
              type="button"
              class="dg-statusbar-widget dg-statusbar-shrink"
              data-tip={`${r().name}\n${r().path}\nFocused repository: show it in the sidebar`}
              onClick={() => {
                setSidebarVisible(true);
              }}
            >
              <RepoIcon size={12} />
              <span class="dg-statusbar-name">{r().name}</span>
            </button>
            <button type="button" class="dg-statusbar-widget dg-statusbar-shrink" data-tip={s()?.branch ? `Branches (on ${s()!.branch})` : "Branches"} data-tip-shortcut="Ctrl+Shift+`" onClick={() => runBinding("branch.popup")}>
              <Icon name={s() && !s()!.branch ? "detachedHead" : "branch"} size={14} />
              <span class="dg-statusbar-branch">{branchText()}</span>
              <AheadBehind ahead={s()?.ahead ?? 0} behind={s()?.behind ?? 0} upstream={s()?.upstream} />
            </button>
          </>
        )}
      </Show>
      <Show when={autoFetchStatus().failing.length > 0}>
        <button
          type="button"
          class="dg-statusbar-widget dg-statusbar-autofetch"
          data-tip={`${autoFetchLine()}\nIt tries again later. Open the Git console to see the command.`}
          aria-label={autoFetchLine()}
          onClick={() => openBottomTool("console")}
        >
          <Icon name="warning" size={14} class="dg-statusbar-bad" />
        </button>
      </Show>
      <button
        type="button"
        class="dg-statusbar-widget dg-statusbar-fetch"
        classList={{ [`is-${age().level}`]: true }}
        style={{ "--dg-statusbar-age": `${age().fraction * 360}deg` }}
        data-tip={`${age().tooltip} ${autoFetchLine()}\nClick to fetch all repositories`}
        onClick={() => void actions.fetchAll()}
      >
        <span class="dg-statusbar-age" />
        {age().text}
      </button>
      <button
        type="button"
        class="dg-statusbar-widget"
        data-tip={`${settings.theme === "system" ? `Theme follows the system (${resolvedTheme()})` : `${resolvedTheme() === "dark" ? "Dark" : "Light"} theme`}\nClick to switch to ${resolvedTheme() === "dark" ? "light" : "dark"}`}
        onClick={toggleTheme}
      >
        <Icon name={THEME_ICONS[settings.theme]} />
        {resolvedTheme() === "dark" ? "Dark" : "Light"}
      </button>
    </div>
  );
}
