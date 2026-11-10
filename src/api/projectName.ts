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

/** The letters whose simple case fold is not their lowercase (`name_key` in Rust has the same list). */
const FOLD: Readonly<Record<string, string>> = {
  "\u03c2": "\u03c3", // final sigma
  "\u017f": "s", // long s
  "\u03d0": "\u03b2", // beta symbol
  "\u03d1": "\u03b8", // theta symbol
  "\u03d5": "\u03c6", // phi symbol
  "\u03d6": "\u03c0", // pi symbol
  "\u03f0": "\u03ba", // kappa symbol
  "\u03f1": "\u03c1", // rho symbol
  "\u03f5": "\u03b5", // lunate epsilon
  "\u1e9b": "\u1e61", // long s with dot above
  "\u1fbe": "\u03b9", // prosgegrammeni
};

/**
 * What two project names are compared by, like `name_key` in `src-tauri/src/workspace.rs`: trimmed, NFC, each
 * character lowercased on its own (as Rust `char::to_lowercase`), the few letters of `FOLD`, then NFC again.
 *
 *   nameKey(" Café ") === nameKey("CAFE\u0301")   true
 */
export function nameKey(name: string): string {
  const folded = [...trimLikeRust(name).normalize("NFC")]
    .map((c) => {
      const lower = c.toLowerCase();
      return FOLD[lower] ?? lower;
    })
    .join("");
  return folded.normalize("NFC");
}

/** `name`, or the first of "name (2)", "name (3)"... that no project has (`unique_name` in Rust, used when a folder is added). */
export function uniqueProjectName(name: string, projects: readonly { name: string }[]): string {
  const taken = (n: string) => {
    const key = nameKey(n);
    return projects.some((p) => nameKey(p.name) === key);
  };
  const base = trimLikeRust(name);
  if (!taken(base)) return base;
  for (let i = 2; ; i++) if (!taken(`${base} (${i})`)) return `${base} (${i})`;
}

/**
 * Checks a new name for project `id` against the other projects. Refused: empty after trimming, longer than 80
 * characters, control characters (tab, new line...), or the name of another project (the same `nameKey`: ignoring case,
 * Unicode normal form and spaces).
 */
export function validateProjectName(name: string, projects: readonly { id: string; name: string }[], id: string): ProjectNameCheck {
  const n = trimLikeRust(name);
  if (n === "") return { error: "The project name cannot be empty." };
  if ([...n].length > PROJECT_NAME_MAX) return { error: `The project name is too long: ${PROJECT_NAME_MAX} characters at most.` };
  if (/\p{Cc}/u.test(n)) return { error: "The project name cannot contain control characters (tab, new line)." };
  const key = nameKey(n);
  const other = projects.find((p) => p.id !== id && nameKey(p.name) === key);
  if (other) return { error: `Another project is already called "${trimLikeRust(other.name)}".` };
  return { name: n };
}
