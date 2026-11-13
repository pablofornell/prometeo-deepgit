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
  { icon: "log", title: "Commit graph", body: "Commits from every repository in one graph, each branch in its own colour." },
  { icon: "console", title: "Every git command is visible", body: "The Git console lists each command DeepGit runs, with its output and exit code." },
];

/** Text of a rejection. `ApiError` carries a `message`; anything else is stringified. */
function messageOf(e: unknown): string {
  if (typeof e === "object" && e !== null && "message" in e && typeof e.message === "string") return e.message;
  return String(e);
}

/** Colour of a part of the mark, as a theme token name: `--dg-<name>`. */
type LogoColour = "accent" | "lane-1" | "lane-2" | "lane-5" | "lane-7";

/** Edges of the mark: path, stroke width, colour. Same numbers as the small variant of `scripts/gen-logo.mjs`. */
const LOGO_EDGES: [d: string, width: number, colour: LogoColour][] = [
  ["M512 880 V640", 96, "accent"],
  ["M512 640 C512 550 434.7 564.6 383.1 514.3", 72, "lane-1"],
  ["M512 640 C512 550 589.3 564.6 640.9 514.3", 72, "lane-2"],
  ["M383.1 514.3 C329 461.5 289.1 552.5 232.7 530.4", 56, "lane-5"],
  ["M383.1 514.3 C329 461.5 419 419.3 395.5 363.6", 56, "lane-1"],
  ["M640.9 514.3 C695 461.5 605 419.3 628.5 363.6", 56, "lane-2"],
  ["M640.9 514.3 C695 461.5 734.9 552.5 791.3 530.4", 56, "lane-7"],
  ["M232.7 530.4 C180.2 509.8 172.4 580.1 127.9 572.3", 44, "lane-5"],
  ["M232.7 530.4 C180.2 509.8 222.3 452.9 184.4 428.4", 44, "lane-5"],
  ["M395.5 363.6 C373.5 311.6 317.7 355.1 292.3 317.8", 44, "lane-1"],
  ["M395.5 363.6 C373.5 311.6 443.7 302 434.7 257.7", 44, "lane-1"],
  ["M628.5 363.6 C650.5 311.6 580.3 302 589.3 257.7", 44, "lane-2"],
  ["M628.5 363.6 C650.5 311.6 706.3 355.1 731.7 317.8", 44, "lane-2"],
  ["M791.3 530.4 C843.8 509.8 801.7 452.9 839.6 428.4", 44, "lane-7"],
  ["M791.3 530.4 C843.8 509.8 851.6 580.1 896.1 572.3", 44, "lane-7"],
];

/** Nodes of the mark: centre, radius, outline width, colour. Same numbers as the small variant of `scripts/gen-logo.mjs`. */
const LOGO_NODES: [x: number, y: number, r: number, outline: number, colour: LogoColour][] = [
  [512, 880, 92, 28, "accent"],
  [512, 640, 92, 28, "accent"],
  [383.1, 514.3, 66, 20, "lane-1"],
  [640.9, 514.3, 66, 20, "lane-2"],
  [232.7, 530.4, 54, 16, "lane-5"],
  [395.5, 363.6, 54, 16, "lane-1"],
  [628.5, 363.6, 54, 16, "lane-2"],
  [791.3, 530.4, 54, 16, "lane-7"],
  [127.9, 572.3, 46, 14, "lane-5"],
  [184.4, 428.4, 46, 14, "lane-5"],
  [292.3, 317.8, 46, 14, "lane-1"],
  [434.7, 257.7, 46, 14, "lane-1"],
  [589.3, 257.7, 46, 14, "lane-2"],
  [731.7, 317.8, 46, 14, "lane-2"],
  [839.6, 428.4, 46, 14, "lane-7"],
  [896.1, 572.3, 46, 14, "lane-7"],
];

/** DeepGit mark: the small variant of `src-tauri/icons/logo-small.svg`, with its colours taken from the theme tokens. */
function Logo(): JSX.Element {
  return (
    <svg class="dg-welcome-logo" width="48" height="48" viewBox="0 0 1024 1024" aria-hidden="true">
      <rect class="dg-welcome-logo-tile" width="1024" height="1024" rx="224" ry="224" />
      <g fill="none" stroke-linecap="round">
        <For each={LOGO_EDGES}>
          {([d, width, colour]) => (
            <path d={d} stroke-width={width} stroke="currentColor" style={{ color: `var(--dg-${colour})` }} />
          )}
        </For>
      </g>
      <g class="dg-welcome-logo-ring">
        <For each={LOGO_NODES}>
          {([x, y, r, outline, colour]) => (
            <circle cx={x} cy={y} r={r} stroke-width={outline} fill="currentColor" style={{ color: `var(--dg-${colour})` }} />
          )}
        </For>
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
