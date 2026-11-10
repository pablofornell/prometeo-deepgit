/**
 * Icon set: inline 16x16 SVG, 1 px stroke, round caps/joins, `currentColor` (DESIGN.md section 6).
 * Shapes follow the JetBrains expui style; the common ones are taken from docs/design/mockup.html,
 * the others are drawn here (no third-party artwork is bundled).
 * Add an icon by adding a key; `IconName` updates automatically.
 */
const ICONS = {
  // ---- git objects
  branch: `<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 3-7 2-7 4"/>`,
  branchCurrent: `<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5" fill="currentColor"/><path d="M4.5 5v6M11.5 7c0 3-7 2-7 4"/>`,
  remote: `<path d="M4.5 12.5h7a3 3 0 0 0 .4-6 4 4 0 0 0-7.7 1A2.5 2.5 0 0 0 4.5 12.5Z"/>`,
  tag: `<path d="M2.5 2.5h5l6 6-5 5-6-6Z"/><circle cx="5.5" cy="5.5" r="1"/>`,
  stash: `<path d="M2.5 5.5h11v7a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1Z"/><path d="M1.5 2.5h13v3h-13Z"/><path d="M6.5 8.5h3"/>`,
  submodule: `<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><rect x="5.5" y="5.5" width="5" height="5" rx=".5"/>`,
  commit: `<circle cx="8" cy="8" r="2.5"/><path d="M1.5 8h4M10.5 8h4"/>`,
  merge: `<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="9" r="1.5"/><path d="M4.5 5v6M4.5 5c0 3 7 1.5 7 4"/>`,
  repo: `<path d="M3.5 2.5h8a1 1 0 0 1 1 1v10h-8.5a.5.5 0 0 1 0-2H12.5"/><path d="M3.5 2.5v10.5"/><path d="M6 5.5h4"/>`,
  project: `<path d="M2.5 13.5v-10h4l1.5 1.5h5.5v8.5Z"/><path d="M2.5 7.5h11"/>`,
  detachedHead: `<circle cx="8" cy="8" r="2.5"/><path d="M1.5 8h4M10.5 8h4" stroke-dasharray="1.6 1.4"/>`,
  // ---- git actions
  fetch: `<path d="M8 2.5v7M5 7l3 3 3-3"/><path d="M2.5 11.5v2h11v-2" stroke-dasharray="1.6 1.4"/>`,
  pull: `<path d="M8 2.5v8.5M4.5 7.5 8 11l3.5-3.5"/><path d="M3 13.5h10"/>`,
  push: `<path d="M8 13.5V5M4.5 8.5 8 5l3.5 3.5"/><path d="M3 2.5h10"/>`,
  checkout: `<path d="M2.5 8h8M7.5 4.5 11 8l-3.5 3.5"/><path d="M13.5 2.5v11"/>`,
  cherryPick: `<circle cx="5" cy="11" r="2.5"/><circle cx="11" cy="11.5" r="2"/><path d="M5 8.5C6 5 8 3 11 2.5M11 9.5c0-3-1-5.5 0-7"/>`,
  revert: `<path d="M5 3.5 2.5 6 5 8.5"/><path d="M2.5 6h6a4 4 0 0 1 0 8H6"/>`,
  reset: `<path d="M3 8a5 5 0 1 0 1.6-3.7"/><path d="M3 2.5v3h3"/>`,
  rebase: `<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="6.5" r="1.5"/><path d="M4.5 5v6M11.5 8v1.5a2 2 0 0 1-2 2H7"/><path d="m8.5 9.5-1.5 2 1.5 1.5"/>`,
  stashPush: `<path d="M2.5 6.5h11v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1Z"/><path d="M1.5 3.5h13v3h-13Z"/><path d="M8 12V8.5M6.2 10.2 8 8.5l1.8 1.7" transform="translate(0 0)"/>`,
  stashPop: `<path d="M2.5 6.5h11v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1Z"/><path d="M1.5 3.5h13v3h-13Z"/><path d="M8 8.5V12M6.2 10.3 8 12l1.8-1.7"/>`,
  newBranch: `<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><path d="M4.5 5v6M10.5 4v5M8 6.5h5"/>`,
  delete: `<path d="M3 4.5h10M6.5 4.5v-2h3v2M4.5 4.5l.6 8.5a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.5"/><path d="M6.8 7v4M9.2 7v4"/>`,
  rename: `<path d="M3 13h2.5l7-7a1.2 1.2 0 0 0 0-1.7l-.8-.8a1.2 1.2 0 0 0-1.7 0l-7 7Z"/><path d="m9.5 4.5 2 2"/>`,
  edit: `<path d="M3 13h2.5l7-7a1.2 1.2 0 0 0 0-1.7l-.8-.8a1.2 1.2 0 0 0-1.7 0l-7 7Z"/><path d="m9.5 4.5 2 2"/>`,
  undo: `<path d="M5 3.5 2.5 6 5 8.5"/><path d="M2.5 6h7a3.5 3.5 0 0 1 0 7H6"/>`,
  // ---- files
  file: `<path d="M3.5 1.5h6l3 3v10h-9Z"/><path d="M9.5 1.5v3h3"/>`,
  folder: `<path d="M1.5 4.5v8a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1H8L6.5 3.5h-4a1 1 0 0 0-1 1Z"/>`,
  folderOpen: `<path d="M1.5 12.5v-8a1 1 0 0 1 1-1h4L8 5h5.5a1 1 0 0 1 1 1v1.5"/><path d="M1.5 12.5 3.3 8h11.7l-2 4.5a1 1 0 0 1-.9.5H2.5a1 1 0 0 1-1-.5Z"/>`,
  fileRust: `<circle cx="8" cy="8" r="5.5"/><path d="M5.5 11V5.5h3a1.3 1.3 0 0 1 0 2.6h-3M8.5 8.1l2 2.9"/>`,
  fileTs: `<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M5 7h3M6.5 7v4.5M10.8 7.3c-.5-.4-1.7-.4-1.9.3-.2 1 2.1.9 1.9 2-.2.8-1.5.8-2.1.2"/>`,
  fileJs: `<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M7.5 6.5v4a1 1 0 0 1-2 0M12 7.3c-.5-.4-1.7-.4-1.9.3-.2 1 2.1.9 1.9 2-.2.8-1.5.8-2.1.2"/>`,
  fileJson: `<path d="M6 2.5c-1.5 0-1.5 1-1.5 2v1.5c0 1-.5 2-1.5 2 1 0 1.5 1 1.5 2V11c0 1 0 2 1.5 2M10 2.5c1.5 0 1.5 1 1.5 2v1.5c0 1 .5 2 1.5 2-1 0-1.5 1-1.5 2V11c0 1 0 2-1.5 2"/>`,
  fileToml: `<path d="M3.5 1.5h6l3 3v10h-9Z"/><path d="M5.5 8h5M8 8v4"/>`,
  fileYaml: `<path d="M3.5 1.5h6l3 3v10h-9Z"/><path d="m5.5 7 2.5 2.5L10.5 7M8 9.5V12"/>`,
  fileMd: `<rect x="1.5" y="3.5" width="13" height="9" rx="1.5"/><path d="M4 10V6l2 2.5L8 6v4M11.5 6v4M10 8.5l1.5 1.5L13 8.5"/>`,
  fileSql: `<ellipse cx="8" cy="4" rx="5" ry="2"/><path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2"/>`,
  fileImage: `<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><circle cx="5.5" cy="6" r="1"/><path d="m2 12.5 4-4 3 3 2-2 3.5 3"/>`,
  fileBinary: `<path d="M3.5 1.5h6l3 3v10h-9Z"/><path d="M6 8v3M6 8.2h.1M9.5 8v3M8.5 8.5v2"/>`,
  // ---- view
  log: `<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><path d="M4.5 5v6M8.5 3.5h5M8.5 8h5M8.5 12.5h5"/>`,
  changes: `<path d="M3.5 1.5h6l3 3v10h-9Z"/><path d="M6 8h4M8 6v4M6 12h4"/>`,
  matrix: `<rect x="2" y="2" width="3" height="3" rx=".5"/><rect x="6.5" y="2" width="3" height="3" rx=".5"/><rect x="11" y="2" width="3" height="3" rx=".5"/><rect x="2" y="6.5" width="3" height="3" rx=".5"/><rect x="6.5" y="6.5" width="3" height="3" rx=".5"/><rect x="2" y="11" width="3" height="3" rx=".5"/><rect x="11" y="11" width="3" height="3" rx=".5"/>`,
  console: `<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="m4.5 6 2 2-2 2M8 10.5h3.5"/>`,
  tree: `<path d="M2.5 3.5h4M5.5 8h4M5.5 12.5h4M3.5 3.5v9h2M3.5 8h2"/><path d="M11.5 8h2M11.5 12.5h2"/>`,
  list: `<path d="M2.5 4h11M2.5 8h11M2.5 12h11"/>`,
  sideBySide: `<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M8 2.5v11M3.5 6h3M9.5 6h3M3.5 9h2M9.5 9h3"/>`,
  unified: `<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M4 6h8M4 9h6"/>`,
  eye: `<path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/>`,
  palette: `<circle cx="8" cy="8" r="6"/><circle cx="5.5" cy="6.5" r=".8"/><circle cx="8.5" cy="5" r=".8"/><circle cx="10.8" cy="7.5" r=".8"/><path d="M8 14a1.5 1.5 0 0 1 0-3h1"/>`,
  collapse: `<path d="m4.5 6.5 3.5-3 3.5 3M4.5 9.5l3.5 3 3.5-3"/>`,
  expand: `<path d="m4.5 5.5 3.5 3 3.5-3M4.5 10.5 8 13.5l3.5-3" transform="translate(0 -1.5)"/>`,
  // ---- navigation
  chevronDown: `<path d="m4.5 6.5 3.5 3.5 3.5-3.5"/>`,
  chevronRight: `<path d="m6.5 4.5 3.5 3.5-3.5 3.5"/>`,
  chevronUp: `<path d="m4.5 9.5 3.5-3.5 3.5 3.5"/>`,
  chevronLeft: `<path d="m9.5 4.5-3.5 3.5 3.5 3.5"/>`,
  arrowUp: `<path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7"/>`,
  arrowDown: `<path d="M8 3.5v9M4.5 9 8 12.5 11.5 9"/>`,
  arrowRight: `<path d="M3.5 8h9M9 4.5 12.5 8 9 11.5"/>`,
  search: `<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>`,
  filter: `<path d="M2.5 3.5h11l-4.5 5v4l-2 1v-5Z"/>`,
  close: `<path d="m4 4 8 8M12 4l-8 8"/>`,
  more: `<circle cx="3.5" cy="8" r=".8"/><circle cx="8" cy="8" r=".8"/><circle cx="12.5" cy="8" r=".8"/>`,
  plus: `<path d="M8 3v10M3 8h10"/>`,
  minus: `<path d="M3 8h10"/>`,
  refresh: `<path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2.5v3h-3"/>`,
  externalLink: `<path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5"/><path d="M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/>`,
  copy: `<rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>`,
  // ---- people / time
  user: `<circle cx="8" cy="5.5" r="2.5"/><path d="M3 13.5a5 5 0 0 1 10 0"/>`,
  calendar: `<rect x="2.5" y="3.5" width="11" height="10" rx="1"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/>`,
  path: `<path d="M2.5 13.5l4-11M8.5 13.5h5M8.5 10h5"/>`,
  // ---- status
  check: `<path d="m3 8.5 3.2 3L13 4.5"/>`,
  warning: `<path d="M8 2 14.5 13.5h-13Z"/><path d="M8 6.5v3.5M8 11.6v.4"/>`,
  error: `<circle cx="8" cy="8" r="6"/><path d="m5.8 5.8 4.4 4.4M10.2 5.8l-4.4 4.4"/>`,
  info: `<circle cx="8" cy="8" r="6"/><path d="M8 7v4.5M8 4.8v.4"/>`,
  progress: `<path d="M8 2a6 6 0 1 0 6 6"/>`,
  conflict: `<path d="M3 3.5c3 0 2 4.5 5 4.5M3 12.5c3 0 2-4.5 5-4.5M8 8h5.5"/><path d="m11.5 6 2 2-2 2"/>`,
  // ---- window
  minimize: `<path d="M4 8h8"/>`,
  maximize: `<rect x="4" y="4" width="8" height="8" rx="1"/>`,
  restore: `<rect x="3.5" y="5.5" width="7" height="7" rx="1"/><path d="M5.5 5.5v-1a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-1"/>`,
  // settings: a cog (8 teeth and a hole), never rays: rays are the sun of the light theme
  gear: `<path d="M6.73 3.27L6.98 1.58L9.02 1.58L9.27 3.27A4.9 4.9 0 0 1 10.45 3.76L11.82 2.74L13.26 4.18L12.24 5.55A4.9 4.9 0 0 1 12.73 6.73L14.42 6.98L14.42 9.02L12.73 9.27A4.9 4.9 0 0 1 12.24 10.45L13.26 11.82L11.82 13.26L10.45 12.24A4.9 4.9 0 0 1 9.27 12.73L9.02 14.42L6.98 14.42L6.73 12.73A4.9 4.9 0 0 1 5.55 12.24L4.18 13.26L2.74 11.82L3.76 10.45A4.9 4.9 0 0 1 3.27 9.27L1.58 9.02L1.58 6.98L3.27 6.73A4.9 4.9 0 0 1 3.76 5.55L2.74 4.18L4.18 2.74L5.55 3.76A4.9 4.9 0 0 1 6.73 3.27Z"/><circle cx="8" cy="8" r="2"/>`,
  // ---- theme: sun (light), crescent moon (dark), half-filled circle (follow the system)
  themeLight: `<circle cx="8" cy="8" r="2.5"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.06 1.06M11.54 11.54l1.06 1.06M3.4 12.6l1.06-1.06M11.54 4.46l1.06-1.06"/>`,
  themeDark: `<path d="M13 9.6A5.5 5.5 0 1 1 6.4 3a4.4 4.4 0 0 0 6.6 6.6Z"/>`,
  themeSystem: `<circle cx="8" cy="8" r="5.5"/><path d="M8 2.5a5.5 5.5 0 0 1 0 11Z" fill="currentColor"/>`,
  bell: `<path d="M4 11.5V7a4 4 0 0 1 8 0v4.5l1 1H3Z"/><path d="M6.5 14h3"/>`,
} as const;

export type IconName = keyof typeof ICONS;

/** Icon of a theme choice: sun, crescent moon, half-filled circle. */
export const THEME_ICONS: Record<"dark" | "light" | "system", IconName> = { dark: "themeDark", light: "themeLight", system: "themeSystem" };

/** Inner SVG markup of an icon (16x16 viewBox). */
export function iconMarkup(name: IconName): string {
  return ICONS[name];
}

export const iconNames = Object.keys(ICONS) as IconName[];

/** File-type icon for a path (by extension / well-known name). */
export function fileIconFor(path: string): IconName {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
  switch (ext) {
    case "rs": return "fileRust";
    case "ts": case "tsx": return "fileTs";
    case "js": case "jsx": case "mjs": case "cjs": return "fileJs";
    case "json": return "fileJson";
    case "toml": return "fileToml";
    case "yml": case "yaml": return "fileYaml";
    case "md": case "mdx": return "fileMd";
    case "sql": return "fileSql";
    case "png": case "jpg": case "jpeg": case "gif": case "svg": case "webp": case "ico": return "fileImage";
    case "bin": case "wasm": case "zip": case "gz": case "so": case "dll": case "exe": return "fileBinary";
    default: return "file";
  }
}
