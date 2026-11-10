/** Small form parts shared by the dialogs. Styled in `dialogs.css` (prefix `dg-dialogs-`). */
import { type JSX, For, Show } from "solid-js";
import { Checkbox, Icon, RepoSquare } from "../../components/ui";
import type { IconName } from "../../components/ui";
import { repoById } from "../../state/workspace";
import "./dialogs.css";

/** Repo names in the order of the ids; unknown ids are skipped. */
export const repoNames = (ids: readonly string[]): string[] => ids.map((id) => repoById(id)?.name).filter((n): n is string => !!n);

/** Label above a control, with an optional error line below it. */
export function Field(props: { label: string; error?: string | null; hint?: string; children: JSX.Element }): JSX.Element {
  return (
    <div class="dg-dialogs-field">
      <span class="dg-dialogs-label">{props.label}</span>
      {props.children}
      <Show when={props.error}>{(e) => <span class="dg-dialogs-error" role="alert">{e()}</span>}</Show>
      <Show when={!props.error && props.hint}>{(h) => <span class="dg-dialogs-hint">{h()}</span>}</Show>
    </div>
  );
}

/** Read-only value shown as a flat box (start point, target, source). */
export function ReadOnly(props: { icon?: IconName; mono?: boolean; children: JSX.Element }): JSX.Element {
  return (
    <div class="dg-dialogs-value" classList={{ "is-mono": props.mono }}>
      <Show when={props.icon}>{(i) => <Icon name={i()} size={14} />}</Show>
      <span class="dg-dialogs-value-text">{props.children}</span>
    </div>
  );
}

/** Inline message with an icon: info, warning or error (the banner colours). */
export function Note(props: { kind: "info" | "warning" | "error"; children: JSX.Element }): JSX.Element {
  const icon = (): IconName => (props.kind === "error" ? "error" : props.kind === "warning" ? "warning" : "info");
  return (
    <div class={`dg-dialogs-note is-${props.kind}`} role={props.kind === "info" ? undefined : "alert"}>
      <Icon name={icon()} size={14} />
      <span>{props.children}</span>
    </div>
  );
}

/** Multi-line text input in the look of `TextField`. */
export function TextArea(props: { value: string; onInput: (v: string) => void; placeholder?: string; rows?: number; ariaLabel?: string; disabled?: boolean }): JSX.Element {
  return (
    <textarea
      class="dg-dialogs-textarea"
      rows={props.rows ?? 3}
      value={props.value}
      placeholder={props.placeholder}
      aria-label={props.ariaLabel}
      disabled={props.disabled}
      spellcheck={false}
      onInput={(e) => props.onInput(e.currentTarget.value)}
    />
  );
}

export interface RadioOption<T extends string> {
  value: T;
  label: string;
  description?: string;
  /** Red label: the option destroys data. */
  danger?: boolean;
}

/** Radio list with a description under each label. Arrow keys move the choice (native radios). */
export function RadioGroup<T extends string>(props: { name: string; value: T; onChange: (v: T) => void; options: RadioOption<T>[]; label: string }): JSX.Element {
  return (
    <div class="dg-dialogs-radios" role="radiogroup" aria-label={props.label}>
      <For each={props.options}>
        {(o) => (
          <label class="dg-dialogs-radio" classList={{ "is-on": props.value === o.value, "is-danger": o.danger }}>
            <input class="dg-dialogs-radio-input" type="radio" name={props.name} value={o.value} checked={props.value === o.value} onChange={() => props.onChange(o.value)} />
            <span class="dg-dialogs-radio-dot" aria-hidden="true" />
            <span class="dg-dialogs-radio-text">
              <span class="dg-dialogs-radio-label">{o.label}</span>
              <Show when={o.description}>{(d) => <span class="dg-dialogs-radio-desc">{d()}</span>}</Show>
            </span>
          </label>
        )}
      </For>
    </div>
  );
}

/** Repo checklist with "All" and "None" links (new branch in several repos). */
export function RepoChecklist(props: { repoIds: string[]; picked: string[]; onChange: (ids: string[]) => void; detail?: (repoId: string) => string | undefined }): JSX.Element {
  const toggle = (id: string, on: boolean) => props.onChange(props.repoIds.filter((x) => (x === id ? on : props.picked.includes(x))));
  return (
    <div class="dg-dialogs-field">
      <div class="dg-dialogs-label-row">
        <span class="dg-dialogs-label">Repositories ({props.picked.length} of {props.repoIds.length})</span>
        <span class="dg-dialogs-links">
          <button type="button" class="dg-dialogs-link" onClick={() => props.onChange([...props.repoIds])}>All</button>
          <button type="button" class="dg-dialogs-link" onClick={() => props.onChange([])}>None</button>
        </span>
      </div>
      <div class="dg-dialogs-checklist">
        <For each={props.repoIds}>
          {(id) => {
            const repo = () => repoById(id);
            return (
              <Show when={repo()}>
                {(r) => (
                  <Checkbox
                    checked={props.picked.includes(id)}
                    onChange={(on) => toggle(id, on)}
                    label={
                      <span class="dg-dialogs-repo">
                        <RepoSquare repo={r()} />
                        <span class="dg-dialogs-repo-name">{r().name}</span>
                        <Show when={props.detail?.(id)}>{(d) => <span class="dg-dialogs-repo-detail">{d()}</span>}</Show>
                      </span>
                    }
                  />
                )}
              </Show>
            );
          }}
        </For>
      </div>
    </div>
  );
}

/** A read-only list of repos with a detail text (push, stash). */
export function RepoRows(props: { rows: { repoId: string; detail: JSX.Element; trailing?: JSX.Element }[] }): JSX.Element {
  return (
    <div class="dg-dialogs-rows">
      <For each={props.rows}>
        {(row) => (
          <Show when={repoById(row.repoId)}>
            {(r) => (
              <div class="dg-dialogs-row">
                <RepoSquare repo={r()} />
                <span class="dg-dialogs-repo-name">{r().name}</span>
                <span class="dg-dialogs-row-detail">{row.detail}</span>
                <Show when={row.trailing}>{(t) => <span class="dg-dialogs-row-trailing">{t()}</span>}</Show>
              </div>
            )}
          </Show>
        )}
      </For>
    </div>
  );
}
