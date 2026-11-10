/**
 * Pure helpers for the palette query: tabs and the scope prefixes of DESIGN.md 5.15
 * (`#` commits, `@` authors, `/` files, `>` actions, `:` repos).
 */

export type Scope = "all" | "commits" | "branches" | "files" | "actions" | "repos";

export const TABS: { scope: Scope; label: string }[] = [
  { scope: "all", label: "All" },
  { scope: "commits", label: "Commits" },
  { scope: "branches", label: "Branches" },
  { scope: "files", label: "Files" },
  { scope: "actions", label: "Actions" },
  { scope: "repos", label: "Repos" },
];

export interface ParsedQuery {
  /** Scope in effect: the prefix wins over the selected tab. */
  scope: Scope;
  /** Text to match, without the prefix. */
  text: string;
  /** The prefix typed (">", "#"...), or null. */
  prefix: string | null;
  /** `@name`: search commits by author. */
  author: boolean;
}

const PREFIXES: Record<string, Scope> = { "#": "commits", "@": "commits", "/": "files", ">": "actions", ":": "repos" };

export function parseQuery(raw: string, tab: Scope): ParsedQuery {
  const first = raw.charAt(0);
  const scope = PREFIXES[first];
  if (scope) return { scope, text: raw.slice(1).trim(), prefix: first, author: first === "@" };
  return { scope: tab, text: raw.trim(), prefix: null, author: false };
}

/** Tab after `scope` in the given direction, wrapping around. */
export function cycleTab(scope: Scope, dir: 1 | -1): Scope {
  const i = TABS.findIndex((t) => t.scope === scope);
  return TABS[(i + dir + TABS.length) % TABS.length].scope;
}

/** The prefix that selects `scope` when typed, if any (shown in the placeholder). */
export function prefixFor(scope: Scope): string | null {
  switch (scope) {
    case "commits": return "#";
    case "files": return "/";
    case "actions": return ">";
    case "repos": return ":";
    default: return null;
  }
}

/** Placeholder of the input for each scope. */
export function placeholderFor(scope: Scope): string {
  switch (scope) {
    case "commits": return "Search commits by message or hash";
    case "branches": return "Search branches";
    case "files": return "Search changed files";
    case "actions": return "Search actions";
    case "repos": return "Search repositories";
    default: return "Type to search";
  }
}
