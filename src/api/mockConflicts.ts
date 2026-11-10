/**
 * Conflict scenarios of the browser mock. A conflict is described the way the index holds it: the three
 * stages of a path (1 = base, 2 = "ours" of git, 3 = "theirs" of git). A missing stage is a missing side.
 * The mock maps them to Yours / Theirs like the Rust backend (swapped during a rebase).
 *
 *   docs-site        merging: 4 files (modify/modify with a real conflict, modify/modify that merges automatically,
 *                    delete/modify, binary)
 *   ledger-service   rebasing: 2 files (modify/modify, add/add), so Yours is stage 3
 */
import type { ConflictEntry, ConflictLabels, ConflictVersions, SideStatus } from "./types";

export interface MockStage {
  /** Text content; undefined for a binary version. */
  text?: string;
  /** Size of a binary version. */
  bytes?: number;
  /** Object id; derived from the content when absent. */
  oid?: string;
}

export interface MockConflict {
  path: string;
  /** Stage 1, 2 and 3 of the index. */
  s1?: MockStage;
  s2?: MockStage;
  s3?: MockStage;
  /** Line ending of the file in the worktree. */
  eol?: "lf" | "crlf";
}

/** What the mock knows about the operation that produced the conflicts (for the labels). */
export interface MockConflictContext {
  /** Branch merged in (merge), commit (cherry-pick, revert) or branch rebased onto (rebase). */
  theirs: string;
  /** Rebase only: the commit being replayed, "abc1234 subject". */
  replayed?: string;
}

const MAX_TEXT_BYTES = 2 * 1024 * 1024;

/** Small stable object id for a mock version (40 hex digits). */
export function mockOid(seed: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < seed.length; i++) {
    h1 = Math.imul(h1 ^ seed.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + seed.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  let out = "";
  let x = h1 ^ h2;
  while (out.length < 40) {
    x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) >>> 0;
    out += x.toString(16).padStart(8, "0");
  }
  return out.slice(0, 40);
}

const stageOid = (c: MockConflict, s: MockStage, n: number): string => s.oid ?? mockOid(`${c.path}:${n}:${s.text ?? s.bytes}`);

/** True when every present version is text (what the Rust `binary` flag negates). */
export function isTextConflict(c: MockConflict): boolean {
  return [c.s1, c.s2, c.s3].every((s) => !s || (s.text !== undefined && s.text.length <= MAX_TEXT_BYTES && !s.text.includes("\0")));
}

const statusOf = (present: boolean, base: boolean): SideStatus => (present ? (base ? "modified" : "added") : base ? "deleted" : "missing");

/** The stage numbers of the user's side and the other side: swapped during a rebase (the one place of the mock). */
export function sideStages(rebasing: boolean): { yours: 2 | 3; theirs: 2 | 3; swapped: boolean } {
  return rebasing ? { yours: 3, theirs: 2, swapped: true } : { yours: 2, theirs: 3, swapped: false };
}

const stageOf = (c: MockConflict, n: 1 | 2 | 3): MockStage | undefined => (n === 1 ? c.s1 : n === 2 ? c.s2 : c.s3);

export function entryOf(c: MockConflict, rebasing: boolean): ConflictEntry {
  const st = sideStages(rebasing);
  const base = !!c.s1;
  return {
    path: c.path,
    oldPath: null,
    ours: statusOf(!!stageOf(c, st.yours), base),
    theirs: statusOf(!!stageOf(c, st.theirs), base),
    binary: !isTextConflict(c),
  };
}

export function versionsOf(c: MockConflict, rebasing: boolean, labels: ConflictLabels): ConflictVersions {
  const st = sideStages(rebasing);
  const blob = (n: 1 | 2 | 3) => {
    const s = stageOf(c, n);
    if (!s) return null;
    const text = s.text !== undefined && s.text.length <= MAX_TEXT_BYTES && !s.text.includes("\0") ? s.text : null;
    return { oid: stageOid(c, s, n), text, bytesLen: s.text !== undefined ? new TextEncoder().encode(s.text).length : (s.bytes ?? 0), binary: text === null };
  };
  return { base: blob(1), ours: blob(st.yours), theirs: blob(st.theirs), labels, swapped: st.swapped, eol: c.eol ?? "lf" };
}

