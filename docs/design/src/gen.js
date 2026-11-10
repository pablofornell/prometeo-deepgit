// Generates docs/design/mockup.html as a fully static, self-contained HTML file (no JS at runtime).
const fs = require('fs');
const path = require('path');
const OUT = path.resolve(__dirname, '..');
const FONTS = path.resolve(__dirname, '../../../src/theme/fonts');
const tokens = fs.readFileSync(path.join(OUT, 'tokens.css'), 'utf8');
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------------------------------------------------------------- icons (16x16, expui style: 1px strokes)
const ICONS = {
  branch: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 3-7 2-7 4"/>',
  fetch: '<path d="M8 2.5v7M5 7l3 3 3-3"/><path d="M2.5 11.5v2h11v-2" stroke-dasharray="1.6 1.4"/>',
  pull: '<path d="M8 2.5v8.5M4.5 7.5 8 11l3.5-3.5"/><path d="M3 13.5h10"/>',
  push: '<path d="M8 13.5V5M4.5 8.5 8 5l3.5 3.5"/><path d="M3 2.5h10"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>',
  chevD: '<path d="m4.5 6.5 3.5 3.5 3.5-3.5"/>',
  chevR: '<path d="m6.5 4.5 3.5 3.5-3.5 3.5"/>',
  folder: '<path d="M1.5 4.5v8a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1H8L6.5 3.5h-4a1 1 0 0 0-1 1Z"/>',
  repo: '<path d="M3.5 2.5h8a1 1 0 0 1 1 1v10h-8.5a.5.5 0 0 1 0-2H12.5"/><path d="M3.5 2.5v10.5"/><path d="M6 5.5h4"/>',
  tag: '<path d="M2.5 2.5h5l6 6-5 5-6-6Z"/><circle cx="5.5" cy="5.5" r="1"/>',
  stash: '<path d="M2.5 5.5h11v7a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1Z"/><path d="M1.5 2.5h13v3h-13Z"/><path d="M6.5 8.5h3"/>',
  submodule: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><rect x="5.5" y="5.5" width="5" height="5" rx=".5"/>',
  remote: '<path d="M4.5 12.5h7a3 3 0 0 0 .4-6 4 4 0 0 0-7.7 1A2.5 2.5 0 0 0 4.5 12.5Z"/>',
  commit: '<circle cx="8" cy="8" r="2.5"/><path d="M1.5 8h4M10.5 8h4"/>',
  gear: '<circle cx="8" cy="8" r="2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>',
  bell: '<path d="M4 11.5V7a4 4 0 0 1 8 0v4.5l1 1H3Z"/><path d="M6.5 14h3"/>',
  console: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="m4.5 6 2 2-2 2M8 10.5h3.5"/>',
  close: '<path d="m4 4 8 8M12 4l-8 8"/>',
  min: '<path d="M4 8h8"/>',
  max: '<rect x="4" y="4" width="8" height="8" rx="1"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2.5v3h-3"/>',
  filter: '<path d="M2.5 3.5h11l-4.5 5v4l-2 1v-5Z"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>',
  check: '<path d="m3 8.5 3.2 3L13 4.5"/>',
  warn: '<path d="M8 2 14.5 13.5h-13Z"/><path d="M8 6.5v3.5M8 11.6v.4"/>',
  info: '<circle cx="8" cy="8" r="6"/><path d="M8 7v4.5M8 4.8v.4"/>',
  tree: '<path d="M2.5 3.5h4M5.5 8h4M5.5 12.5h4M3.5 3.5v9h2M3.5 8h2"/><path d="M11.5 8h2M11.5 12.5h2"/>',
  list: '<path d="M2.5 4h11M2.5 8h11M2.5 12h11"/>',
  sbs: '<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M8 2.5v11M3.5 6h3M9.5 6h3M3.5 9h2M9.5 9h3"/>',
  unified: '<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M4 6h8M4 9h6"/>',
  up: '<path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7"/>',
  down: '<path d="M8 3.5v9M4.5 9 8 12.5 11.5 9"/>',
  more: '<circle cx="3.5" cy="8" r=".8"/><circle cx="8" cy="8" r=".8"/><circle cx="12.5" cy="8" r=".8"/>',
  matrix: '<rect x="2" y="2" width="3" height="3" rx=".5"/><rect x="6.5" y="2" width="3" height="3" rx=".5"/><rect x="11" y="2" width="3" height="3" rx=".5"/><rect x="2" y="6.5" width="3" height="3" rx=".5"/><rect x="6.5" y="6.5" width="3" height="3" rx=".5"/><rect x="2" y="11" width="3" height="3" rx=".5"/><rect x="11" y="11" width="3" height="3" rx=".5"/>',
  project: '<path d="M2.5 13.5v-10h4l1.5 1.5h5.5v8.5Z"/><path d="M2.5 7.5h11"/>',
  log: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><path d="M4.5 5v6M8.5 3.5h5M8.5 8h5M8.5 12.5h5"/>',
  changes: '<path d="M3.5 1.5h6l3 3v10h-9Z"/><path d="M6 8h4M8 6v4M6 12h4"/>',
  eye: '<path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/>',
  path: '<path d="M2.5 13.5l4-11M8.5 13.5h5M8.5 10h5"/>',
  user: '<circle cx="8" cy="5.5" r="2.5"/><path d="M3 13.5a5 5 0 0 1 10 0"/>',
  cal: '<rect x="2.5" y="3.5" width="11" height="10" rx="1"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/>',
  palette: '<circle cx="8" cy="8" r="6"/><circle cx="5.5" cy="6.5" r=".8"/><circle cx="8.5" cy="5" r=".8"/><circle cx="10.8" cy="7.5" r=".8"/><path d="M8 14a1.5 1.5 0 0 1 0-3h1"/>',
  file: '<path d="M3.5 1.5h6l3 3v10h-9Z"/><path d="M9.5 1.5v3h3"/>',
  rust: '<circle cx="8" cy="8" r="5.5"/><path d="M5.5 11V5.5h3a1.3 1.3 0 0 1 0 2.6h-3M8.5 8.1l2 2.9"/>',
  sql: '<ellipse cx="8" cy="4" rx="5" ry="2"/><path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2"/>',
  toml: '<path d="M3.5 1.5h6l3 3v10h-9Z"/><path d="M5.5 8h5M8 8v4"/>',
  cherry: '<circle cx="5" cy="11" r="2.5"/><circle cx="11" cy="11.5" r="2"/><path d="M5 8.5C6 5 8 3 11 2.5M11 9.5c0-3-1-5.5 0-7"/>',
};
const ic = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 16 16" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const sprite = `<svg width="0" height="0" style="position:absolute" aria-hidden="true">${Object.entries(ICONS).map(([k, v]) => `<symbol id="i-${k}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">${v}</symbol>`).join('')}</svg>`;

