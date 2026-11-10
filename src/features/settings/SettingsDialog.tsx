/**
 * The Settings dialog (JetBrains style): filter field and list of sections at the left, the page of the selected
 * section at the right. Changes apply at once; there is no OK. Pages come from `registry.ts`; every file in
 * `sections/` registers itself when this module loads.
 */
import { For, type JSX, Show, createMemo, createSignal } from "solid-js";
import { Dynamic } from "solid-js/web";
import { Button, Dialog, type DialogComponentProps, Icon, SearchField } from "../../components/ui";
import { confirmAction, type SettingsProps } from "../../state/dialogs";
import { resetSettings } from "../../state/settings";
import { filterSections, settingsSections } from "./registry";
import "./settings.css";

// One file per section: dropping a new file in `sections/` adds a page (see registry.ts).
import.meta.glob("./sections/*.tsx", { eager: true });

/** Puts every setting back to its default (core store plus every page that has its own `reset`). */
export function resetAllSettings(): void {
  resetSettings();
  for (const s of settingsSections()) s.reset?.();
}

export function SettingsDialog(props: SettingsProps & DialogComponentProps<void>): JSX.Element {
  const [query, setQuery] = createSignal("");
  const [picked, setPicked] = createSignal<string | undefined>(props.section);
  let list: HTMLDivElement | undefined;

  const visible = createMemo(() => filterSections(settingsSections(), query()));
  /** The picked section if the filter still shows it, else the first match. */
  const current = createMemo(() => visible().find((s) => s.id === picked()) ?? visible()[0]);

  const select = (id: string, focus = false) => {
    setPicked(id);
    if (focus) queueMicrotask(() => list?.querySelector<HTMLElement>(`[data-section="${id}"]`)?.focus());
  };
  const move = (delta: number, focus: boolean) => {
    const v = visible();
    if (v.length === 0) return;
    const i = Math.max(0, v.findIndex((s) => s.id === current()?.id));
    select(v[Math.min(v.length - 1, Math.max(0, i + delta))].id, focus);
  };

  const onListKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") move(e.key === "ArrowDown" ? 1 : -1, true);
    else if (e.key === "Home") move(-visible().length, true);
    else if (e.key === "End") move(visible().length, true);
    else return;
    e.preventDefault();
  };
  const onFilterKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      move(e.key === "ArrowDown" ? 1 : -1, false);
      e.preventDefault();
    } else if (e.key === "Escape" && query() !== "") {
      // first Esc clears the filter, the next one closes the dialog
      setQuery("");
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const resetAll = async () => {
    const ok = await confirmAction({
      title: "Reset all settings?",
      message: "Every setting goes back to its default value, including font size and UI scale.",
      confirmLabel: "Reset all",
      danger: true,
    });
    if (ok) resetAllSettings();
  };

  return (
    <Dialog
      title="Settings"
      width="large"
      cancelLabel="Close"
      onClose={() => props.close()}
      footerLeft={<Button variant="ghost" icon="undo" onClick={() => void resetAll()} title="Put every setting back to its default">Reset all</Button>}
    >
      <div class="dg-settings">
        <nav class="dg-settings-nav" aria-label="Settings sections">
          <SearchField
            size="filter"
            class="dg-settings-filter"
            placeholder="Filter sections"
            aria-label="Filter sections"
            value={query()}
            onInput={setQuery}
            onKeyDown={onFilterKey}
          />
          <div class="dg-settings-list" role="tablist" aria-orientation="vertical" ref={list} onKeyDown={onListKey}>
            <For each={visible()} fallback={<div class="dg-settings-empty">No section matches.</div>}>
              {(s) => (
                <button
                  type="button"
                  role="tab"
                  id={`dg-settings-tab-${s.id}`}
                  data-section={s.id}
                  class="dg-settings-item"
                  classList={{ "is-selected": s.id === current()?.id }}
                  aria-selected={s.id === current()?.id}
                  aria-controls="dg-settings-panel"
                  tabindex={s.id === current()?.id ? 0 : -1}
                  onClick={() => select(s.id)}
                >
                  <Show when={s.icon}>{(i) => <Icon name={i()} size={14} />}</Show>
                  <span class="dg-ellipsis">{s.title}</span>
                </button>
              )}
            </For>
          </div>
        </nav>
        <div class="dg-settings-page" id="dg-settings-panel" role="tabpanel" aria-labelledby={current() ? `dg-settings-tab-${current()!.id}` : undefined}>
          <Show when={current()} fallback={<div class="dg-settings-empty">Nothing to show. Try another word.</div>}>
            {(s) => (
              <>
                <header class="dg-settings-page-head">
                  <h3 class="dg-settings-page-title">{s().title}</h3>
                  <Show when={s().reset}>
                    {(reset) => (
                      <Button size="small" variant="ghost" icon="undo" onClick={() => reset()()} title={`Put the ${s().title} settings back to their defaults`}>
                        Reset to defaults
                      </Button>
                    )}
                  </Show>
                </header>
                <div class="dg-settings-page-body" tabindex={0}>
                  <Dynamic component={s().component} />
                </div>
              </>
            )}
          </Show>
        </div>
      </div>
    </Dialog>
  );
}
