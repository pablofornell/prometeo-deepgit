/**
 * In-place rename of the project in the sidebar card: Enter saves, Esc cancels, leaving the field saves when the name
 * is valid (else cancels). The error under the field uses the backend's rules (`projectNameError`).
 *
 * The editor belongs to the project it was opened for (`rename.ts`): it reads the id and the name once, and when the
 * card shows another project it saves nothing.
 */
import { type JSX, Show, createSignal, onCleanup, onMount } from "solid-js";
import { toApiError } from "../../api/tauri";
import { TextField, toast } from "../../components/ui";
import { activeProject, projectNameError, renameProject } from "../../state/workspace";
import { renameStep } from "./rename";

export function ProjectNameEditor(props: { projectId: string; name: string; onDone: (renamed: boolean) => void }): JSX.Element {
  // read once: a later project switch must not turn this rename into one of another project
  const projectId = props.projectId;
  const original = props.name;
  const [value, setValue] = createSignal(original);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const error = () => saveError() ?? projectNameError(projectId, value());
  let input: HTMLInputElement | undefined;
  let finished = false;
  /** The field lost the focus while a save was running: an error then closes the editor (with a toast). */
  let leftWhileBusy = false;

  const focusAll = () => {
    input?.focus();
    input?.select();
  };
  onMount(focusAll);
  // gone (the card shows another project): a blur or a save that ends later does nothing
  onCleanup(() => {
    finished = true;
  });

  const finish = (renamed: boolean) => {
    if (finished) return;
    finished = true;
    props.onDone(renamed);
  };

  const save = async (leaving: boolean) => {
    if (finished) return;
    if (busy()) {
      if (leaving) leftWhileBusy = true;
      return;
    }
    const step = renameStep({ projectId, original, shownId: activeProject()?.id, value: value(), error: projectNameError(projectId, value()), leaving });
    if (step.kind === "close") return finish(false);
    if (step.kind === "keep") return;
    setBusy(true);
    try {
      await renameProject(step.projectId, step.name);
      finish(true);
    } catch (e) {
      setBusy(false);
      if (finished) return;
      const message = toApiError(e).message;
      if (leaving || leftWhileBusy) {
        toast({ kind: "error", title: "Could not rename the project", body: message });
        finish(false);
      } else {
        setSaveError(message);
        // the field kept the focus (read-only, not disabled, while busy); take it back anyway so Esc and leaving work
        focusAll();
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
        aria-describedby={error() ? `${projectId}-rename-error` : undefined}
        // read-only, not disabled: a disabled field loses the focus (WebKit blurs it), and then Esc and blur do nothing
        readOnly={busy()}
        aria-busy={busy() ? true : undefined}
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
          <span class="dg-sidebar-rename-error" id={`${projectId}-rename-error`} role="alert">
            {m()}
          </span>
        )}
      </Show>
    </span>
  );
}