// ---------------------------------------------------------------- data
const R = {
  'api-gateway': 4, 'ledger-service': 0, 'refunds-worker': 2, 'web-checkout': 5, 'shared-proto': 1,
  'auth-service': 3, 'notifications': 6, 'risk-engine': 10, 'merchant-portal': 11, 'infra-terraform': 8, 'docs-site': 9, 'sdk-typescript': 7,
};
const rc = r => `var(--dg-repo-${R[r]})`;
const AV = { 'Lucía Martín': ['LM', 4], 'Noah Fischer': ['NF', 1], 'Priya Raman': ['PR', 3], 'Marta Kowalski': ['MK', 2], 'Jonas Berg': ['JB', 0] };
const avatar = (n, big) => `<span class="av${big ? ' av-lg' : ''}" style="background:var(--dg-avatar-${AV[n][1]})">${AV[n][0]}</span>`;

// rows: kind, repo, lane, subject, refs, author, date, hash
const ROWS = [
  { k: 'wip', lane: 0, repo: 'api-gateway' },
  { k: 'date', label: 'Today' },
  { repo: 'api-gateway', lane: 0, s: 'Add idempotency key to refund endpoint', refs: [['headcur', 'feature/PAY-2318-refunds']], a: 'Lucía Martín', d: '10:42', h: '9f3c2a1', head: true, sel: true },
  { repo: 'ledger-service', lane: 4, s: 'Persist refund ledger entries in one transaction', refs: [['sync', 'feature/PAY-2318-refunds']], a: 'Lucía Martín', d: '10:31', h: '4e1b07d' },
  { repo: 'api-gateway', lane: 0, s: 'Validate partial refund amounts against capture', a: 'Lucía Martín', d: '10:05', h: 'c71d9e4' },
  { repo: 'web-checkout', lane: 6, s: 'Show refund status in the order timeline', refs: [['sync', 'main']], a: 'Noah Fischer', d: '09:58', h: '2b8f6a0' },
  { repo: 'api-gateway', lane: 0, s: 'Wire RefundController to the ledger client', refs: [['remote', 'origin/feature/PAY-2318-refunds']], a: 'Lucía Martín', d: '09:12', h: 'a03e5f7', hover: true },
  { repo: 'refunds-worker', lane: 5, s: 'Retry webhook delivery with exponential backoff', refs: [['sync', 'main'], ['tag', 'v2.4.0']], a: 'Priya Raman', d: '08:47', h: '5d6c1b9' },
  { repo: 'api-gateway', lane: 1, s: 'Merge pull request #1287 from chore/bump-axum-0.8', refs: [['sync', 'main']], a: 'Marta Kowalski', d: '08:20', h: 'e8a4c33', merge: true },
  { repo: 'api-gateway', lane: 2, s: 'Bump axum to 0.8 and tower-http to 0.6', a: 'Marta Kowalski', d: '08:02', h: '77b1d0e' },
  { k: 'date', label: 'Yesterday' },
  { repo: 'ledger-service', lane: 3, s: 'Use banker’s rounding for minor units', refs: [['sync', 'main'], ['tag', 'v1.19.2']], a: 'Jonas Berg', d: '18:14', h: 'd4f9a82' },
  { repo: 'api-gateway', lane: 0, s: 'Add Refund domain types and error mapping', a: 'Lucía Martín', d: '17:40', h: '3c0e9b5' },
  { repo: 'api-gateway', lane: 1, s: 'Rate-limit /v1/payments by merchant key', a: 'Marta Kowalski', d: '16:55', h: 'f12ac0d' },
  { repo: 'api-gateway', lane: 1, s: 'Release 3.12.0', refs: [['tag', 'v3.12.0']], a: 'Marta Kowalski', d: '15:30', h: '6ab7e21' },
  { repo: 'ledger-service', lane: 4, s: 'Add refund_entries table migration', a: 'Lucía Martín', d: '14:22', h: '0e7f3d6' },
  { repo: 'shared-proto', lane: 7, s: 'Add RefundRequested and RefundSettled events', refs: [['sync', 'main'], ['tag', 'v0.31.0']], a: 'Priya Raman', d: '13:10', h: '8b2e4f1' },
  { repo: 'ledger-service', lane: 3, s: 'Bump sqlx to 0.8.2', a: 'Jonas Berg', d: '11:48', h: '1f9a6c2' },
  { repo: 'web-checkout', lane: 6, s: 'Extract Money component from CartSummary', a: 'Noah Fischer', d: '11:02', h: 'c4d8e19' },
  { repo: 'refunds-worker', lane: 5, s: 'Add refund settlement consumer', a: 'Priya Raman', d: '10:15', h: '9e0a7b3' },
  { repo: 'api-gateway', lane: 1, s: 'Log request ids in tracing spans', a: 'Marta Kowalski', d: '09:40', h: '2d7e8f0' },
];
const LANE_REPO = ['api-gateway', 'api-gateway', 'api-gateway', 'ledger-service', 'ledger-service', 'refunds-worker', 'web-checkout', 'shared-proto'];
const ROW_H = 24, LANE_W = 14, LANE_X0 = 14;
const lx = l => LANE_X0 + l * LANE_W;
const ry = i => i * ROW_H + ROW_H / 2;
const N = ROWS.length;
const BOTTOM = N * ROW_H;

