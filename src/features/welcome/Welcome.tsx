/**
 * First screen when the workspace has no project (DESIGN.md 9.2, 9.3): logo, title, one line of intro,
 * the "Add project folder…" action, three feature cards and the keyboard hints. `App` shows it instead of
 * the shell.
 */
import { For, type JSX, Show, createSignal } from "solid-js";
import { pickFolder } from "../../api/dialog";
import { Button, Icon, type IconName, Kbd, Spinner, WindowControls, dragRegion } from "../../components/ui";
import { cloneRepository } from "../../state/actions";
import { addProject } from "../../state/workspace";
import "./welcome.css";

interface Feature {
  icon: IconName;
  title: string;
  body: string;
}

const FEATURES: Feature[] = [
  { icon: "repo", title: "Multi-repo projects", body: "Add one folder and DeepGit finds every repository in it, nested ones included." },
  { icon: "log", title: "Commit graph", body: "Commits from every repository in one graph, coloured by repository or by branch." },
  { icon: "console", title: "Every git command is visible", body: "The Git console lists each command DeepGit runs, with its output and exit code." },
];

/** Text of a rejection. `ApiError` carries a `message`; anything else is stringified. */
function messageOf(e: unknown): string {
  if (typeof e === "object" && e !== null && "message" in e && typeof e.message === "string") return e.message;
  return String(e);
}

/** DeepGit mark: the logo of `src-tauri/icons/logo.svg`, with its colours taken from the theme tokens. */
function Logo(): JSX.Element {
  return (
    <svg class="dg-welcome-logo" width="48" height="48" viewBox="0 0 1024 1024" aria-hidden="true">
      <rect class="dg-welcome-logo-tile" width="1024" height="1024" rx="224" ry="224" />
      <g fill="none" stroke-width="52" stroke-linecap="round" stroke-linejoin="round">
        <path class="dg-welcome-logo-main" d="M352 232 V792" stroke="currentColor" />
        <path class="dg-welcome-logo-top" d="M352 232 H540 Q672 232 672 364" stroke="currentColor" />
        <path class="dg-welcome-logo-bottom" d="M352 792 H540 Q672 792 672 660" stroke="currentColor" />
      </g>
      <g class="dg-welcome-logo-ring" stroke-width="24">
        <circle class="dg-welcome-logo-main" cx="352" cy="232" r="68" fill="currentColor" />
        <circle class="dg-welcome-logo-main" cx="352" cy="512" r="68" fill="currentColor" />
        <circle class="dg-welcome-logo-main" cx="352" cy="792" r="68" fill="currentColor" />
        <circle class="dg-welcome-logo-top" cx="672" cy="364" r="68" fill="currentColor" />
        <circle class="dg-welcome-logo-bottom" cx="672" cy="660" r="68" fill="currentColor" />
      </g>
    </svg>
  );
}

export function Welcome(): JSX.Element {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  /** Picks a folder and adds it as a project. Cancelling the picker does nothing. On success the shell replaces this screen. */
  async function addFolder(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const path = await pickFolder("Add project folder");
      if (path) await addProject(path);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="dg-welcome">
      <div class="dg-welcome-bar" {...dragRegion}>
        <WindowControls />
      </div>

      <main class="dg-welcome-main">
        <div class="dg-welcome-inner">
          <div class="dg-welcome-hero">
            <Logo />
            <h1 class="dg-welcome-title">DeepGit</h1>
            <p class="dg-welcome-tagline">Git for projects that span many repositories.</p>
          </div>

          <div class="dg-welcome-action">
            <Button variant="primary" disabled={busy()} onClick={() => void addFolder()}>
              <Show when={busy()}>
                <Spinner size={14} />
              </Show>
              Add project folder…
            </Button>
            <button type="button" class="dg-welcome-link" disabled={busy()} onClick={() => void cloneRepository()}>
              Clone repository…
            </button>
            <Show when={error()}>
              {(msg) => (
                <p class="dg-welcome-error" role="alert">
                  {msg()}
                </p>
              )}
            </Show>
          </div>

          <ul class="dg-welcome-cards">
            <For each={FEATURES}>
              {(f) => (
                <li class="dg-welcome-card">
                  <Icon name={f.icon} size={20} class="dg-welcome-card-icon" />
                  <h2 class="dg-welcome-card-title">{f.title}</h2>
                  <p class="dg-welcome-card-body">{f.body}</p>
                </li>
              )}
            </For>
          </ul>

          <p class="dg-welcome-keys">
            <span>
              <Kbd keys="Shift Shift" /> Search everywhere
            </span>
            <span>
              <Kbd keys="Ctrl+K" /> Commands
            </span>
          </p>
        </div>
      </main>
    </div>
  );
}
