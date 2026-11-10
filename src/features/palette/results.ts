/**
 * Pure ranking and grouping of palette results. `buildRows` turns the candidate lists into the flat row
 * model the view renders: group labels, hits and "N more" links.
 */
import { fuzzyMatch, fuzzyMatchPath, substringPositions } from "./fuzzy";
import { itemKey } from "./recent";
import type { Scope } from "./query";
import type { ItemKind, PaletteItem } from "./sources";

export interface Hit {
  item: PaletteItem;
  /** Indexes of matched characters in `labelOf(item)`. */
  positions: number[];
  score: number;
}

export type Row =
  | { t: "group"; label: string; id: string }
  | { t: "hit"; hit: Hit; id: string }
  | { t: "more"; scope: Scope; count: number; id: string };

export interface Candidates {
  actions: PaletteItem[];
  branches: PaletteItem[];
  repos: PaletteItem[];
  files: PaletteItem[];
  /** Already filtered by the backend. */
  commits: PaletteItem[];
  recent: PaletteItem[];
}

/** Rows per group in the All tab, and rows in a single-scope tab. */
export const PER_GROUP = 4;
export const SINGLE_LIMIT = 50;

const GROUPS: { kind: ItemKind; scope: Scope; label: string; key: keyof Candidates }[] = [
  { kind: "branch", scope: "branches", label: "Branches", key: "branches" },
  { kind: "action", scope: "actions", label: "Actions", key: "actions" },
  { kind: "repo", scope: "repos", label: "Repositories", key: "repos" },
  { kind: "file", scope: "files", label: "Files", key: "files" },
  { kind: "commit", scope: "commits", label: "Commits", key: "commits" },
];

/** Items that match `text`, best first. An empty text keeps the original order. */
export function rankItems(items: PaletteItem[], text: string, labelOf: (i: PaletteItem) => string): Hit[] {
  if (!text) return items.map((item) => ({ item, positions: [], score: 0 }));
  const out: Hit[] = [];
  for (const item of items) {
    const label = labelOf(item);
    const m = item.kind === "file" ? fuzzyMatchPath(text, label) : fuzzyMatch(text, label);
    if (!m) continue;
    // current branches float up a little, otherwise ties keep the source order (stable sort)
    out.push({ item, positions: m.positions, score: m.score + (item.kind === "branch" && item.isCurrent ? 2 : 0) });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Commits come pre-filtered by git; only highlight what the text matches. */
function commitHits(items: PaletteItem[], text: string, labelOf: (i: PaletteItem) => string): Hit[] {
  return items.map((item) => {
    const label = labelOf(item);
    const positions = substringPositions(text, label);
    return { item, positions: positions.length > 0 ? positions : (fuzzyMatch(text, label)?.positions ?? []), score: 0 };
  });
}

export function buildRows(scope: Scope, text: string, c: Candidates, labelOf: (i: PaletteItem) => string, authorSearch = false): Row[] {
  const rows: Row[] = [];
  const hit = (h: Hit): Row => ({ t: "hit", hit: h, id: itemKey(h.item) });

  if (scope === "all") {
    if (!text && c.recent.length > 0) {
      rows.push({ t: "group", label: "Recent", id: "g:recent" });
      for (const item of c.recent) rows.push(hit({ item, positions: [], score: 0 }));
      return rows;
    }
    const groups = GROUPS.map((g) => {
      const hits = g.kind === "commit" ? commitHits(c.commits, authorSearch ? "" : text, labelOf) : rankItems(c[g.key], text, labelOf);
      return { ...g, hits };
    }).filter((g) => g.hits.length > 0 && !(g.kind === "commit" && !text));
    // best synchronous group first; commits arrive late, so they always stay last
    const best = (g: (typeof groups)[number]) => g.hits[0]?.score ?? 0;
    const sync = groups.filter((g) => g.kind !== "commit").sort((a, b) => (text ? best(b) - best(a) : 0));
    for (const g of [...sync, ...groups.filter((x) => x.kind === "commit")]) {
      rows.push({ t: "group", label: g.label, id: "g:" + g.kind });
      for (const h of g.hits.slice(0, PER_GROUP)) rows.push(hit(h));
      if (g.hits.length > PER_GROUP) rows.push({ t: "more", scope: g.scope, count: g.hits.length - PER_GROUP, id: "more:" + g.scope });
    }
    return rows;
  }

  const g = GROUPS.find((x) => x.scope === scope);
  if (!g) return rows;
  const hits = g.kind === "commit" ? commitHits(c.commits, authorSearch ? "" : text, labelOf) : rankItems(c[g.key], text, labelOf);
  for (const h of hits.slice(0, SINGLE_LIMIT)) rows.push(hit(h));
  return rows;
}
