/**
 * Colour assignment and choice rules of the browser mock. A line-by-line port of
 * `crates/gitcore/src/palette.rs` and the colour part of `src-tauri/src/workspace.rs`: the mock must be
 * exactly as strict as the Rust backend (same errors, same assignment), so the UI is tested against the truth.
 */
import { PALETTE_SIZE } from "../theme/palette";
import type { Project, RepoInfo, Workspace } from "./types";

export type ColorChoice = { kind: "auto" } | { kind: "palette"; index: number } | { kind: "custom"; hex: string };

/** `#RRGGBB` in any letter case becomes upper case; anything else is null. */
export function normalizeHex(s: string): string | null {
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toUpperCase() : null;
}

/** Validates the arguments of `repo_set_color` / `project_set_color`. Returns the choice, or the error message. */
export function parseColorChoice(color: number | null, custom: string | null): ColorChoice | string {
  if (color !== null && custom !== null) return "Give a palette color or a custom color, not both";
  if (color !== null) return color < PALETTE_SIZE ? { kind: "palette", index: color } : "Unknown palette color";
  if (custom !== null) {
    const hex = normalizeHex(custom);
    return hex ? { kind: "custom", hex } : "Invalid color, expected #RRGGBB";
  }
  return { kind: "auto" };
}

/** The palette index used least among `used` (out-of-palette values ignored); the lowest index wins a tie. */
export function nextColor(used: Iterable<number>): number {
  const counts = new Array<number>(PALETTE_SIZE).fill(0);
  for (const c of used) if (c >= 0 && c < PALETTE_SIZE) counts[c]++;
  return counts.indexOf(Math.min(...counts));
}

const allRepos = (ws: Workspace): RepoInfo[] => ws.projects.flatMap((p) => p.repos);

/** Palette indexes the projects show (no custom colour), skipping the project at `skip`. */
function projectColorsUsed(ws: Workspace, skip: number | null): number[] {
  return ws.projects.filter((p, i) => i !== skip && p.customColor === null).map((p) => p.color);
}

/** Palette indexes shown by the repos outside project `skipProject` (each repo id once, custom colours show none). */
function repoColorsUsed(ws: Workspace, skipProject: string | null): number[] {
  const seen = new Set<string>();
  const used: number[] = [];
  for (const p of ws.projects) {
    if (p.id === skipProject) continue;
    for (const r of p.repos) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      if (r.customColor === null) used.push(r.color);
    }
  }
  return used;
}

/**
 * Colours the repos of `project`: a repo the workspace already knows (any project, by id) keeps its colour
 * and custom colour; a new repo gets the least-used palette colour. `replacing` is the project being rescanned.
 */
export function colorizeRepos(ws: Workspace, replacing: string | null, project: Project): void {
  const known = new Map(allRepos(ws).map((r) => [r.id, r]));
  const used = repoColorsUsed(ws, replacing);
  for (const r of project.repos) {
    const old = known.get(r.id);
    if (!old) continue;
    r.color = old.color;
    r.customColor = old.customColor;
    if (r.customColor === null) used.push(r.color);
  }
  for (const r of project.repos) {
    if (known.has(r.id)) continue;
    r.color = nextColor(used);
    used.push(r.color);
  }
}

/** Gives the project and its repos their colours, then adds it to the workspace. */
export function addColoredProject(ws: Workspace, project: Project): void {
  colorizeRepos(ws, null, project);
  project.color = nextColor(projectColorsUsed(ws, null));
  project.customColor = null;
  ws.projects.push(project);
}

function applyChoice(target: { color: number; customColor: string | null }, choice: ColorChoice, auto: number): void {
  if (choice.kind === "auto") {
    target.color = auto;
    target.customColor = null;
  } else if (choice.kind === "palette") {
    target.color = choice.index;
    target.customColor = null;
  } else {
    target.customColor = choice.hex;
  }
}

/** Sets the colour of a repo in every project that holds it. Null for an unknown id. */
export function setRepoColor(ws: Workspace, repoId: string, choice: ColorChoice): RepoInfo | null {
  const copies = allRepos(ws).filter((r) => r.id === repoId);
  if (copies.length === 0) return null;
  const others = new Map<string, RepoInfo>();
  for (const r of allRepos(ws)) if (r.id !== repoId && r.customColor === null && !others.has(r.id)) others.set(r.id, r);
  const auto = nextColor([...others.values()].map((r) => r.color));
  for (const r of copies) applyChoice(r, choice, auto);
  return { ...copies[copies.length - 1] };
}

/** Sets the colour of a project. Null for an unknown id. */
export function setProjectColor(ws: Workspace, projectId: string, choice: ColorChoice): Project | null {
  const pos = ws.projects.findIndex((p) => p.id === projectId);
  if (pos < 0) return null;
  const p = ws.projects[pos];
  applyChoice(p, choice, nextColor(projectColorsUsed(ws, pos)));
  return structuredClone(p);
}