function graphSvg() {
  const parts = [];
  const line = (l, y1, y2, extra = '') => parts.push(`<path d="M${lx(l)} ${y1}V${y2}" stroke="${rc(LANE_REPO[l])}" ${extra}/>`);
  const curve = (l1, y1, l2, y2) => { // smooth S-curve from lane l1 at y1 to lane l2 at y2
    const my = (y1 + y2) / 2;
    parts.push(`<path d="M${lx(l1)} ${y1}C${lx(l1)} ${my} ${lx(l2)} ${my} ${lx(l2)} ${y2}" stroke="${rc(LANE_REPO[l1 === 1 && l2 === 2 ? 2 : l1])}"/>`);
  };
  // L0 api-gateway feature: dashed WIP r0->r2, solid r2..r13, curve r13->r14 into L1
  line(0, ry(0), ry(2), 'stroke-dasharray="3 3" opacity=".75"');
  line(0, ry(2), ry(13));
  curve(0, ry(13), 1, ry(14));
  // L1 api-gateway main: r8 -> bottom
  line(1, ry(8), BOTTOM);
  // merge r8 -> L2 r9, L2 r9..r12, curve r12->r13 into L1
  curve(1, ry(8), 2, ry(9));
  line(2, ry(9), ry(12));
  curve(2, ry(12), 1, ry(13));
  // L3 ledger main: r11 -> bottom
  line(3, ry(11), BOTTOM);
  // L4 ledger feature: r3..r16, curve r16->r17 into L3
  line(4, ry(3), ry(16));
  curve(4, ry(16), 3, ry(17));
  // L5 refunds: r7 -> bottom ; L6 web: r5 -> bottom ; L7 proto: r16 -> bottom
  line(5, ry(7), BOTTOM);
  line(6, ry(5), BOTTOM);
  line(7, ry(16), BOTTOM);
  // nodes
  ROWS.forEach((r, i) => {
    if (r.k === 'date') return;
    const x = lx(r.lane), y = ry(i), c = rc(r.repo);
    if (r.k === 'wip') { parts.push(`<circle cx="${x}" cy="${y}" r="4" fill="var(--dg-island-bg)" stroke="var(--dg-graph-wip-stroke)" stroke-width="1.5" stroke-dasharray="2 1.6"/>`); return; }
    if (r.head) {
      parts.push(`<circle cx="${x}" cy="${y}" r="7" fill="none" stroke="${c}" stroke-opacity=".35" stroke-width="2"/>`);
      parts.push(`<circle cx="${x}" cy="${y}" r="4.5" fill="${c}" stroke="var(--dg-graph-node-stroke)" stroke-width="1.5"/>`);
      return;
    }
    if (r.merge) { parts.push(`<circle cx="${x}" cy="${y}" r="4" fill="var(--dg-island-bg)" stroke="${c}" stroke-width="2"/>`); return; }
    parts.push(`<circle cx="${x}" cy="${y}" r="4" fill="${c}" stroke="var(--dg-graph-node-stroke)" stroke-width="1.5"/>`);
  });
  return `<svg class="graph" width="130" height="${BOTTOM}" viewBox="0 0 130 ${BOTTOM}" fill="none" stroke-width="2" stroke-linecap="round">${parts.join('')}</svg>`;
}

