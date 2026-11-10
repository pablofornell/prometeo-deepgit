import { type JSX, createSignal } from "solid-js";
import { repoVars } from "../../state/colors";
import { HEX_COLOR } from "../../theme/palette";
import { Dialog, type DialogComponentProps } from "./Dialog";
import { TextField } from "./TextField";

export interface ColorDialogProps {
  title: string;
  /** Name shown in the preview chip (repository or project name). */
  subject: string;
  /** Colour the dialog starts with (`#RRGGBB`); a missing or broken value starts on white. */
  initial?: string | null;
}

const toHex = (v: string): string | null => {
  const t = v.trim();
  const withHash = t.startsWith("#") ? t : "#" + t;
  return HEX_COLOR.test(withHash) ? withHash.toUpperCase() : null;
};

/**
 * Custom colour picker: the native colour input, a hex field and a live preview of the tint. Resolves to
 * `#RRGGBB` (upper case), or undefined when cancelled.
 *
 *   const hex = await openDialog(ColorDialog, { title: "Custom color", subject: repo.name, initial: repo.customColor });
 */
export function ColorDialog(props: ColorDialogProps & DialogComponentProps<string>): JSX.Element {
  const [text, setText] = createSignal(toHex(props.initial ?? "") ?? "#4C8DFF");
  const hex = () => toHex(text());
  const preview = () => repoVars({ color: 0, customColor: hex() });
  return (
    <Dialog
      title={props.title}
      onClose={() => props.close()}
      primary={{ label: "Apply", disabled: hex() === null, onClick: () => hex() && props.close(hex() as string) }}
    >
      <div class="dg-colordlg-row">
        <input
          type="color"
          class="dg-colordlg-native"
          aria-label="Pick a color"
          value={hex() ?? "#000000"}
          onInput={(e) => setText(e.currentTarget.value.toUpperCase())}
        />
        <TextField value={text()} onInput={setText} error={hex() === null} aria-label="Color as #RRGGBB" placeholder="#RRGGBB" spellcheck={false} />
      </div>
      <div class="dg-colordlg-preview dg-tint-strong" style={preview()}>
        <span class="dg-colordlg-dot" style={{ background: "var(--rc)" }} />
        <span class="dg-colordlg-name">{props.subject}</span>
        <span class="dg-colordlg-sample">tinted row, hover and selection stay visible</span>
      </div>
      <p class="dg-colordlg-note">
        {hex() === null ? "Type a color as #RRGGBB." : "Text on the tint is adjusted to stay readable in the light and the dark theme."}
      </p>
    </Dialog>
  );
}
