/**
 * Branch table across the repos of the active project (DESIGN.md 11.2): one column per branch name, one cell per repo.
 * Shared by the title bar branch popup, the sidebar sync strip and the branch matrix tool window.
 *
 *   const col = branchColumn("feature/x");   // reactive; undefined when no repo has the branch
 *   col?.cells[repoId].state                 // "current" | "local" | "remote" | "missing"
 *   setMatrixBranch("feature/x");            // pre-selects the column when the matrix opens
 *
 * The pure builder `buildBranchTable` is exported for tests.
 */
import { createMemo, createRoot, createSignal } from "solid-js";
import type { Refs } from "../api/types";
import { repoRefs } from "./refs";
import { projectRepos } from "./workspace";

export type CellState = "current" | "local" | "remote" | "missing";

export interface BranchCell {
  state: CellState;
  /** Against the upstream of the local branch. */
  ahead: number;
  behind: number;
  /** The upstream was deleted. */
  gone: boolean;
}

export interface BranchColumn {
  name: string;
  /** By repo id. Every repo of the project has a cell. */
  cells: Record<string, BranchCell>;
  /** Repos with the branch checked out. */
  current: number;
  /** Repos with a local branch that is not checked out. */
  local: number;
  /** Repos where only `origin/<name>` exists. */
  remoteOnly: number;
  /** Repos without the branch. */
  missing: number;
  /** Repos that have it locally or on a remote (`current + local + remoteOnly`). */
  present: number;
}

const MISSING: BranchCell = { state: "missing", ahead: 0, behind: 0, gone: false };

/** Merges the refs of several repos into one column per branch name, most widespread first. */
export function buildBranchTable(repoIds: readonly string[], refsOf: (repoId: string) => Refs | undefined): BranchColumn[] {
  const names = new Set<string>();
  const perRepo = new Map<string, { local: Map<string, Refs["local"][number]>; remote: Set<string> }>();
  for (const id of repoIds) {
    const refs = refsOf(id);
    const local = new Map((refs?.local ?? []).map((b) => [b.name, b]));
    const remote = new Set((refs?.remote ?? []).filter((r) => r.name !== "HEAD").map((r) => r.name));
    perRepo.set(id, { local, remote });
    for (const n of local.keys()) names.add(n);
    for (const n of remote) names.add(n);
  }
  const columns: BranchColumn[] = [];
  for (const name of names) {
    const cells: Record<string, BranchCell> = {};
    let current = 0;
    let local = 0;
    let remoteOnly = 0;
    let missing = 0;
    for (const id of repoIds) {
      const r = perRepo.get(id);
      const b = r?.local.get(name);
      if (b) {
        cells[id] = { state: b.isHead ? "current" : "local", ahead: b.ahead, behind: b.behind, gone: b.gone };
        if (b.isHead) current++;
        else local++;
      } else if (r?.remote.has(name)) {
        cells[id] = { state: "remote", ahead: 0, behind: 0, gone: false };
        remoteOnly++;
      } else {
        cells[id] = MISSING;
        missing++;
      }
    }
    columns.push({ name, cells, current, local, remoteOnly, missing, present: current + local + remoteOnly });
  }
  return columns.sort((a, b) => b.present - a.present || b.current - a.current || a.name.localeCompare(b.name));
}

/** Reactive branch table of the active project. Reading it loads the refs of every repo. */
export const branchTable = createRoot(() =>
  createMemo<BranchColumn[]>(() => {
    const ids = projectRepos().map((r) => r.id);
    const accessors = new Map(ids.map((id) => [id, repoRefs(id)]));
    return buildBranchTable(ids, (id) => accessors.get(id)?.());
  }),
);

/** The column for one branch name, or undefined. */
export function branchColumn(name: string | null | undefined): BranchColumn | undefined {
  if (!name) return undefined;
  return branchTable().find((c) => c.name === name);
}

const [matrixBranch, setMatrixBranchRaw] = createSignal<string | null>(null);

/** Branch whose matrix column is selected (the sidebar "Matrix" link sets it before opening the tool window). */
export { matrixBranch };
export function setMatrixBranch(name: string | null): void {
  setMatrixBranchRaw(name);
}
