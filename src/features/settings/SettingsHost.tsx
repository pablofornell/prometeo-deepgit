/** Mounted once by `App`: shows the short message ("UI scale 120%") after a zoom shortcut. */
import { type JSX, Show, createSignal } from "solid-js";
import "./settings.css";

const [message, setMessage] = createSignal<string | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;

/** Shows `text` for about a second, replacing the one on screen. */
export function showOsd(text: string): void {
  setMessage(text);
  clearTimeout(timer);
  timer = setTimeout(() => setMessage(null), 1200);
}

export function SettingsHost(): JSX.Element {
  return (
    <Show when={message()}>
      <div class="dg-settings-osd" role="status" aria-live="polite">
        {message()}
      </div>
    </Show>
  );
}