/** The blob id of the user's side, for the stale check of `save_resolution`. */
export function yoursOid(c: MockConflict, rebasing: boolean): string | null {
  const n = sideStages(rebasing).yours;
  const s = stageOf(c, n);
  return s ? stageOid(c, s, n) : null;
}

export function hasStage(c: MockConflict, n: 2 | 3): boolean {
  return !!stageOf(c, n);
}

// ---------------------------------------------------------------- docs-site (merging)

const GETTING_STARTED_BASE = `# Getting started

Install the CLI with your package manager.

## Requirements

- Node 18 or newer
- A GitHub account
- About 200 MB of free disk space

## Configure the site

Set the \`base_url\` in \`config/site.toml\`.
The default theme is \`plain\`.
Run \`docs serve\` to preview the site on port 4000.

## Writing pages

Every page is a Markdown file under \`docs/\`.
Front matter is optional. A page without it gets its title from the first heading.
Images live in \`static/img/\` and are referenced with an absolute path.
Links between pages use the file name without the extension.
Use relative links only inside the same folder.
Code blocks need a language tag to get syntax colours.
Tables are supported, but keep them under six columns.
Admonitions use the \`:::note\` syntax and end with \`:::\`.

## Navigation

The sidebar is built from the folder structure.
A folder needs an \`index.md\` to appear as a section.
Prefix a file with a number to control the order, for example \`01-intro.md\`.
The prefix is removed from the URL.
Hide a page from the sidebar with \`sidebar: false\` in its front matter.
The top bar shows the first five sections. The rest go under "More".
Search results are ranked by title first, then by headings, then by body text.

## Troubleshooting

If the preview does not update, stop the server and start it again.
If an image is missing, check the path and the case of the file name.
If the build fails on a link, the message names the page and the line.
If the search finds nothing, rebuild the index.
Windows users should run the CLI from a terminal inside WSL.
Delete the \`.cache\` folder when the output looks stale.

## Publish

Push to the \`main\` branch. The CI job builds and uploads the site.

## Help

Ask in the #docs channel.
`;

const GETTING_STARTED_OURS = GETTING_STARTED_BASE.replace("your package manager", "npm or pnpm")
  .replace("Node 18 or newer", "Node 20 or newer")
  .replace("Run `docs serve` to preview the site on port 4000.", "Run `docs dev` to preview the site on port 4000.");

const GETTING_STARTED_THEIRS = GETTING_STARTED_BASE.replace("Node 18 or newer", "Node 22 or newer")
  .replace("Run `docs serve` to preview the site on port 4000.", "Run `docs serve` to preview the site on port 8080.")
  .replace("## Help", "## Search\n\nThe search index is rebuilt on every publish.\n\n## Help");

const SITE_TOML_BASE = `title = "Acme Docs"
base_url = "https://docs.acme.dev"
theme = "plain"
search = false

[build]
output = "public"
minify = true
`;

const SITE_TOML_OURS = SITE_TOML_BASE.replace('title = "Acme Docs"', 'title = "Acme Documentation"').replace('theme = "plain"', 'theme = "ocean"');
// Yours changes the title and the theme, Theirs the search flag (next to the theme): "Resolve simple conflicts automatically" merges it.
const SITE_TOML_THEIRS = SITE_TOML_BASE.replace("search = false", "search = true").replace("minify = true", "minify = false");

const CHANGELOG_BASE = `# Changelog 2019

## 2019-11-04
- Initial public release of the docs site.

## 2019-12-17
- Added the dark theme.
`;
const CHANGELOG_THEIRS = CHANGELOG_BASE + "\n## 2019-12-30\n- Moved the old posts to the archive.\n";

export const DOCS_SITE_CONFLICTS: MockConflict[] = [
  { path: "docs/getting-started.md", s1: { text: GETTING_STARTED_BASE }, s2: { text: GETTING_STARTED_OURS }, s3: { text: GETTING_STARTED_THEIRS } },
  { path: "config/site.toml", s1: { text: SITE_TOML_BASE }, s2: { text: SITE_TOML_OURS }, s3: { text: SITE_TOML_THEIRS } },
  // Yours deleted the file, theirs changed it.
  { path: "docs/legacy/changelog-2019.md", s1: { text: CHANGELOG_BASE }, s3: { text: CHANGELOG_THEIRS } },
  { path: "static/img/architecture.png", s1: { bytes: 48_213 }, s2: { bytes: 51_930 }, s3: { bytes: 47_002 } },
];

