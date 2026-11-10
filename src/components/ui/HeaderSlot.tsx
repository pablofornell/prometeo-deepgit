import { type JSX, Show, createSignal } from "solid-js";
import { Portal } from "solid-js/web";

export type HeaderSlotName = "main";

const targets: Record<HeaderSlotName, ReturnType<typeof createSignal<HTMLElement | undefined>>> = {
  main: createSignal<HTMLElement | undefined>(),
};

/** Where a slot's content appears. The shell renders one per slot; features do not use this. */
export function HeaderSlotTarget(props: { name: HeaderSlotName; class?: string }): JSX.Element {
  return <div class={props.class} ref={(el) => targets[props.name][1](el)} style={{ display: "contents" }} />;
}

/**
 * Puts content into the shell's main-island header (right of the "Log" / "Local changes" tabs), so each view
 * can contribute its own toolbar buttons. The content unmounts with the component.
 *
 *   <HeaderSlot name="main">
 *     <IconButton icon="refresh" label="Refresh" onClick={reload} />
 *   </HeaderSlot>
 */
export function HeaderSlot(props: { name: HeaderSlotName; children: JSX.Element }): JSX.Element {
  const [target] = targets[props.name];
  return (
    <Show when={target()}>
      {(el) => <Portal mount={el()}>{props.children}</Portal>}
    </Show>
  );
}
