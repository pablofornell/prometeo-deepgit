import { For, type JSX, createSignal } from "solid-js";
import { Checkbox } from "./Checkbox";
import { Dialog, type DialogComponentProps } from "./Dialog";

export interface ConfirmCheckbox {
  id: string;
  label: string;
  checked?: boolean;
}

export interface ConfirmProps {
  title: string;
  /** One paragraph, or several. */
  message: string | string[];
  /** The primary button names the action ("Discard 3 files"); never "OK". */
  confirmLabel: string;
  /** Red primary button for destructive actions. */
  danger?: boolean;
  checkboxes?: ConfirmCheckbox[];
  /** git command(s) shown in the preview strip. */
  command?: string | string[];
  cancelLabel?: string;
}

export interface ConfirmResult {
  /** State of every checkbox by id. */
  checked: Record<string, boolean>;
}

/** The generic confirm dialog behind `confirmAction()` in `state/dialogs.ts`. */
export function ConfirmDialog(props: ConfirmProps & DialogComponentProps<ConfirmResult>): JSX.Element {
  const [checked, setChecked] = createSignal<Record<string, boolean>>(Object.fromEntries((props.checkboxes ?? []).map((c) => [c.id, !!c.checked])));
  const paragraphs = () => (Array.isArray(props.message) ? props.message : [props.message]);
  return (
    <Dialog
      title={props.title}
      onClose={() => props.close()}
      cancelLabel={props.cancelLabel}
      command={props.command}
      primary={{ label: props.confirmLabel, danger: props.danger, onClick: () => props.close({ checked: checked() }) }}
    >
      <For each={paragraphs()}>{(p) => <p class="dg-selectable" style={{ "line-height": "18px" }}>{p}</p>}</For>
      <For each={props.checkboxes ?? []}>
        {(c) => <Checkbox checked={checked()[c.id]} onChange={(v) => setChecked({ ...checked(), [c.id]: v })} label={c.label} />}
      </For>
    </Dialog>
  );
}
