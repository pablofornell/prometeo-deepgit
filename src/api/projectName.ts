/**
 * Rules for a project name, shared by the UI (inline error while typing) and the browser mock. A port of
 * `validate_project_name` in `src-tauri/src/workspace.rs`: same rules, same messages.
 *
 *   validateProjectName("  Work ", projects, "p1")   { name: "Work" }
 *   validateProjectName("", projects, "p1")          { error: "The project name cannot be empty." }
 */

/** Longest project name, in characters (code points, like Rust `chars()`). */
export const PROJECT_NAME_MAX = 80;

export type ProjectNameCheck = { name: string; error?: undefined } | { error: string; name?: undefined };

/** Rust `str::trim`: Unicode White_Space at both ends. */
const trimLikeRust = (s: string): string => s.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");

/**
 * Checks a new name for project `id` against the other projects. Refused: empty after trimming, longer than 80
 * characters, control characters (tab, new line...), or the name of another project ignoring case and spaces.
 */
export function validateProjectName(name: string, projects: readonly { id: string; name: string }[], id: string): ProjectNameCheck {
  const n = trimLikeRust(name);
  if (n === "") return { error: "The project name cannot be empty." };
  if ([...n].length > PROJECT_NAME_MAX) return { error: `The project name is too long: ${PROJECT_NAME_MAX} characters at most.` };
  if (/\p{Cc}/u.test(n)) return { error: "The project name cannot contain control characters (tab, new line)." };
  const lower = n.toLowerCase();
  const other = projects.find((p) => p.id !== id && trimLikeRust(p.name).toLowerCase() === lower);
  if (other) return { error: `Another project is already called "${trimLikeRust(other.name)}".` };
  return { name: n };
}
