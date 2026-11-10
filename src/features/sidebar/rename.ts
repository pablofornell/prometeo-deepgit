/**
 * Pure rules of the in-place project rename (`ProjectNameEditor.tsx`, `Sidebar.tsx`), tested under node.
 *
 * The editor belongs to one project: the one it was opened for. When the card shows another project while the editor
 * is open (a background clone that finishes makes its project the active one), the editor closes and saves nothing, so
 * the text typed for one project never becomes the name of another.
 *
 *   renameStep({ projectId: "a", original: "api", shownId: "b", value: "Work", error: null, leaving: true })   close
 */

export type RenameStep =
  /** Close the editor, nothing saved. */
  | { kind: "close" }
  /** Keep the editor open (Enter on an invalid name: the error shows under the field). */
  | { kind: "keep" }
  /** Rename project `projectId` to `name`. */
  | { kind: "save"; projectId: string; name: string };

export interface RenameInput {
  /** The project the editor was opened for (read once, when it opened). */
  projectId: string;
  /** Its name when the editor opened. */
  original: string;
  /** The project the card shows now. */
  shownId: string | undefined;
  /** The text in the field. */
  value: string;
  /** Why `value` cannot be the name (`projectNameError`), or null. */
  error: string | null;
  /** The field is being left (blur); false for Enter. */
  leaving: boolean;
}

/** What Enter (`leaving` false) or leaving the field does. */
export function renameStep(r: RenameInput): RenameStep {
  if (r.shownId !== r.projectId) return { kind: "close" };
  if (r.value.trim() === r.original) return { kind: "close" };
  if (r.error !== null) return r.leaving ? { kind: "close" } : { kind: "keep" };
  return { kind: "save", projectId: r.projectId, name: r.value };
}

/** The project whose editor stays open once the card shows `shownId`: the same one, or none. */
export function renamingAfterSwitch(renamingId: string | null, shownId: string | undefined): string | null {
  return renamingId !== null && renamingId === shownId ? renamingId : null;
}
