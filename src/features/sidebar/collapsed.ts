/** Collapsed folders of the sidebar (ITERATION-3 1.4): the set is always tied to the project it was loaded for. */

export interface CollapsedState {
  /** Project whose saved ids `ids` holds, or null before the first load. */
  projectId: string | null;
  ids: ReadonlySet<string>;
}

export const noCollapsed: CollapsedState = { projectId: null, ids: new Set() };

/** Local-storage key of a project (`savePersisted` / `loadPersisted`). */
export const collapsedKey = (projectId: string | null | undefined): string => `sidebar.collapsedFolders.${projectId ?? "none"}`;

/** The collapsed ids that apply to `activeId`: none while the state still belongs to another project. */
export function collapsedFor(state: CollapsedState, activeId: string | null | undefined): ReadonlySet<string> {
  return state.projectId === (activeId ?? null) ? state.ids : noCollapsed.ids;
}

/**
 * The state without the ids of folders that no longer exist, or null when nothing changes. It prunes only a state that
 * belongs to `activeId`: the ids of another project are not compared with this project's folders.
 */
export function pruneCollapsed(state: CollapsedState, activeId: string | null | undefined, folders: readonly string[]): CollapsedState | null {
  if (state.projectId !== (activeId ?? null) || state.projectId === null || folders.length === 0) return null;
  const keep = [...state.ids].filter((id) => folders.includes(id));
  return keep.length === state.ids.size ? null : { projectId: state.projectId, ids: new Set(keep) };
}
