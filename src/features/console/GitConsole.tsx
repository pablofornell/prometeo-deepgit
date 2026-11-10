/**
 * Git console tool window (DESIGN.md 5.18): every git command DeepGit runs, newest at the bottom.
 * Click a row to see its stdout and stderr. Background commands (status, log, ...) stay hidden unless
 * the "Show background commands" setting is on.
 */
import { For, type JSX, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import type { ConsoleEntry } from "../../api/types";
import { Button, Checkbox, EmptyState, RepoChip, SearchField, copyText } from "../../components/ui";
import { clearConsole, consoleEntries, formatCommand, isBackgroundEntry } from "../../state/console";
import { setSetting, settings } from "../../state/settings";
import { repoById } from "../../state/workspace";
import "./console.css";

/** Pixels from the bottom that still count as "at the bottom" for auto-scroll. */
const BOTTOM_SLACK = 16;
/** How long a Copy button says "Copied". */
const COPIED_MS = 1500;

/** A command failed unless git exited with 0. `null` means the process never ran (stderr holds the reason). */
const failed = (e: ConsoleEntry): boolean => e.exitCode !== 0;

/** Hides the credentials of URLs (DESIGN.md 5.18 rule 8): `https://user:token@host/x` becomes `https://***@host/x`. */
const maskUrls = (text: string): string => text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@");

/** Removes the trailing newlines git prints, so a <pre> does not end with an empty line. */
const trimEnd = (text: string): string => maskUrls(text).replace(/\n+$/, "");

/** The command line as shown and copied. */
const commandText = (e: ConsoleEntry): string => maskUrls(formatCommand(e));

const repoOf = (e: ConsoleEntry) => (e.repoId ? repoById(e.repoId) : undefined);

const exitLabel = (e: ConsoleEntry): string => (e.exitCode === null ? "did not run" : `exit ${e.exitCode}`);

const pad = (n: number): string => String(n).padStart(2, "0");

/** Local time HH:MM:SS of a command. */
function clock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Plain text of one command and its output, used by "Copy all". */
function asText(e: ConsoleEntry): string {
  const repo = repoOf(e)?.name ?? "-";
  const note = failed(e) ? ` (${exitLabel(e)})` : "";
  const head = `${clock(e.startedAt)} [${repo}] $ ${commandText(e)}${note}`;
  return [head, trimEnd(e.stdout), trimEnd(e.stderr)].filter(Boolean).join("\n");
}

/** Text filter: the command line and both outputs, case-insensitive. */
function matches(e: ConsoleEntry, q: string): boolean {
  return formatCommand(e).toLowerCase().includes(q) || e.stdout.toLowerCase().includes(q) || e.stderr.toLowerCase().includes(q);
}

export function GitConsole(): JSX.Element {
  const [query, setQuery] = createSignal("");
  const [errorsOnly, setErrorsOnly] = createSignal(false);
  const [openIds, setOpenIds] = createSignal<ReadonlySet<number>>(new Set());
  const [copiedKey, setCopiedKey] = createSignal<string | null>(null);
  let list: HTMLDivElement | undefined;
  let pinned = true;
  let copiedTimer: number | undefined;
  onCleanup(() => clearTimeout(copiedTimer));

  const visible = createMemo(() => {
    const q = query().trim().toLowerCase();
    const showBackground = settings.showBackgroundCommands;
    return consoleEntries().filter(
      (e) => (showBackground || !isBackgroundEntry(e)) && (!errorsOnly() || failed(e)) && (!q || matches(e, q)),
    );
  });

  const hiddenBackground = () => !settings.showBackgroundCommands && consoleEntries().some(isBackgroundEntry);

  // New entries keep the view on the newest command, unless the user has scrolled up.
  const onScroll = () => {
    if (list) pinned = list.scrollHeight - list.scrollTop - list.clientHeight <= BOTTOM_SLACK;
  };
  createEffect(
    on(visible, () => {
      if (list && pinned) list.scrollTop = list.scrollHeight;
    }),
  );

  const toggleOpen = (id: number) =>
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function copy(key: string, text: string): Promise<void> {
    if (!(await copyText(text))) return;
    setCopiedKey(key);
    clearTimeout(copiedTimer);
    copiedTimer = window.setTimeout(() => setCopiedKey(null), COPIED_MS);
  }

  return (
    <div class="dg-console">
      <div class="dg-console-toolbar">
        <SearchField
          size="filter"
          class="dg-console-filter"
          value={query()}
          onInput={(v) => setQuery(v)}
          placeholder="Filter by command or output"
        />
        <Checkbox
          checked={settings.showBackgroundCommands}
          onChange={(v) => setSetting("showBackgroundCommands", v)}
          label="Show background commands"
          title="Read-only commands DeepGit runs for its own state: status, log, for-each-ref..."
        />
        <Checkbox checked={errorsOnly()} onChange={(v) => setErrorsOnly(v)} label="Errors only" />
        <span class="dg-console-spacer" />
        <Button size="small" icon="delete" disabled={consoleEntries().length === 0} onClick={() => clearConsole()}>
          Clear
        </Button>
        <Button
          size="small"
          icon="copy"
          disabled={visible().length === 0}
          onClick={() => void copy("all", visible().map(asText).join("\n\n"))}
        >
          {copiedKey() === "all" ? "Copied" : "Copy all"}
        </Button>
      </div>

      <div class="dg-console-list dg-selectable" ref={list} onScroll={onScroll}>
        <Show
          when={consoleEntries().length > 0}
          fallback={
            <div class="dg-console-empty">
              <EmptyState icon="console" title="No commands yet">
                Every git command that DeepGit runs appears here.
              </EmptyState>
            </div>
          }
        >
          <Show
            when={visible().length > 0}
            fallback={
              <div class="dg-console-empty">
                <EmptyState icon="console" title="No commands match these filters">
                  {hiddenBackground()
                    ? "Background commands are hidden. Turn on Show background commands to see them."
                    : "Clear the text filter or turn off Errors only."}
                </EmptyState>
              </div>
            }
          >
            <For each={visible()}>
              {(e) => (
                <ConsoleRow
                  entry={e}
                  open={openIds().has(e.id)}
                  onToggle={() => toggleOpen(e.id)}
                  copiedKey={copiedKey()}
                  onCopy={(key, text) => void copy(key, text)}
                />
              )}
            </For>
          </Show>
        </Show>
      </div>
    </div>
  );
}

interface ConsoleRowProps {
  entry: ConsoleEntry;
  open: boolean;
  onToggle: () => void;
  copiedKey: string | null;
  onCopy: (key: string, text: string) => void;
}

/** One command: a summary line that expands to its stdout and stderr. */
function ConsoleRow(props: ConsoleRowProps): JSX.Element {
  const repo = () => repoOf(props.entry);
  const outKey = () => `${props.entry.id}:stdout`;
  const errKey = () => `${props.entry.id}:stderr`;
  return (
    <div class="dg-console-entry" classList={{ "is-error": failed(props.entry), "is-open": props.open }}>
      <button
        type="button"
        class="dg-console-row"
        aria-expanded={props.open}
        onClick={() => props.onToggle()}
      >
        <span class="dg-console-time">{clock(props.entry.startedAt)}</span>
        <span class="dg-console-repo">
          <Show when={repo()}>{(r) => <RepoChip name={r().name} />}</Show>
        </span>
        <span class="dg-console-cmd">$ {commandText(props.entry)}</span>
        <span class="dg-console-dur">{props.entry.durationMs} ms</span>
        <span class="dg-console-exit">
          {failed(props.entry) ? "✗ " : "✓ "}
          {exitLabel(props.entry)}
        </span>
      </button>

      <Show when={props.open}>
        <div class="dg-console-detail">
          <Show when={trimEnd(props.entry.stdout)}>
            <OutputBlock
              label="stdout"
              tone="stdout"
              text={trimEnd(props.entry.stdout)}
              copied={props.copiedKey === outKey()}
              onCopy={() => props.onCopy(outKey(), trimEnd(props.entry.stdout))}
            />
          </Show>
          <Show when={trimEnd(props.entry.stderr)}>
            <OutputBlock
              label="stderr"
              tone="stderr"
              text={trimEnd(props.entry.stderr)}
              copied={props.copiedKey === errKey()}
              onCopy={() => props.onCopy(errKey(), trimEnd(props.entry.stderr))}
            />
          </Show>
          <Show when={!trimEnd(props.entry.stdout) && !trimEnd(props.entry.stderr)}>
            <p class="dg-console-none">No output.</p>
          </Show>
        </div>
      </Show>
    </div>
  );
}

interface OutputBlockProps {
  label: string;
  /** stderr is progress output from git, not an error (DESIGN.md 4, Git console). */
  tone: "stdout" | "stderr";
  text: string;
  copied: boolean;
  onCopy: () => void;
}

function OutputBlock(props: OutputBlockProps): JSX.Element {
  return (
    <div class="dg-console-out">
      <div class="dg-console-out-head">
        <span>{props.label}</span>
        <Button size="small" icon="copy" onClick={() => props.onCopy()}>
          {props.copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre class={`dg-console-pre is-${props.tone}`}>{props.text}</pre>
    </div>
  );
}
