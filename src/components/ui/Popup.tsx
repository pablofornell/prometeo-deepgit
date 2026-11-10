import { type JSX, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { trackOverlay } from "../../state/keymap";
import { closeWhenDialogOpens } from "../../state/overlays";

export type PopupPlacement = "bottom-start" | "bottom-end" | "top-start" | "right-start";

type AnchorLike = HTMLElement | null | undefined;

export interface PopupProps {
  open: boolean;
  /** Element the popup hangs from (or a getter, for refs that are set later). */
  anchor: AnchorLike | (() => AnchorLike);
  /** Called on outside click, Esc, window blur/resize. Set `open` to false there. */
  onClose: () => void;
  placement?: PopupPlacement;
  /** Gap to the anchor in px (default 4). */
  offset?: number;
  /** Make the popup at least as wide as the anchor. */
  matchWidth?: boolean;
  class?: string;
  /** Accessible name. */
  label?: string;
  children: JSX.Element;
}

/**
 * Anchored popup surface (DESIGN.md 5.20): popup background, radius 8, shadow, 90 ms fade-in.
 * Rendered in a portal; flips above the anchor when there is no room below.
 *
 *   const [open, setOpen] = createSignal(false);
 *   let btn!: HTMLButtonElement;
 *   <Button ref={btn} onClick={() => setOpen(!open())}>Branch</Button>
 *   <Popup open={open()} anchor={() => btn} onClose={() => setOpen(false)}>…content…</Popup>
 */
export function Popup(props: PopupProps): JSX.Element {
  const [pos, setPos] = createSignal<{ left: number; top: number; minWidth?: number } | null>(null);
  let box: HTMLDivElement | undefined;
  trackOverlay(() => props.open);
  const anchorEl = (): AnchorLike => (typeof props.anchor === "function" ? props.anchor() : props.anchor);

  const place = () => {
    const a = anchorEl();
    if (!a || !box) return;
    const ar = a.getBoundingClientRect();
    const pr = box.getBoundingClientRect();
    const gap = props.offset ?? 4;
    const placement = props.placement ?? "bottom-start";
    let left = placement === "bottom-end" ? ar.right - pr.width : placement === "right-start" ? ar.right + gap : ar.left;
    let top = placement === "top-start" ? ar.top - pr.height - gap : placement === "right-start" ? ar.top : ar.bottom + gap;
    if (placement !== "top-start" && top + pr.height > window.innerHeight - 6 && ar.top - pr.height - gap > 6) top = ar.top - pr.height - gap;
    left = Math.min(Math.max(6, left), Math.max(6, window.innerWidth - pr.width - 6));
    top = Math.min(Math.max(6, top), Math.max(6, window.innerHeight - pr.height - 6));
    setPos({ left, top, minWidth: props.matchWidth ? ar.width : undefined });
  };

  createEffect(() => {
    if (!props.open) {
      setPos(null);
      return;
    }
    queueMicrotask(place);
    // a popup above the scrim of a dialog that opens now could be clicked: close it (one opened from a dialog stays)
    closeWhenDialogOpens(() => props.onClose());
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (box?.contains(t) || anchorEl()?.contains(t)) return;
      props.onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        props.onClose();
      }
    };
    const dismiss = () => props.onClose();
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
    onCleanup(() => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
    });
  });

  return (
    <Show when={props.open}>
      <Portal>
        <div
          ref={box}
          class={"dg-popup" + (props.class ? " " + props.class : "")}
          role="dialog"
          aria-label={props.label}
          style={{
            left: (pos()?.left ?? 0) + "px",
            top: (pos()?.top ?? 0) + "px",
            "min-width": pos()?.minWidth ? pos()?.minWidth + "px" : undefined,
            visibility: pos() ? "visible" : "hidden",
          }}
        >
          {props.children}
        </div>
      </Portal>
    </Show>
  );
}
