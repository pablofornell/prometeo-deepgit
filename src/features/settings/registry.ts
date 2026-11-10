/**
 * Settings sections. A section is ONE file in `features/settings/sections/` that calls `registerSettingsSection(...)`;
 * `SettingsDialog.tsx` loads every file of that folder (`import.meta.glob`), so nothing else needs to change.
 *
 *   // features/settings/sections/Git.tsx (a real one: auto-fetch, sign-off, saved logins)
 *   import { registerSettingsSection } from "../registry";
 *   import { Row, Section } from "../widgets";
 *   function GitSection() {
 *     return <Section title="Fetch"><Row label="Fetch every"><SomeControl /></Row></Section>;
 *   }
 *   registerSettingsSection({ id: "git", title: "Git", order: 40, keywords: ["fetch", "pull", "prune"], component: GitSection,
 *                             reset: () => resetSettings(["autoFetchMinutes", "autoFetchPrune"]) });
 *
 * The dialog shows the title in the left list, filters it by `title` + `keywords`, and renders `component` in the right pane.
 * Changes must apply live: write to a store (`setSetting` or your own) in the control's handler, never on a "Save" step.
 */
import { type Component, createSignal } from "solid-js";
import type { IconName } from "../../components/ui";

export interface SettingsSection {
  /** Stable id, lower case (`appearance`). Registering the same id again replaces the section. */
  id: string;
  /** Shown in the left list and as the page heading. */
  title: string;
  /** Position in the list, ascending (Appearance 10, Log 20, Console 30, Git 40; leave gaps). */
  order: number;
  /** Extra words the filter field matches (names of the controls inside). */
  keywords?: string[];
  /** Optional icon of the list entry. */
  icon?: IconName;
  /** The page. Takes no props; it reads and writes the stores itself. */
  component: Component;
  /** Puts this page back to its defaults. Gives the page a "Reset to defaults" button and is also run by "Reset all". */
  reset?: () => void;
}

const [sections, setSections] = createSignal<SettingsSection[]>([]);

/** Adds a section (or replaces the one with the same id). */
export function registerSettingsSection(section: SettingsSection): void {
  setSections((list) => [...list.filter((s) => s.id !== section.id), section]);
}

/** All sections sorted by `order`, then title (reactive). */
export function settingsSections(): SettingsSection[] {
  return [...sections()].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

/** Sections whose title or keywords contain every word of `query` (case-insensitive). All of them when the query is empty. */
export function filterSections(list: readonly SettingsSection[], query: string): SettingsSection[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...list];
  return list.filter((s) => {
    const hay = [s.title, ...(s.keywords ?? [])].join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