const pill = ([t, label]) => {
  if (t === 'head') return `<span class="ref ref-head">HEAD</span>`;
  if (t === 'headcur') return `<span class="ref ref-split"><span class="ref-head">HEAD</span><span class="ref-cur">${ic('branch')}<span class="rl">${esc(label)}</span></span></span>`;
  if (t === 'sync') return `<span class="ref ref-local" title="${esc(label)} and origin/${esc(label)}">${ic('branch')}<span class="rl">${esc(label)}</span><svg class="ic sync-ic" viewBox="0 0 16 16"><use href="#i-remote"/></svg></span>`;
  const icon = t === 'tag' ? 'tag' : t === 'remote' ? 'remote' : 'branch';
  return `<span class="ref ref-${t}">${ic(icon)}<span class="rl">${esc(label)}</span></span>`;
};
function refsHtml(refs = []) {
  if (!refs.length) return '';
  const shown = refs.slice(0, 2).map(pill).join('');
  const more = refs.length > 2 ? `<span class="ref ref-more">+${refs.length - 2}</span>` : '';
  return `<span class="refs">${shown}${more}</span>`;
}
function logRows() {
  return ROWS.map(r => {
    if (r.k === 'date') return `<div class="lrow lrow-date"><span class="spine"></span><span class="c-graph"></span><span class="date-label">${r.label}</span></div>`;
    if (r.k === 'wip') return `<div class="lrow lrow-wip"><span class="spine spine-multi"></span><span class="c-graph"></span>
      <span class="c-subj"><span class="wip-t">Uncommitted changes</span><span class="wip-n">14 files in 3 repos</span></span>
      <span class="c-repo"><span class="dots"><i style="background:${rc('api-gateway')}"></i><i style="background:${rc('ledger-service')}"></i><i style="background:${rc('web-checkout')}"></i></span><span class="muted">3 repos</span></span>
      <span class="c-auth"></span><span class="c-date muted">now</span><span class="c-hash"></span></div>`;
    const cls = ['lrow', r.sel && 'is-sel', r.hover && 'is-hover', r.head && 'is-head'].filter(Boolean).join(' ');
    return `<div class="${cls}"><span class="spine" style="background:${rc(r.repo)}"></span><span class="c-graph"></span>
      <span class="c-subj"><span class="subj">${esc(r.s)}</span>${refsHtml(r.refs)}</span>
      <span class="c-repo"><span class="rchip" style="--rc:${rc(r.repo)}">${r.repo}</span></span>
      <span class="c-auth">${avatar(r.a)}<span class="aname">${r.a}</span></span>
      <span class="c-date">${r.d}</span><span class="c-hash">${r.h}</span></div>`;
  }).join('\n');
}

// ---------------------------------------------------------------- sidebar
function capsule(up, down) {
  if (!up && !down) return '';
  return `<span class="ab${up && down ? ' ab-div' : ''}">${up ? `<span class="ab-up">↑${up}</span>` : ''}${down ? `<span class="ab-down">↓${down}</span>` : ''}</span>`;
}
const state = s => s === 'dirty' ? '<span class="st st-dirty" title="Uncommitted changes"></span>' : s === 'conflict' ? '<span class="st st-conflict" title="Rebase in progress"></span>' : '<span class="st st-clean"></span>';
const REPOS = [
  ['api-gateway', 'feature/PAY-2318-refunds', 3, 0, 'dirty', true],
  ['ledger-service', 'rebasing 3/7', 1, 0, 'conflict'],
  ['refunds-worker', 'main', 0, 2, 'clean'],
  ['web-checkout', 'main', 0, 0, 'dirty'],
  ['shared-proto', 'main', 0, 0, 'clean'],
  ['auth-service', 'main', 0, 0, 'clean', false, true],
  ['notifications', 'main', 0, 4, 'clean', false, true],
  ['risk-engine', 'feature/PAY-2318-refunds', 0, 0, 'clean', false, true],
  ['merchant-portal', 'develop', 2, 1, 'clean', false, true],
  ['infra-terraform', 'main', 0, 0, 'clean', false, true],
  ['docs-site', 'main', 0, 0, 'clean', false, true],
  ['sdk-typescript', 'release/4.x', 0, 0, 'clean', false, true],
];
function repoRow([name, br, up, down, st, open, hidden]) {
  return `<div class="trow repo-row${open ? ' is-open' : ''}${hidden ? ' is-filtered' : ''}">
    ${ic(open ? 'chevD' : 'chevR', 'chev')}<span class="rsq" style="background:${rc(name)}"></span>
    <span class="rname">${name}</span><span class="rbranch${st === 'conflict' ? ' is-conflict' : ''}">${esc(br)}</span>${capsule(up, down)}${state(st)}</div>`;
}
const t = (depth, html, cls = '') => `<div class="trow ${cls}" style="--d:${depth}">${html}</div>`;
function sidebar() {
  const api = [
    t(1, `${ic('chevD', 'chev')}${ic('branch', 'ic-sec')}<span>Local</span><span class="cnt">4</span>`),
    t(2, `${ic('branch', 'ic-cur')}<span class="b-cur">feature/PAY-2318-refunds</span>${capsule(3, 0)}`, 'is-sel'),
    t(2, `${ic('branch', 'ic-sec')}<span>main</span>`),
    t(2, `${ic('branch', 'ic-sec')}<span>chore/bump-axum-0.8</span><span class="gone">gone</span>`),
    t(2, `${ic('branch', 'ic-sec')}<span>spike/grpc-gateway</span>${capsule(0, 12)}`),
    t(1, `${ic('chevD', 'chev')}${ic('remote', 'ic-sec')}<span>origin</span><span class="cnt">9</span>`),
    t(2, `${ic('branch', 'ic-sec')}<span>feature/PAY-2318-refunds</span>`),
    t(2, `${ic('branch', 'ic-sec')}<span>main</span>`),
    t(2, `<span class="more-link">6 more…</span>`),
    t(1, `${ic('chevR', 'chev')}${ic('tag', 'ic-sec')}<span>Tags</span><span class="cnt">38</span>`),
    t(1, `${ic('chevR', 'chev')}${ic('stash', 'ic-sec')}<span>Stashes</span><span class="cnt">2</span>`),
    t(1, `${ic('chevR', 'chev')}${ic('submodule', 'ic-sec')}<span>Submodules</span><span class="cnt">1</span>`),
  ].join('');
  return `
  <div class="ihead"><span class="ititle">Project</span><span class="sp"></span>
    <button class="ib" title="Fetch all repositories">${ic('fetch')}</button><button class="ib" title="Add repository">${ic('plus')}</button><button class="ib">${ic('more')}</button></div>
  <div class="proj">
    <span class="proj-ic">${ic('project')}</span>
    <span class="proj-txt"><b>payments-platform</b><span>~/work/payments-platform · 12 repositories</span></span>
  </div>
  <div class="sync">
    <div class="sync-top">${ic('matrix')}<span class="sync-name"><b>feature/PAY-2318-refunds</b></span><a>Matrix</a></div>
    <div class="sync-bar">${REPOS.map(([n, br]) => `<i title="${n}" class="${br.startsWith('feature/PAY-2318') || n === 'ledger-service' ? 'on' : br === 'main' && (n === 'refunds-worker' || n === 'web-checkout') ? 'remote' : ''}" style="--rc:${rc(n)}"></i>`).join('')}</div>
    <div class="sync-foot"><span><i class="lg on"></i>3 current</span><span><i class="lg remote"></i>2 on origin</span><span><i class="lg"></i>7 missing</span></div>
  </div>
  <div class="tree">
    <div class="tsec"><span>Repositories</span><span class="tsec-f">5 of 12 shown in log</span></div>
    ${repoRow(REPOS[0])}${api}
    ${REPOS.slice(1).map(repoRow).join('')}
  </div>`;
}

