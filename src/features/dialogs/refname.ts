/**
 * Pure validator for branch and tag names, following `git check-ref-format` (and `--branch` for branches).
 * Returns a sentence for the first problem found, or null when the name is valid.
 *
 *   validateRefName("feature/x")        // null
 *   validateRefName("a..b")             // 'Names cannot contain "..".'
 */

export type RefKind = "branch" | "tag";

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const FORBIDDEN = ["~", "^", ":", "?", "*", "[", "\\"];

export function validateRefName(name: string, kind: RefKind = "branch"): string | null {
  const noun = kind === "branch" ? "Branch" : "Tag";
  if (name === "") return `Enter a ${kind} name.`;
  if (/\s/.test(name)) return `${noun} names cannot contain spaces.`;
  if (CONTROL.test(name)) return `${noun} names cannot contain control characters.`;
  if (name === "@") return `"@" is not a valid ${kind} name.`;
  if (kind === "branch" && name.toUpperCase() === "HEAD") return `"HEAD" is reserved. Pick another name.`;
  if (name.startsWith("-")) return `${noun} names cannot start with "-".`;
  if (name.startsWith("/") || name.endsWith("/")) return `${noun} names cannot start or end with "/".`;
  if (name.includes("//")) return `${noun} names cannot contain "//".`;
  if (name.includes("..")) return `${noun} names cannot contain "..".`;
  for (const c of FORBIDDEN) if (name.includes(c)) return `${noun} names cannot contain "${c}".`;
  if (name.includes("@{")) return `${noun} names cannot contain "@{".`;
  if (name.endsWith(".")) return `${noun} names cannot end with ".".`;
  for (const part of name.split("/")) {
    if (part.startsWith(".")) return `Each part of a ${kind} name must not start with ".".`;
    if (part.endsWith(".lock")) return `Each part of a ${kind} name must not end with ".lock".`;
  }
  return null;
}
