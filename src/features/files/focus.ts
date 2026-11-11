/**
 * Where the keyboard focus is. Global shortcuts that a text field may use ask here, so the editor keeps its own keys.
 */

/** Returns true while the focus is in the editor of the Files tab, or in its find panel. */
export function inFilesEditor(): boolean {
  return document.activeElement?.closest(".dg-fe-editor .cm-editor") != null;
}