// ---------------------------------------------------------------- details
const FILES = [
  [0, 'folder', 'src/refunds', '', '', ''],
  [1, 'rust', 'controller.rs', 'M', '+42', '−8', true],
  [1, 'rust', 'idempotency.rs', 'A', '+71', ''],
  [1, 'rust', 'mod.rs', 'M', '+3', '−1'],
  [1, 'rust', 'legacy_refund.rs', 'D', '', '−29'],
  [0, 'folder', 'migrations', '', '', ''],
  [1, 'sql', '0042_idempotency_keys.sql', 'A', '+14', ''],
  [0, 'folder', 'tests', '', '', ''],
  [1, 'rust', 'refunds_test.rs', 'R', '+6', '−3'],
  [0, 'toml', 'Cargo.toml', 'M', '+2', ''],
];
function details() {
  const files = FILES.map(([d, icn, name, st, add, del, sel]) => {
    const stCls = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed' }[st];
    const color = stCls ? `style="color:var(--dg-status-${stCls})"` : '';
    const extra = st === 'R' ? '<span class="from">from refund_test.rs</span>' : '';
    return `<div class="trow frow${sel ? ' is-sel' : ''}" style="--d:${d}">${icn === 'folder' ? ic('chevD', 'chev') : '<span class="chev-sp"></span>'}${ic(icn, icn === 'folder' ? 'ic-sec' : 'ic-file')}
      <span class="fname${st === 'D' ? ' is-del' : ''}" ${color}>${name}</span>${extra}<span class="sp"></span>
      ${add ? `<span class="n-add">${add}</span>` : ''}${del ? `<span class="n-del">${del}</span>` : ''}${st ? `<span class="fst" ${color}>${st}</span>` : ''}</div>`;
  }).join('');
  return `
  <div class="ihead"><span class="ititle">Commit</span><span class="sp"></span>
    <button class="ib" title="Copy hash  Ctrl+Shift+C">${ic('copy')}</button><button class="ib" title="Cherry-pick">${ic('cherry')}</button><button class="ib">${ic('more')}</button></div>
  <div class="det">
    <div class="det-id"><span class="rchip" style="--rc:${rc('api-gateway')}">api-gateway</span><span class="hash-full">9f3c2a1e7b04d58c2f61a9e0b3d7c4f18a26e5b9</span></div>
    <h1 class="det-subj">Add idempotency key to refund endpoint</h1>
    <p class="det-body">Clients retry <code>POST /v1/refunds</code> on timeouts. Store the <code>Idempotency-Key</code> header for 24&nbsp;h and return the first response for a repeated key.</p>
    <p class="det-body muted">Refs: PAY-2318</p>
    <div class="det-person">${avatar('Lucía Martín', true)}<div><div><b>Lucía Martín</b> <span class="muted">lucia.martin@acme.dev</span></div><div class="muted">Authored today at 10:42, Tue 10 Nov 2026</div></div></div>
    <dl class="det-meta">
      <dt>Parent</dt><dd><a class="hash-link">a03e5f7</a> <span class="muted">Wire RefundController to the ledger client</span></dd>
      <dt>Branches</dt><dd>${pill(['headcur', 'feature/PAY-2318-refunds'])}</dd>
      <dt>Push state</dt><dd><span class="warn-t">${ic('push')} Not on origin. 3 commits to push.</span></dd>
    </dl>
  </div>
  <div class="fhead"><span class="ititle">Changed files</span><span class="cnt">9</span><span class="n-add">+138</span><span class="n-del">−41</span><span class="sp"></span>
    <span class="seg"><button class="ib is-on" title="Tree">${ic('tree')}</button><button class="ib" title="List">${ic('list')}</button></span></div>
  <div class="tree files">${files}</div>`;
}

