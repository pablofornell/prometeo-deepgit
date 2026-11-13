/** Status bar alerts (ITERATION-3.md section 6): the bell / warning / error widget and its popover. */
import { For, type JSX, Show, createEffect, createSignal, on, onCleanup } from "solid-js";
import { Button, Icon, IconButton, Popup } from "../../components/ui";
import { alerts, dismiss, dismissAll, removeExpiredAlerts } from "../../state/alerts";
import { alertBadge, alertExpiryFooter, alertLevel, describeAlerts, formatAlertTime } from "../../state/alertsCore";
import { showDialog } from "../../state/dialogs";
import { settings } from "../../state/settings";
import { activeProject } from "../../state/workspace";

export function AlertsWidget(): JSX.Element {
  let widget: HTMLButtonElement | undefined;
  let list: HTMLDivElement | undefined;
  const [open, setOpen] = createSignal(false);
  const [active, setActive] = createSignal(0);

  const level = () => alertLevel(alerts());
  const summary = () => describeAlerts(alerts(), activeProject()?.name);
  const row = (i: number) => list?.querySelectorAll<HTMLElement>(".dg-alerts-row")[i];

  const focusRow = (i: number) => {
    const n = alerts().length;
    if (n === 0) {
      queueMicrotask(() => list?.focus());
      return;
    }
    const k = Math.min(Math.max(0, i), n - 1);
    setActive(k);
    queueMicrotask(() => row(k)?.focus());
  };

  // opening: drop the expired alerts first, then put the focus on the first row. Only `open` is tracked: a change of
  // the list while the popover is open (a dismiss) must not move the active row.
  createEffect(
    on(open, (isOpen) => {
      if (!isOpen) return;
      removeExpiredAlerts();
      setActive(0);
      setTimeout(() => (row(0) ?? list)?.focus(), 0);
    }),
  );

  // Esc closes the popover (the Popup does it); the focus goes back to the widget
  createEffect(() => {
    if (!open()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTimeout(() => widget?.focus(), 0);
    };
    document.addEventListener("keydown", onKey, true);
    onCleanup(() => document.removeEventListener("keydown", onKey, true));
  });

  // the list can shrink under the cursor (dismiss, expiry): keep the active row in range
  createEffect(() => {
    const n = alerts().length;
    if (active() > Math.max(0, n - 1)) setActive(Math.max(0, n - 1));
  });

  /** Dismisses a row; the focus goes to the next row, or to the previous one when it was the last. */
  const dismissRow = (id: string, index: number) => {
    dismiss(id);
    focusRow(index);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const n = alerts().length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusRow(active() + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusRow(active() - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusRow(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusRow(n - 1);
    } else if (e.key === "Delete" && e.shiftKey) {
      e.preventDefault();
      dismissAll();
    } else if (e.key === "Delete") {
      e.preventDefault();
      const a = alerts()[active()];
      if (!a) return;
      dismissRow(a.id, active());
    }
  };

  const openSettings = (e: MouseEvent) => {
    e.preventDefault();
    setOpen(false);
    void showDialog("settings", { section: "appearance" });
  };

  return (
    <>
      <button
        type="button"
        ref={widget}
        class="dg-statusbar-widget dg-alerts-widget"
        classList={{ "is-warning": level() === "warning", "is-error": level() === "error" }}
        data-tip={summary()}
        aria-label={summary()}
        aria-haspopup="dialog"
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
      >
        <Icon name={level() === "error" ? "error" : level() === "warning" ? "warning" : "bell"} size={14} />
        <Show when={level() !== "none"}>
          <span class="dg-alerts-badge" classList={{ "is-warning": level() === "warning", "is-error": level() === "error" }}>
            {alertBadge(alerts().length)}
          </span>
        </Show>
      </button>
      <Popup open={open()} anchor={() => widget} placement="top-end" onClose={() => setOpen(false)} class="dg-alerts-pop" label="Alerts">
        <div class="dg-alerts-head">
          <span class="dg-alerts-title">Alerts · {activeProject()?.name ?? ""}</span>
          <Button variant="ghost" size="small" disabled={alerts().length === 0} onClick={() => dismissAll()}>
            Dismiss all
          </Button>
        </div>
        <div ref={list} class="dg-alerts-list" tabindex={-1} role="list" onKeyDown={onKeyDown}>
          <For each={alerts()} fallback={<div class="dg-alerts-empty">No alerts for this project.</div>}>
            {(a, i) => (
              <div
                class="dg-alerts-row"
                role="listitem"
                tabindex={i() === active() ? 0 : -1}
                onFocus={() => setActive(i())}
              >
                <Icon name={a.severity === "error" ? "error" : "warning"} size={16} class={a.severity === "error" ? "dg-alerts-icon is-error" : "dg-alerts-icon is-warning"} />
                <div class="dg-alerts-body">
                  <div class="dg-alerts-text dg-selectable">{a.text}</div>
                  <div class="dg-alerts-meta">
                    {a.repoName ? `${a.repoName} · ` : ""}
                    {formatAlertTime(a.time)}
                  </div>
                </div>
                <IconButton class="dg-alerts-dismiss" icon="close" iconSize={12} size="small" label="Dismiss" tabindex={-1} onClick={() => dismissRow(a.id, i())} />
              </div>
            )}
          </For>
        </div>
        <div class="dg-alerts-foot">
          {alertExpiryFooter(settings.alertExpiryHours)}
          <Show when={settings.alertExpiryHours > 0}>
            {" "}Change it in{" "}
            <a href="#" class="dg-alerts-link" onClick={openSettings}>Settings</a>.
          </Show>
        </div>
      </Popup>
    </>
  );
}
