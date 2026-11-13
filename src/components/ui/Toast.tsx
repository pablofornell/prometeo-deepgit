/**
 * Toasts (DESIGN.md 5.16). Mount `<ToastHost />` once (the shell does).
 *
 *   toast({ kind: "success", title: "Checked out in 2 repos", body: "feature/x in api-gateway and ledger-service.",
 *           actions: [{ label: "Show in console", onClick: () => openBottomTool("console") }] });
 *   toast({ kind: "error", title: "Push rejected by origin", body: err.detail });   // errors stay until closed
 *
 * Success and info close after 6 s (the timer pauses on hover); warning and error stay. At most 3 are
 * shown, older ones collapse into "N more notifications". Every toast is also kept in `notifications()`
 * for the Notifications tool window; `unreadCount()` drives the dot on the bell.
 * The host docks above the status bar at the bottom-left; the shell sets `--dg-toast-width`.
 * A warning or an error toast also becomes a status bar alert of the active project (`state/alerts.ts`, through
 * `setToastAlertSink`); `repoName` says which repository it is about.
 */
import { For, type JSX, Show, createSignal, onCleanup } from "solid-js";
import { Icon } from "./Icon";
import type { IconName } from "./icons";
import { IconButton } from "./Button";
import { alertText } from "../../state/alertsCore";

export type ToastKind = "success" | "info" | "warning" | "error";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  kind: ToastKind;
  /** Past-tense action and scope: "Pushed 3 commits". */
  title: string;
  /** What changed and what did not (max 3 lines). */
  body?: string;
  actions?: ToastAction[];
  /** Override auto-close in ms; 0 = never. */
  timeout?: number;
  /** Repository the toast is about; shown in the alert that a warning or an error creates. */
  repoName?: string;
}

/** What a warning or an error toast hands to the alerts. */
export interface ToastAlert {
  severity: "error" | "warning";
  text: string;
  repoName?: string;
}

export interface Notification extends ToastOptions {
  id: number;
  /** Unix ms. */
  time: number;
  read: boolean;
}

const [toasts, setToasts] = createSignal<Notification[]>([]);
const [history, setHistory] = createSignal<Notification[]>([]);
let seq = 0;

/** Notifications of this session, newest first (reactive). */
export const notifications = history;
export const unreadCount = (): number => history().filter((n) => !n.read).length;
export function markNotificationsRead(): void {
  setHistory((h) => h.map((n) => ({ ...n, read: true })));
}
export function clearNotifications(): void {
  setHistory([]);
}

let alertSink: ((a: ToastAlert) => void) | undefined;
/** `state/alerts.ts` sets this once: every warning and error toast calls it. */
export function setToastAlertSink(sink: ((a: ToastAlert) => void) | undefined): void {
  alertSink = sink;
}

/** Shows a toast and records it as a notification. Returns its id. */
export function toast(opts: ToastOptions): number {
  const n: Notification = { ...opts, id: ++seq, time: Date.now(), read: false };
  if (opts.kind === "warning" || opts.kind === "error") alertSink?.({ severity: opts.kind, text: alertText(opts.title, opts.body), repoName: opts.repoName });
  setToasts((t) => [...t, n]);
  setHistory((h) => [n, ...h].slice(0, 100));
  return n.id;
}

export function dismissToast(id: number): void {
  setToasts((t) => t.filter((x) => x.id !== id));
}

const ICON: Record<ToastKind, IconName> = { success: "check", info: "info", warning: "warning", error: "error" };
const MAX_VISIBLE = 3;

function ToastView(props: { n: Notification }): JSX.Element {
  const timeout = () => props.n.timeout ?? (props.n.kind === "success" || props.n.kind === "info" ? 6000 : 0);
  let timer = 0;
  let left = timeout();
  let startedAt = 0;
  const start = () => {
    if (left <= 0) return;
    startedAt = performance.now();
    timer = window.setTimeout(() => dismissToast(props.n.id), left);
  };
  const pause = () => {
    if (timer) {
      window.clearTimeout(timer);
      timer = 0;
      left -= performance.now() - startedAt;
    }
  };
  start();
  onCleanup(() => window.clearTimeout(timer));
  return (
    <div class={`dg-toast dg-toast-${props.n.kind}`} role={props.n.kind === "error" ? "alert" : "status"} onMouseEnter={pause} onMouseLeave={start}>
      <div class="dg-toast-head">
        <Icon name={ICON[props.n.kind]} class="dg-toast-icon" />
        <b class="dg-toast-title">{props.n.title}</b>
        <IconButton icon="close" label="Close" size="small" iconSize={12} onClick={() => dismissToast(props.n.id)} />
      </div>
      <Show when={props.n.body}>
        <div class="dg-toast-body dg-selectable">{props.n.body}</div>
      </Show>
      <Show when={props.n.actions?.length}>
        <div class="dg-toast-actions">
          <For each={props.n.actions}>
            {(a) => (
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  dismissToast(props.n.id);
                  a.onClick();
                }}
              >
                {a.label}
              </a>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

export function ToastHost(): JSX.Element {
  const visible = () => toasts().slice(-MAX_VISIBLE);
  const hidden = () => Math.max(0, toasts().length - MAX_VISIBLE);
  return (
    <div class="dg-toast-host" aria-live="polite">
      <Show when={hidden() > 0}>
        <div class="dg-toast-more">{hidden()} more notification{hidden() === 1 ? "" : "s"}</div>
      </Show>
      <For each={visible()}>{(n) => <ToastView n={n} />}</For>
    </div>
  );
}