export const DOCS_SITE_CONTEXT: MockConflictContext = { theirs: "feature/search-docs" };

// ---------------------------------------------------------------- ledger-service (rebasing)

const POSTING_BASE = `use crate::error::LedgerError;
use crate::ledger::entry::Entry;

/// Posts one journal entry and returns its sequence number.
pub fn post(entry: &Entry, db: &Db) -> Result<u64, LedgerError> {
    validate(entry)?;
    let seq = db.next_sequence();
    db.insert(seq, entry)?;
    Ok(seq)
}

fn validate(entry: &Entry) -> Result<(), LedgerError> {
    if entry.lines.is_empty() {
        return Err(LedgerError::Empty);
    }
    Ok(())
}
`;

// Stage 3 of a rebase is the commit being replayed (Yours in the UI).
const POSTING_MINE = POSTING_BASE.replace("Posts one journal entry", "Posts one journal entry, retrying on a lock timeout,")
  .replace("pub fn post(entry: &Entry, db: &Db)", "pub fn post(entry: &Entry, db: &Db, retries: u32)")
  .replace("return Err(LedgerError::Empty);", "return Err(LedgerError::EmptyEntry(entry.id));");

// Stage 2 is the upstream the commit is replayed onto (Theirs in the UI).
const POSTING_UPSTREAM = POSTING_BASE.replace("pub fn post(entry: &Entry, db: &Db)", "pub fn post_entry(entry: &Entry, db: &Db)")
  .replace("return Err(LedgerError::Empty);", "return Err(LedgerError::Empty { id: entry.id });")
  .replace("    Ok(())\n}\n", "    if !entry.is_balanced() {\n        return Err(LedgerError::Unbalanced);\n    }\n    Ok(())\n}\n");

const AUDIT_UPSTREAM = `CREATE TABLE audit_trail (
    id          BIGSERIAL PRIMARY KEY,
    entry_id    BIGINT NOT NULL REFERENCES entries (id),
    actor       TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;
const AUDIT_MINE = `CREATE TABLE audit_trail (
    id          BIGSERIAL PRIMARY KEY,
    entry_id    BIGINT NOT NULL REFERENCES entries (id),
    action      TEXT NOT NULL,
    payload     JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_trail_entry_idx ON audit_trail (entry_id);
`;

export const LEDGER_CONFLICTS: MockConflict[] = [
  { path: "src/ledger/posting.rs", s1: { text: POSTING_BASE }, s2: { text: POSTING_UPSTREAM }, s3: { text: POSTING_MINE } },
  { path: "migrations/0018_audit_trail.sql", s2: { text: AUDIT_UPSTREAM }, s3: { text: AUDIT_MINE } },
];

export const LEDGER_CONTEXT: MockConflictContext = { theirs: "origin/main", replayed: "4c1d9e2 Retry postings on lock timeout" };

// ---------------------------------------------------------------- generic (merge / rebase of a branch named "conflict")

/** Two modify/modify conflicts on the given paths, for a merge or rebase the mock decides to stop. */
export function genericConflicts(paths: string[]): MockConflict[] {
  const base = (name: string) => `// ${name}\nexport const retries = 3;\nexport const timeoutMs = 1000;\n\nexport function describe(): string {\n  return "retries=" + retries;\n}\n`;
  return paths.slice(0, 2).map((path, i) => {
    const b = base(path);
    return i === 0
      ? { path, s1: { text: b }, s2: { text: b.replace("retries = 3", "retries = 5") }, s3: { text: b.replace("retries = 3", "retries = 4").replace("timeoutMs = 1000", "timeoutMs = 2000") } }
      : { path, s1: { text: b }, s2: { text: b.replace("timeoutMs = 1000", "timeoutMs = 1500") }, s3: { text: b.replace('"retries="', '"attempts="') } };
  });
}
