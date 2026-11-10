import { For, type JSX } from "solid-js";

export interface KbdProps {
  /** Key string: "Ctrl+K" renders one cap per part; "Shift Shift" renders two caps. */
  keys?: string;
  /** Or a single cap with custom content. */
  children?: JSX.Element;
  /** 16 px caps for use inside fields. */
  small?: boolean;
}

/**
 * Keycap(s), DESIGN.md 5.21.
 *
 *   <Kbd keys="Ctrl+K" />        <Kbd keys="Shift Shift" small />        <Kbd>Esc</Kbd>
 */
export function Kbd(props: KbdProps): JSX.Element {
  const parts = () => (props.keys ? props.keys.split(/[+\s]+/).filter(Boolean) : []);
  return (
    <span class="dg-kbd-group">
      {props.children !== undefined ? (
        <span class="dg-kbd" classList={{ "dg-kbd-small": props.small }}>{props.children}</span>
      ) : (
        <For each={parts()}>{(p) => <span class="dg-kbd" classList={{ "dg-kbd-small": props.small }}>{p}</span>}</For>
      )}
    </span>
  );
}
