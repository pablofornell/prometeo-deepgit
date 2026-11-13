/**
 * Modal dialogs. Mount `<DialogHost />` once (the shell does).
 *
 *   // 1. write the dialog body with the frame:
 *   function RenameDialog(props: { oldName: string } & DialogComponentProps<string>) {
 *     const [name, setName] = createSignal(props.oldName);
 *     return (
 *       <Dialog title="Rename branch" onClose={() => props.close()}
 *         primary={{ label: "Rename", disabled: !name().trim(), onClick: () => props.close(name().trim()) }}
 *         command={`git branch -m ${props.oldName} ${name()}`}>
 *         <TextField value={name()} onInput={setName} />
 *       </Dialog>
 *     );
 *   }
 *   // 2. open it and await the result (undefined = cancelled):
 *   const newName = await openDialog(RenameDialog, { oldName: "main" });
 *
 * The frame gives: scrim, Esc closes, Enter runs the primary action (not inside a textarea),
 * Tab stays inside the dialog, focus returns to the previous element on close.
 * Feature dialogs registered in `state/dialogs.ts` receive the same `close` prop.
 */
import { type Component, For, type JSX, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Dynamic, Portal } from "solid-js/web";
import { trackOverlay } from "../../state/keymap";
import { setDialogDepth } from "../../state/overlays";
import { Button, IconButton } from "./Button";
import { type Offset, clampDialogOffset } from "./dialogGeometry";
import { copyText } from "./util";

/** Props every dialog body component receives in addition to its own. */
export interface DialogComponentProps<T> {
  /** Closes the dialog; `openDialog` resolves to `result` (undefined = cancelled). */
  close: (result?: T) => void;
}

interface OpenDialog {
  id: number;
  component: Component<never>;
  props: Record<string, unknown>;
  resolve: (r: unknown) => void;
}

const [stack, setStack] = createSignal<OpenDialog[]>([]);
let seq = 0;

/** Opens a modal dialog and resolves when it closes. Resolves to `undefined` when cancelled. */
export function openDialog<P extends object, T>(component: Component<P & DialogComponentProps<T>>, props: P): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    const id = ++seq;
    const close = (r?: unknown) => {
      setStack((s) => s.filter((d) => d.id !== id));
      setDialogDepth(stack().length);
      resolve(r as T | undefined);
    };
    setStack((s) => [
      ...s,
      { id, component: component as unknown as Component<never>, props: { ...props, close } as Record<string, unknown>, resolve: resolve as (r: unknown) => void },
    ]);
    // menus and popups that are open close now (`closeWhenDialogOpens`)
    setDialogDepth(stack().length);
  });
}

export const hasOpenDialog = (): boolean => stack().length > 0;

/**
 * Moves the dialog that contains `inside` by `shift` px (on top of the offset it has), kept inside the window.
 * For controls that resize the page (Settings: font size, UI scale): the dialog follows, so the control stays under
 * the pointer. The offset ends when the window is resized or the dialog closes.
 */
export function moveDialogBy(inside: Element, shift: Offset): void {
  const box = inside.closest<HTMLElement>(".dg-dialog");
  if (!box) return;
  const cur = { x: parseFloat(box.style.left) || 0, y: parseFloat(box.style.top) || 0 };
  const r = box.getBoundingClientRect();
  const natural = { left: r.left - cur.x, top: r.top - cur.y, width: r.width, height: r.height };
  const next = clampDialogOffset(cur, shift, natural, { width: window.innerWidth, height: window.innerHeight });
  box.style.position = "relative";
  box.style.left = `${next.x}px`;
  box.style.top = `${next.y}px`;
}

/** Renders the open dialogs (stacked). Mount once near the root. */
export function DialogHost(): JSX.Element {
  return (
    <Show when={stack().length > 0}>
      <Portal>
        <For each={stack()}>{(d) => <Dynamic component={d.component as unknown as Component<Record<string, unknown>>} {...d.props} />}</For>
      </Portal>
    </Show>
  );
}

export interface DialogAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Red fill for destructive actions (hard reset, discard, force delete). */
  danger?: boolean;
}

export interface DialogProps {
  title: string;
  /** Called on Esc and the Cancel button. */
  onClose: () => void;
  /** Primary action, rightmost; runs on Enter. */
  primary?: DialogAction;
  /** Cancel button label (default "Cancel"). */
  cancelLabel?: string;
  /** False hides the Cancel button (default true). Esc still calls `onClose`. */
  cancel?: boolean;
  /** 480 px (default), 640 px, or "large" (Settings: up to 1040 x 700 px, the body fills the frame). */
  width?: "normal" | "wide" | "large";
  /** The git command(s) this dialog will run: shown in a mono strip (DESIGN.md 11.7). Update it as options change. */
  command?: string | string[];
  /** Content at the left of the footer (e.g. a checkbox). */
  footerLeft?: JSX.Element;
  children: JSX.Element;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Dialog frame: title, body, optional command preview, footer buttons. See the file header. */
export function Dialog(props: DialogProps): JSX.Element {
  let box: HTMLDivElement | undefined;
  const previous = document.activeElement as HTMLElement | null;
  trackOverlay(() => true);
  const commands = () => (props.command === undefined ? [] : Array.isArray(props.command) ? props.command : [props.command]);

  onMount(() => {
    const first = box?.querySelector<HTMLElement>("input:not([disabled]), textarea, select") ?? box?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? box)?.focus();
    if (first instanceof HTMLInputElement) first.select();
    // a dialog that was moved (`moveDialogBy`) goes back to its place when the window changes size
    const recentre = () => {
      if (!box) return;
      box.style.left = "";
      box.style.top = "";
    };
    window.addEventListener("resize", recentre);
    onCleanup(() => window.removeEventListener("resize", recentre));
  });
  onCleanup(() => previous?.focus?.());

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
    } else if (e.key === "Enter" && !e.shiftKey && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement)) {
      if (props.primary && !props.primary.disabled) {
        e.preventDefault();
        props.primary.onClick();
      }
    } else if (e.key === "Tab" && box) {
      const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div class="dg-scrim" onKeyDown={onKeyDown} onMouseDown={(e) => e.target === e.currentTarget && e.preventDefault()}>
      <div
        ref={box}
        class={"dg-dialog" + (props.width === "wide" ? " dg-dialog-wide" : props.width === "large" ? " dg-dialog-large" : "")}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        tabindex={-1}
      >
        <h2 class="dg-dialog-title">{props.title}</h2>
        <div class="dg-dialog-body">{props.children}</div>
        <Show when={commands().length > 0}>
          <div class="dg-command dg-selectable">
            <div class="dg-command-lines">
              <For each={commands()}>{(c) => <div class="dg-command-line">{c.startsWith("$") ? c : "$ " + c}</div>}</For>
            </div>
            <IconButton icon="copy" label="Copy command" size="small" iconSize={12} onClick={() => void copyText(commands().join("\n"))} />
          </div>
        </Show>
        <div class="dg-dialog-footer">
          <div class="dg-dialog-footer-left">{props.footerLeft}</div>
          <Show when={props.cancel ?? true}>
            <Button onClick={props.onClose}>{props.cancelLabel ?? "Cancel"}</Button>
          </Show>
          <Show when={props.primary}>
            {(p) => (
              <Button variant={p().danger ? "danger" : "primary"} disabled={p().disabled} onClick={p().onClick}>
                {p().label}
              </Button>
            )}
          </Show>
        </div>
      </div>
    </div>
  );
}
