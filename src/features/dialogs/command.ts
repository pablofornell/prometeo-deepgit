/**
 * Pure builders for the command preview strip every dialog shows (DESIGN.md 11.7).
 *
 *   gitCmd("api-gateway", ["reset", "--mixed", "3c0e9b5"])   // "git -C api-gateway reset --mixed 3c0e9b5"
 *   perRepo(["a", "b"], (n) => gitCmd(n, ["fetch"]))          // one line per repo, capped
 */

/** Quotes an argument for a POSIX shell only when it needs it. */
export function shellQuote(arg: string): string {
  if (arg !== "" && /^[A-Za-z0-9_@%+=:,./^~{}-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export type Arg = string | false | null | undefined;

/** A placeholder such as `<name>` shown while a field is still empty: never quoted. */
const PLACEHOLDER = /^<[a-z ]+>$/;

/** `git -C <repo> <args...>`; falsy args are skipped so options can be written inline. */
export function gitCmd(repoName: string, args: Arg[]): string {
  const quote = (a: string) => (PLACEHOLDER.test(a) ? a : shellQuote(a));
  return ["git", "-C", shellQuote(repoName), ...args.filter((a): a is string => typeof a === "string" && a !== "").map(quote)].join(" ");
}

/**
 * One command (or several, when `build` returns a list) per repo. Beyond `max` repos the preview
 * ends with a comment line so it stays short.
 */
export function perRepo(names: string[], build: (name: string) => string | string[], max = 3): string[] {
  const out: string[] = [];
  for (const n of names.slice(0, max)) {
    const r = build(n);
    out.push(...(Array.isArray(r) ? r : [r]));
  }
  const rest = names.length - max;
  if (rest > 0) out.push(`# … and ${rest} more ${rest === 1 ? "repository" : "repositories"}`);
  return out;
}
