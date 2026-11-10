/** Diff viewer options (the options menu), persisted as `deepgit.ui.diff.<name>`. `diffMode` lives in `state/settings`. */
import { createSignal, type Accessor } from "solid-js";
import { loadPersisted, savePersisted } from "../../state/persist";
import { setSetting, type DiffMode } from "../../state/settings";
import type { IgnoreWs } from "./diffModel";

function persisted<T>(key: string, fallback: T): [Accessor<T>, (v: T) => void] {
  const [get, set] = createSignal<T>(loadPersisted(key, fallback));
  return [
    get,
    (v) => {
      set(() => v);
      savePersisted(key, v);
    },
  ];
}

export const [wordDiffOn, setWordDiffOn] = persisted("diff.wordDiff", true);
export const [syntaxOn, setSyntaxOn] = persisted("diff.syntax", true);
export const [collapseOn, setCollapseOn] = persisted("diff.collapse", true);
export const [lineNumbersOn, setLineNumbersOn] = persisted("diff.lineNumbers", true);
export const [ignoreWs, setIgnoreWs] = persisted<IgnoreWs>("diff.ignoreWhitespace", "off");

/** The layout the user picked in this session (not saved across sessions): it beats the narrow-pane fallback. */
export const [explicitDiffMode, setExplicitDiffMode] = createSignal<DiffMode | null>(null);

/** The user picks a layout: remembered for the session and saved as the default. */
export function chooseDiffMode(m: DiffMode): void {
  setExplicitDiffMode(m);
  setSetting("diffMode", m);
}
