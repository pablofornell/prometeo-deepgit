/**
 * In-place rename of the project in the sidebar card: Enter saves, Esc cancels, leaving the field saves when the name
 * is valid (else cancels). The error under the field uses the backend's rules (`projectNameError`).
 */
import { type JSX, Show, createSignal, onMount } from "solid-js";
import { toApiError } from "../../api/tauri";
import { TextField, toast } from "../../components/ui";
import { projectNameError, renameProject } from "../../state/workspace";

export function ProjectNameEditor(props: { projectId: string; name: string; onDone: (renamed: boolean) => void }): JSX.Element {
  const [value, setValue] = createSignal(props.name);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const error = () => saveError() ?? projectNameError(props.projectId, value());
  let input: HTMLInputElement | undefined;
  let finished = false;

  onMount(() => {
    input?.focus();
    input?.select();
  });

  const finish = (renamed: boolean) => {
    if (finished) return;
    finished = true;
    props.onDone(renamed);
  };

  const save = async (leaving: boolean) => {
    if (busy() || finished) return;
    if (value().trim() === props.name) return finish(false);
    if (projectNameError(props.projectId, value()) !== null) {
      // Enter keeps the field open with the error; leaving it drops the invalid name
      if (leaving) finish(false);
      return;
    }
    setBusy(true);
    try {
      await renameProject(props.projectId, value());
      finish(true);
    } catch (e) {
      setBusy(false);
      const message = toApiError(e).message;
      if (leaving) {
        toast({ kind: "error", title: "Could not rename the project", body: message });
        finish(false);
      } else {
        setSaveError(message);
      }
    }
  };

  return (
    <span class="dg-sidebar-rename">
      <TextField
        value={value()}
        onInput={(v) => {
          setValue(v);
          setSaveError(null);
        }}
        inputRef={(el) => (input = el)}
        error={error() !== null}
        aria-label="Project name"
        aria-describedby={error() ? `${props.projectId}-rename-error` : undefined}
        disabled={busy()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            void save(false);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            finish(false);
          } else {
            // typing must not reach the sidebar's speed search or the card's F2
            e.stopPropagation();
          }
        }}
        onBlur={() => void save(true)}
      />
      <Show when={error()}>
        {(m) => (
          <span class="dg-sidebar-rename-error" id={`${props.projectId}-rename-error`} role="alert">
            {m()}
          </span>
        )}
      </Show>
    </span>
  );
}
