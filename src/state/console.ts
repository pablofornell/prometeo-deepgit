/**
 * Git console data: a ring buffer of the last 500 `ConsoleEntry` and the last user-initiated one
 * (for the status bar ticker, DESIGN.md 11.3).
 *
 *   <For each={consoleEntries()}>{(e) => <Line entry={e} />}</For>
 *   const last = lastUserEntry();
 */
import { createSignal } from "solid-js";
import type { ConsoleEntry } from "../api/types";

export const CONSOLE_CAPACITY = 500;

const [entries, setEntries] = createSignal<readonly ConsoleEntry[]>([]);
const [lastEntry, setLastEntry] = createSignal<ConsoleEntry | null>(null);
const [lastUser, setLastUser] = createSignal<ConsoleEntry | null>(null);

/** Global options that take their value as the next argument (`-C dir`, `-c k=v`, `--git-dir path`). */
const GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path"]);

/** Commands that always change something; everything not listed here and not handled below is a background read. */
const WRITE = new Set(["commit", "checkout", "switch", "merge", "rebase", "cherry-pick", "revert", "reset", "fetch", "pull", "push", "add", "restore", "rm", "mv", "clean", "clone"]);
const STASH_WRITE = new Set(["push", "save", "pop", "apply", "drop", "clear", "branch", "create", "store"]);
const SUBMODULE_WRITE = new Set(["update", "init", "sync", "add", "deinit", "set-url", "set-branch", "absorbgitdirs"]);
const REMOTE_WRITE = new Set(["add", "remove", "rm", "rename", "set-url", "set-head", "set-branches", "prune", "update"]);

/** Splits `args` into the subcommand and its arguments, skipping global options (`--no-pager`, `-c x=y`, `-C dir`...). */
export function splitGitArgs(args: readonly string[]): { sub: string; rest: string[] } {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) i += GLOBAL_WITH_VALUE.has(args[i]) ? 2 : 1;
  return { sub: args[i] ?? "", rest: args.slice(i + 1) };
}

const positional = (rest: readonly string[]): string[] => {
  const dd = rest.indexOf("--");
  const head = dd < 0 ? rest : rest.slice(0, dd);
  return [...head.filter((a) => !a.startsWith("-")), ...(dd < 0 ? [] : rest.slice(dd + 1))];
};
const has = (rest: readonly string[], ...flags: string[]): boolean => rest.some((a) => flags.some((f) => a === f || a.startsWith(f + "=")));

/** True when `git <args>` changes the repository (or the remote): what the user clicked, shown in the status bar. */
function isWrite(sub: string, rest: readonly string[]): boolean {
  if (WRITE.has(sub)) return true;
  switch (sub) {
    case "apply":
      return !has(rest, "--check");
    case "tag":
      if (has(rest, "-d", "--delete", "-a", "-s", "-f", "--force", "-m", "-F", "-u")) return true;
      if (has(rest, "-l", "--list", "--contains", "--no-contains", "--points-at", "--merged", "--no-merged")) return false;
      return positional(rest).length > 0;
    case "branch":
      if (rest.some((a) => /^-[^-]*[dDmMcCu]/.test(a)) || has(rest, "--delete", "--move", "--copy", "--set-upstream-to", "--unset-upstream", "--force", "--track", "--no-track")) return true;
      if (has(rest, "-l", "--list", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--show-current")) return false;
      return positional(rest).length > 0;
    case "stash": {
      const action = positional(rest)[0];
      return action === undefined || STASH_WRITE.has(action);
    }
    case "submodule":
      return SUBMODULE_WRITE.has(positional(rest)[0] ?? "");
    case "remote":
      return REMOTE_WRITE.has(positional(rest)[0] ?? "");
    default:
      return false;
  }
}

/**
 * True for commands the app runs by itself (reads: status, log, diff, stash list..., the auto-fetch), not the result of a
 * click. The auto-fetch is exactly the entries the backend tagged `background` (a fetch run with the silent auth mode),
 * so a fetch the user starts is never hidden, whatever else is running.
 */
export function isBackgroundEntry(e: ConsoleEntry): boolean {
  if (e.background) return true;
  const { sub, rest } = splitGitArgs(e.args);
  return !isWrite(sub, rest);
}

/** Appends an entry (called by `events.ts`). Keeps the newest 500. */
export function pushConsoleEntry(e: ConsoleEntry): void {
  setEntries((prev) => (prev.length >= CONSOLE_CAPACITY ? [...prev.slice(prev.length - CONSOLE_CAPACITY + 1), e] : [...prev, e]));
  setLastEntry(e);
  if (!isBackgroundEntry(e)) setLastUser(e);
}

/** All buffered entries, oldest first (reactive). */
export const consoleEntries = entries;
/** The newest entry of any kind (reactive). */
export const lastConsoleEntry = lastEntry;
/** The newest user-initiated entry: what the status bar ticker shows (reactive). */
export const lastUserEntry = lastUser;

export function clearConsole(): void {
  setEntries([]);
  setLastEntry(null);
  setLastUser(null);
}

/** `git <args>` as one copy-pasteable line (arguments with spaces are quoted). */
export function formatCommand(e: ConsoleEntry): string {
  return "git " + e.args.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(" ");
}