// ---------------------------------------------------------------- diff
const KW = /\b(pub|async|fn|let|if|return|await|Some|Ok|Err|mut|impl|use|struct|const|match|self|Self)\b/g;
function highlight(code) {
  // returns array of [text, cls] tokens
  const toks = [];
  const re = /("([^"\\]|\\.)*")|(\b(?:pub|async|fn|let|if|return|await|Some|Ok|Err|mut|impl|use|const|self)\b)|(\b[A-Z][A-Z0-9_]{2,}\b)|(\b[A-Z][A-Za-z0-9]*\b)|((?<=fn )[a-z_]+)|((?<=\.)[a-z_]+(?=\())/g;
  let last = 0, m;
  while ((m = re.exec(code))) {
    if (m.index > last) toks.push([code.slice(last, m.index), '']);
    const cls = m[1] ? 's' : m[3] ? 'k' : m[4] ? 'cst' : m[5] ? 'ty' : m[6] ? 'fn' : m[7] ? 'mc' : '';
    toks.push([m[0], cls]);
    last = m.index + m[0].length;
  }
  if (last < code.length) toks.push([code.slice(last), '']);
  return toks;
}
// ⟦ ⟧ mark word-level changes
function codeHtml(src) {
  const ranges = []; let plain = ''; let open = -1;
  for (const ch of src) { if (ch === '⟦') open = plain.length; else if (ch === '⟧') { ranges.push([open, plain.length]); open = -1; } else plain += ch; }
  const toks = highlight(plain);
  let pos = 0, out = '';
  for (const [text, cls] of toks) {
    // split token by ranges
    let i = 0;
    while (i < text.length) {
      const abs = pos + i;
      const r = ranges.find(([a, b]) => abs >= a && abs < b);
      let end = text.length;
      if (r) end = Math.min(end, r[1] - pos);
      else { const nxt = ranges.filter(([a]) => a > abs).map(([a]) => a - pos); if (nxt.length) end = Math.min(end, Math.min(...nxt)); }
      const piece = esc(text.slice(i, end));
      let h = cls ? `<span class="${cls}">${piece}</span>` : piece;
      if (r) h = `<span class="w">${h}</span>`;
      out += h; i = end;
    }
    pos += text.length;
  }
  return out;
}
// [type, leftNo, leftCode, rightNo, rightCode]; type: c=context, a=added, d=deleted, m=modified, h=hunk
const DIFF = [
  ['h', '@@ -40,11 +40,18 @@ impl RefundController'],
  ['c', 40, 'pub async fn create_refund(', 40, 'pub async fn create_refund('],
  ['c', 41, '    State(app): State<AppState>,', 41, '    State(app): State<AppState>,'],
  ['a', null, null, 42, '    headers: HeaderMap,'],
  ['c', 42, '    Json(req): Json<CreateRefundRequest>,', 43, '    Json(req): Json<CreateRefundRequest>,'],
  ['c', 43, ') -> Result<Json<RefundResponse>, ApiError> {', 44, ') -> Result<Json<RefundResponse>, ApiError> {'],
  ['a', null, null, 45, '    let key = IdempotencyKey::from_headers(&headers)?;'],
  ['a', null, null, 46, '    if let Some(cached) = app.idempotency.get(&key).await? {'],
  ['a', null, null, 47, '        return Ok(Json(cached));'],
  ['a', null, null, 48, '    }'],
  ['c', 44, '    let payment = app.payments.find(req.payment_id).await?;', 49, '    let payment = app.payments.find(req.payment_id).await?;'],
  ['m', 45, '    if req.amount > payment.⟦captured⟧ {', 50, '    if req.amount > payment.⟦refundable()⟧ {', true],
  ['m', 46, '        return Err(ApiError::bad_request("amount exceeds ⟦capture⟧"));', 51, '        return Err(ApiError::bad_request("amount exceeds ⟦refundable balance⟧"));', true],
  ['c', 47, '    }', 52, '    }'],
  ['m', 48, '    let refund = app.ledger.refund(&payment, req.amount).await?;', 53, '    let refund = app.ledger.refund(&payment, req.amount⟦, &key⟧).await?;'],
  ['a', null, null, 54, '    let body: RefundResponse = refund.into();'],
  ['a', null, null, 55, '    app.idempotency.put(&key, &body, TTL_24H).await?;'],
  ['m', 49, '    Ok(Json(⟦refund.into()⟧))', 56, '    Ok(Json(⟦body⟧))'],
  ['c', 50, '}', 57, '}'],
  ['c', 51, '', 58, ''],
  ['c', 52, '/// Returns refunds for one payment, newest first.', 59, '/// Returns refunds for one payment, newest first.'],
];
function diffSide(side) {
  return DIFF.map(row => {
    const [ty] = row;
    if (ty === 'h') return `<div class="dl dl-h${side === 'L' ? '' : ' dl-h-r'}"><span class="ln"></span><span class="code">${side === 'L' ? esc(row[1]) : ''}</span></div>`;
    const no = side === 'L' ? row[1] : row[3];
    const code = side === 'L' ? row[2] : row[4];
    const focus = row[5] ? ' is-focus' : '';
    if (no === null) return `<div class="dl dl-fill${focus}"><span class="ln"></span><span class="code"></span></div>`;
    let cls = 'dl';
    if (ty === 'a') cls += ' dl-add';
    if (ty === 'm') cls += side === 'L' ? ' dl-del' : ' dl-add';
    return `<div class="${cls}${focus}"><span class="ln">${no}</span><span class="code">${codeHtml(code)}</span></div>`;
  }).join('');
}

