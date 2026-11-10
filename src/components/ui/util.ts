/**
 * Small pure helpers shared by UI components and features: hashing for colours, date formatting,
 * path and hash display, clipboard.
 */
import type { FileStatus } from "../../api/types";

/** FNV-1a 32-bit hash (DESIGN.md 4.1: the same hash for repo, avatar and lane colours on every machine). */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** `var(--dg-repo-N)` for a repo colour index (0..11). */
export function repoColorVar(index: number): string {
  return `var(--dg-repo-${((index % 12) + 12) % 12})`;
}

/** `var(--dg-lane-N)` for an unbounded graph colour index. */
export function laneColorVar(index: number): string {
  return `var(--dg-lane-${index % 10})`;
}

/** First 7 hex chars. */
export function shortOid(oid: string): string {
  return oid.slice(0, 7);
}

/** Two initials: first letters of the first and last word; one word gives its first two letters. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const two = (n: number) => String(n).padStart(2, "0");

/** "4 min ago", "3 h ago", "yesterday", "5 d ago", "3 mo ago", "2 y ago" for unix seconds. */
export function formatRelative(unixSec: number, nowMs: number = Date.now()): string {
  const s = Math.max(0, Math.floor(nowMs / 1000 - unixSec));
  if (s < 45) return "now";
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(s / 3600);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(s / 86400);
  if (d === 1) return "yesterday";
  if (d < 30) return `${d} d ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo} mo ago`;
  return `${Math.round(d / 365)} y ago`;
}

/**
 * Log date column (DESIGN.md 5.5 "Date groups"): `HH:mm` today/yesterday, `Ddd HH:mm` within a week,
 * `D Mmm` this year, `D Mmm YYYY` older.
 */
export function formatLogDate(unixSec: number, nowMs: number = Date.now()): string {
  const d = new Date(unixSec * 1000);
  const now = new Date(nowMs);
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  if (days <= 1) return hm;
  if (days < 7) return `${DAYS[d.getDay()]} ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "Tue 10 Nov 2026 10:42" (local time). */
export function formatDateTime(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** Splits "src/refunds/controller.rs" into directory ("src/refunds/") and file name. */
export function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { dir: "", name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
}

/** Status letter shown next to files (DESIGN.md 5.9). */
export function statusLetter(s: FileStatus): string {
  switch (s) {
    case "added": return "A";
    case "modified": return "M";
    case "deleted": return "D";
    case "renamed": return "R";
    case "copied": return "C";
    case "conflicted": return "U";
    case "untracked": return "?";
    case "ignored": return "!";
    case "typeChanged": return "T";
  }
}

/** `var(--dg-status-*)` colour of a file status. */
export function statusColorVar(s: FileStatus): string {
  const key: Record<FileStatus, string> = {
    added: "added", modified: "modified", deleted: "deleted", renamed: "renamed", copied: "copied",
    conflicted: "conflict", untracked: "untracked", ignored: "ignored", typeChanged: "typechange",
  };
  return `var(--dg-status-${key[s]})`;
}

/** Copies text to the clipboard. Resolves to false when the browser refuses. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const done = document.execCommand("copy");
    ta.remove();
    return done;
  }
}

/** Plural helper: `plural(3, "repo")` -> "3 repos". */
export function plural(n: number, word: string, pluralWord = word + "s"): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

/** Joins names: ["a","b","c"] -> "a, b and c". */
export function joinNames(names: string[], max = 3): string {
  if (names.length <= max) {
    return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names.join("");
  }
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}