// ---------------------------------------------------------------- ruler (overview of the whole log)
function ruler() {
  const marks = [[0.3, 'head'], [0.6, 'sel'], [1.2, 'branch'], [2.1, 'branch'], [3.4, 'tag'], [7.8, 'branch'], [12.5, 'tag'], [19, 'tag'], [26.4, 'branch'], [33, 'tag'], [41, 'tag'], [52.5, 'branch'], [61, 'tag'], [74, 'tag'], [88, 'tag']];
  return `<div class="ruler"><span class="thumb"></span>${marks.map(([p, k]) => `<i class="rm rm-${k}" style="top:${p}%"></i>`).join('')}</div>`;
}

// ---------------------------------------------------------------- page
const css = fs.readFileSync(path.join(__dirname, 'mockup.css'), 'utf8');
const b64 = f => fs.readFileSync(path.join(FONTS, f)).toString('base64');
const fontCss = `
@font-face{font-family:"Inter";src:url(data:font/ttf;base64,${b64('Inter-Regular.ttf')}) format("truetype");font-weight:400}
@font-face{font-family:"Inter";src:url(data:font/ttf;base64,${b64('Inter-Medium.ttf')}) format("truetype");font-weight:500}
@font-face{font-family:"Inter";src:url(data:font/ttf;base64,${b64('Inter-SemiBold.ttf')}) format("truetype");font-weight:600}
@font-face{font-family:"JetBrains Mono";src:url(data:font/ttf;base64,${b64('JetBrainsMono-Regular.ttf')}) format("truetype");font-weight:400}`;

const html = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DeepGit mockup</title>
<!--
  DeepGit - main window, dark theme. Static visual reference for implementers. Spec: DESIGN.md. Tokens: tokens.css.
  Viewport reference: 1600 x 1000 CSS px. The tokens below are a verbatim copy of tokens.css.
  The embedded @font-face block (Inter, JetBrains Mono, SIL OFL 1.1) is at the END of the file.
-->
<style>
${tokens}
</style>
<style>
${css}
</style>
</head>
<body>
${sprite}
<div class="app">

  <!-- ============ TITLE BAR (40px) ============ -->
  <header class="titlebar">
    <div class="tb-left">
      <span class="logo" title="DeepGit"><svg viewBox="0 0 20 20" width="20" height="20"><rect width="20" height="20" rx="5" fill="#3871E1"/><path d="M6 5v10M6 9c0-2.5 8-1.5 8-4.5M6 11c0 2.5 8 1.5 8 4.5" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round"/><circle cx="14" cy="4.6" r="1.6" fill="#fff"/><circle cx="14" cy="15.4" r="1.6" fill="#fff"/></svg></span>
      <button class="tb-dd proj-dd"><span class="pq">PP</span><span class="dd-main">payments-platform</span>${ic('chevD', 'dd-chev')}</button>
      <button class="tb-dd br-dd">${ic('branch')}<span class="dd-main">feature/PAY-2318-refunds</span><span class="dd-sub">3 of 12 repos</span>${ic('chevD', 'dd-chev')}</button>
      <span class="tb-sep"></span>
      <button class="tb-btn fetch-btn" title="Fetch all repositories  Ctrl+T"><span class="age-ring" style="--age:.18"></span>${ic('fetch')}</button>
      <button class="tb-btn" title="Pull  Ctrl+Shift+T">${ic('pull')}<span class="tb-n tb-n-down">7</span></button>
      <button class="tb-btn push-btn" title="Push  Ctrl+Shift+K">${ic('push')}<span class="tb-n">6</span></button>
    </div>
    <div class="tb-center">
      <button class="search">${ic('search')}<span>Search commits, branches, files, actions</span><span class="kbd">Shift</span><span class="kbd">Shift</span></button>
    </div>
    <div class="tb-right">
      <button class="tb-btn" title="Git console  Alt+9">${ic('console')}</button>
      <button class="tb-btn" title="Notifications">${ic('bell')}<span class="dot-badge"></span></button>
      <button class="tb-btn" title="Settings  Ctrl+Alt+S">${ic('gear')}</button>
      <span class="tb-sep"></span>
      <button class="wc">${ic('min')}</button><button class="wc">${ic('max')}</button><button class="wc wc-close">${ic('close')}</button>
    </div>
  </header>

  <div class="main">
    <!-- ============ LEFT STRIPE (40px) ============ -->
    <nav class="stripe">
      <button class="sb is-on" title="Project  Alt+1">${ic('project')}</button>
      <button class="sb" title="Local changes  Alt+0">${ic('changes')}<span class="sb-n">14</span></button>
      <button class="sb" title="Branch matrix  Alt+2">${ic('matrix')}</button>
      <button class="sb" title="Stashes  Alt+3">${ic('stash')}</button>
      <span class="sp"></span>
      <button class="sb" title="Git console  Alt+9">${ic('console')}</button>
      <button class="sb" title="Notifications">${ic('bell')}</button>
    </nav>

    <div class="islands">
      <!-- ============ SIDEBAR (280px) ============ -->
      <aside class="island sidebar">${sidebar()}</aside>

      <div class="center">
       <div class="toprow">
        <!-- ============ LOG ============ -->
        <section class="island log">
          <div class="ihead tabs">
            <span class="tab is-on">${ic('log')}Log<span class="tab-sub">combined · 5 repos</span></span>
            <span class="tab">${ic('changes')}Local changes<span class="cnt">14</span></span>
            <span class="sp"></span>
            <button class="ib" title="Lane colours: by repository">${ic('palette')}</button>
            <button class="ib is-on" title="Highlight path of the selected commit">${ic('eye')}</button>
            <button class="ib" title="Refresh  Ctrl+R">${ic('refresh')}</button>
          </div>
          <div class="filters">
            <label class="finput">${ic('search')}<span class="ph">Filter by text or hash</span><span class="kbd">Ctrl+F</span></label>
            <button class="chip is-on"><span class="chip-dots"><i style="background:${rc('api-gateway')}"></i><i style="background:${rc('ledger-service')}"></i><i style="background:${rc('refunds-worker')}"></i></span>Repos: 5 of 12${ic('chevD')}</button>
            <button class="chip">${ic('branch')}Branch: all${ic('chevD')}</button>
            <button class="chip">${ic('user')}Author${ic('chevD')}</button>
            <button class="chip">${ic('cal')}Date${ic('chevD')}</button>
            <button class="chip">${ic('path')}Path${ic('chevD')}</button>
          </div>
          <div class="banner banner-warn">${ic('warn')}<span><b>ledger-service</b>: rebase onto main is in progress. Step 3 of 7. 2 files have conflicts.</span><span class="sp"></span>
            <button class="btn btn-sm btn-primary">Resolve conflicts</button><button class="btn btn-sm">Continue</button><button class="btn btn-sm">Abort</button></div>
          <div class="lhead"><span class="spine-h"></span><span class="c-graph"></span><span class="c-subj">Subject</span><span class="c-repo">Repository</span><span class="c-auth">Author</span><span class="c-date">Date</span><span class="c-hash">Hash</span></div>
          <div class="lbody">${graphSvg()}${logRows()}${ruler()}</div>
        </section>
        <!-- ============ DETAILS (400px) ============ -->
        <aside class="island details">${details()}</aside>
       </div>

        <!-- ============ DIFF (full width under log + details) ============ -->
        <section class="island diff">
          <div class="ihead">
            ${ic('rust', 'ic-file')}<span class="dpath"><span class="muted">src/refunds/</span>controller.rs</span><span class="fst" style="color:var(--dg-status-modified)">M</span>
            <span class="n-add">+42</span><span class="n-del">−8</span>
            <span class="sp"></span>
            <span class="hunknav"><button class="ib" title="Previous change  Shift+F7">${ic('up')}</button><span>Change 3 of 6</span><button class="ib" title="Next change  F7">${ic('down')}</button></span>
            <span class="vsep"></span>
            <span class="seg seg-txt"><button class="is-on">${ic('sbs')}Side by side</button><button>${ic('unified')}Unified</button></span>
            <button class="ib" title="Options">${ic('more')}</button>
          </div>
          <div class="dbody">
            <div class="dside dside-l"><div class="dside-cap">a03e5f7 <span class="muted">parent</span></div>${diffSide('L')}</div>
            <div class="dgap"></div>
            <div class="dside dside-r"><div class="dside-cap">9f3c2a1 <span class="muted">this commit</span></div>${diffSide('R')}</div>
            <div class="druler"><i style="top:6%;height:4%" class="dr-a"></i><i style="top:14%;height:9%" class="dr-a"></i><i style="top:25%;height:5%" class="dr-m is-focus"></i><i style="top:33%;height:7%" class="dr-m"></i><i style="top:62%;height:3%" class="dr-d"></i><i style="top:78%;height:6%" class="dr-a"></i></div>
          </div>
        </section>
      </div>
    </div>
  </div>

  <!-- ============ STATUS BAR (28px) ============ -->
  <footer class="statusbar">
    <button class="sw ticker" title="Open Git console  Alt+9">${ic('check', 'ok')}<span class="cmd"><span class="cmd-repo">refunds-worker</span>git fetch --prune origin</span><span class="muted">0.8 s</span></button>
    <span class="sw prog"><span>Fetching 12 repositories</span><span class="pbar"><i style="width:58%"></i></span><span class="muted">7 / 12</span><button class="ib ib-sm">${ic('close')}</button></span>
    <span class="sp"></span>
    <span class="sw"><span class="rsq" style="background:${rc('api-gateway')}"></span>api-gateway</span>
    <span class="sw">${ic('branch')}feature/PAY-2318-refunds ${capsule(3, 0)}</span>
    <span class="sw"><span class="age-dot"></span>Fetched 4 min ago</span>
    <span class="sw">Dark</span>
  </footer>

  <!-- ============ TOAST ============ -->
  <div class="toast">
    <div class="toast-h">${ic('check', 'ok')}<b>Checked out in 2 repos</b><button class="ib ib-sm">${ic('close')}</button></div>
    <div class="toast-b">feature/PAY-2318-refunds in api-gateway and ledger-service. 9 repos skipped.</div>
    <div class="toast-a"><a>Open matrix</a><a>Show in console</a></div>
  </div>
</div>
<style id="embedded-fonts">${fontCss}</style>
</body>
</html>`;
fs.writeFileSync(path.join(OUT, 'mockup.html'), html);
console.log('ok', (html.length / 1024 | 0) + ' KB');
