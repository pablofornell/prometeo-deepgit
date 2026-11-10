/**
 * Deterministic fake repositories for the browser mock: commit history with feature branches,
 * merges, tags and remote branches. Pure data + generation; the command handlers are in `mock.ts`.
 */
import type { FileChange, RepoInfo, RepoStateKind, Stash } from "./types";
import { toFileChange } from "./mockDiff";
import { DOCS_SITE_CONFLICTS, DOCS_SITE_CONTEXT, LEDGER_CONFLICTS, LEDGER_CONTEXT, type MockConflict, type MockConflictContext } from "./mockConflicts";

// ---------------------------------------------------------------- random helpers

export function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: small seeded PRNG returning floats in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 40 hex chars derived from a seed string. */
export function hex40(seed: string): string {
  let out = "";
  for (let i = 0; out.length < 40; i++) out += hashStr(seed + "#" + i).toString(16).padStart(8, "0");
  return out.slice(0, 40);
}

// ---------------------------------------------------------------- model

export interface MockPerson {
  name: string;
  email: string;
  tz: string;
}

export const PEOPLE: MockPerson[] = [
  { name: "Lucía Martín", email: "lucia.martin@acme.dev", tz: "+0100" },
  { name: "Noah Fischer", email: "noah.fischer@acme.dev", tz: "+0100" },
  { name: "Marta Kowalczyk", email: "marta.kowalczyk@acme.dev", tz: "+0100" },
  { name: "Priya Raman", email: "priya.raman@acme.dev", tz: "+0530" },
  { name: "Jonas Berg", email: "jonas.berg@acme.dev", tz: "+0100" },
  { name: "Diego Salazar", email: "diego.salazar@acme.dev", tz: "-0300" },
  { name: "Aiko Tanaka", email: "aiko.tanaka@acme.dev", tz: "+0900" },
  { name: "Tom Becker", email: "tom.becker@acme.dev", tz: "+0000" },
];

export interface MockCommit {
  oid: string;
  parents: string[];
  /** Creation order; children always have a higher seq than their parents. */
  seq: number;
  person: number;
  /** Unix seconds. */
  time: number;
  subject: string;
  body: string;
  /** Explicit file list (curated commits); others get a generated one. */
  files?: { path: string; oldPath?: string; status: FileChange["status"] }[];
}

export interface MockStash extends Stash {
  staged: FileChange[];
  unstaged: FileChange[];
}

export interface MockRepo {
  info: RepoInfo;
  url: string;
  lang: "rust" | "ts" | "proto" | "mixed";
  commits: MockCommit[];
  byOid: Map<string, MockCommit>;
  /** Local branches: name -> oid. */
  branches: Map<string, string>;
  /** Remote branches: "origin/main" -> oid. */
  remotes: Map<string, string>;
  /** Configured remotes besides "origin" (their names may contain "/", like `team/fork`). */
  extraRemotes?: string[];
  /** Upstream of each local branch: name -> "origin/name" (the branch part may differ from the local name). */
  upstreams: Map<string, string>;
  /** Local branches whose upstream was deleted on the remote. */
  gone: Set<string>;
  tags: Map<string, { oid: string; annotated: boolean }>;
  /** Checked-out branch; null = detached at `detachedOid`. */
  head: { branch: string | null; oid: string };
  stashes: MockStash[];
  wt: { staged: FileChange[]; unstaged: FileChange[]; conflicted: FileChange[] };
  /** The unmerged files by path, with their index stages (see `mockConflicts.ts`); `wt.conflicted` lists the same paths. */
  conflicts: Map<string, MockConflict>;
  /** What the labels of the merge window say about the operation in progress. */
  conflictCtx: MockConflictContext | null;
  state: RepoStateKind;
  fetches: number;
  filePool: string[];
  /** Bumped on every mutation of the commit graph / refs; invalidates ancestor caches. */
  version: number;
}

// ---------------------------------------------------------------- vocabulary

const DOMAINS: Record<string, { nouns: string[]; files: string[]; lang: MockRepo["lang"] }> = {
  "api-gateway": {
    lang: "rust",
    nouns: ["refund endpoint", "payment routes", "rate limiter", "auth middleware", "request tracing", "idempotency layer", "health checks", "OpenAPI spec", "merchant lookup", "webhook signature check", "error mapping", "CORS config", "pagination cursor"],
    files: ["src/refunds/controller.rs", "src/refunds/idempotency.rs", "src/refunds/mod.rs", "src/payments/handler.rs", "src/middleware/rate_limit.rs", "src/middleware/auth.rs", "src/error.rs", "src/state.rs", "src/config.rs", "migrations/0042_idempotency_keys.sql", "tests/refunds_test.rs", "tests/payments_test.rs", "Cargo.toml", "README.md", ".github/workflows/ci.yml"],
  },
  "ledger-service": {
    lang: "rust",
    nouns: ["ledger entries", "double-entry posting", "balance snapshot", "reconciliation job", "account hierarchy", "currency rounding", "journal export", "audit trail", "idempotent posting", "sqlx queries"],
    files: ["src/ledger/entry.rs", "src/ledger/posting.rs", "src/ledger/balance.rs", "src/reconcile/job.rs", "src/accounts/tree.rs", "src/db/queries.rs", "src/grpc/server.rs", "src/error.rs", "migrations/0017_entries_index.sql", "migrations/0018_audit_trail.sql", "tests/posting_test.rs", "Cargo.toml", "README.md"],
  },
  "refunds-worker": {
    lang: "rust",
    nouns: ["refund queue consumer", "retry policy", "dead-letter handling", "provider adapter", "settlement batch", "backoff", "metrics exporter", "job lease", "graceful shutdown"],
    files: ["src/worker/consumer.rs", "src/worker/retry.rs", "src/providers/stripe.rs", "src/providers/adyen.rs", "src/settlement/batch.rs", "src/metrics.rs", "src/main.rs", "tests/retry_test.rs", "Cargo.toml", ".github/workflows/ci.yml"],
  },
  "web-checkout": {
    lang: "ts",
    nouns: ["checkout form", "order summary", "cart totals", "payment sheet", "address autocomplete", "discount code field", "error boundary", "3-D Secure step", "order timeline", "locale switcher", "CartSummary component"],
    files: ["src/checkout/Checkout.tsx", "src/checkout/createCheckout.ts", "src/cart/CartSummary.tsx", "src/payment/PaymentSheet.tsx", "src/lib/money.ts", "src/lib/analytics.ts", "src/i18n/en.json", "src/i18n/es.json", "src/styles/checkout.css", "tests/checkout.test.ts", "package.json", "README.md"],
  },
  "shared-proto": {
    lang: "proto",
    nouns: ["Money message", "Payment event", "Refund service", "ledger RPC", "error details", "pagination fields", "enum values", "reserved field numbers"],
    files: ["proto/acme/ledger/v1/ledger.proto", "proto/acme/payments/v1/payment.proto", "proto/acme/refunds/v1/refund.proto", "proto/acme/common/v1/money.proto", "buf.yaml", "README.md", ".github/workflows/ci.yml"],
  },
  "docs-site": {
    lang: "ts",
    nouns: ["getting started guide", "API reference", "changelog page", "search index", "sidebar navigation", "code samples", "dark mode toggle", "versioned docs", "redirects"],
    files: ["docs/getting-started.md", "docs/api/refunds.md", "docs/api/payments.md", "docs/changelog.md", "src/components/Sidebar.tsx", "src/search/index.ts", "src/theme.ts", "package.json", "README.md"],
  },
  deepgit: {
    lang: "mixed",
    nouns: ["log session cache", "graph layout", "diff parser", "branch matrix", "git console", "status bar ticker", "search everywhere", "keymap registry", "toast host", "virtual list"],
    files: ["crates/gitcore/src/graph.rs", "crates/gitcore/src/log.rs", "crates/gitcore/src/diff.rs", "src-tauri/src/commands.rs", "src/features/log/LogView.tsx", "src/features/diff/DiffViewer.tsx", "src/state/workspace.ts", "src/api/tauri.ts", "Cargo.toml", "package.json", "README.md"],
  },
};

const GENERIC_DOMAIN = {
  lang: "ts" as const,
  nouns: ["config loader", "logging", "health endpoint", "retry helper", "README", "unit tests", "CI pipeline"],
  files: ["src/index.ts", "src/config.ts", "src/lib/retry.ts", "tests/index.test.ts", "package.json", "README.md"],
};

const VERBS = ["Add", "Fix", "Update", "Refactor", "Remove", "Rename", "Extract", "Handle", "Validate", "Improve", "Wire", "Document", "Simplify", "Cache", "Log", "Guard"];
const TAILS = ["for retries", "when the amount is zero", "in the happy path", "after review", "for multi-currency orders", "behind a feature flag", "to avoid a race", "for large batches", "with better errors", "on startup", "under load", "in tests"];
const BRANCH_KINDS = ["feature", "feature", "feature", "fix", "chore", "spike"];
const SLUGS = ["refunds", "retry-budget", "currency-rounding", "audit-trail", "rate-limit", "webhooks", "search-index", "dark-mode", "pagination", "tracing", "idempotency", "batch-settlement", "error-mapping", "health-checks", "bump-deps", "ci-cache", "docs-cleanup"];

function subjectFor(r: () => number, nouns: string[], issue: string | null): string {
  const verb = VERBS[Math.floor(r() * VERBS.length)];
  const noun = nouns[Math.floor(r() * nouns.length)];
  let s = `${verb} ${noun}`;
  if (r() < 0.35) s += " " + TAILS[Math.floor(r() * TAILS.length)];
  if (issue && r() < 0.4) s = `${issue}: ${s}`;
  return s;
}

// ---------------------------------------------------------------- generation

export interface Scenario {
  name: string;
  commits: number;
  /** Checked-out branch (created from main when it is not "main"). */
  head: string;
  /** Commits the local head branch is ahead of its remote. */
  ahead?: number;
  /** Commits the remote head branch has that local does not. */
  behind?: number;
  state?: RepoStateKind;
  dirty?: { staged: number; unstaged: number; untracked: number };
  conflicts?: number;
  stashes?: number;
  /** Curated feature branch with commits from "today" (for the demo). */
  curated?: boolean;
  /** Extra branch that exists only on the remote. */
  remoteOnly?: string[];
}

interface Gen {
  repo: MockRepo;
  r: () => number;
  nouns: string[];
}

function addCommit(g: Gen, parents: string[], person: number, time: number, subject: string, body = ""): MockCommit {
  const { repo } = g;
  const seq = repo.commits.length;
  const oid = hex40(repo.info.name + ":" + seq + ":" + subject);
  const c: MockCommit = { oid, parents, seq, person, time, subject, body };
  repo.commits.push(c);
  repo.byOid.set(oid, c);
  return c;
}

const BODIES = [
  "Clients retry on timeouts, so the handler must be safe to call twice.\nThe first response is stored for 24 hours.",
  "No behaviour change. Moves the code so the next commit is easier to review.",
  "The old query did a sequential scan on large tables.\n\nRefs: PAY-{n}",
  "Found while debugging the flaky integration test.\n\nCo-authored-by: Priya Raman <priya.raman@acme.dev>",
  "Part of the refunds rollout.\n\nRefs: PAY-{n}\nSigned-off-by: Noah Fischer <noah.fischer@acme.dev>",
];

function randomBranchName(r: () => number, used: Set<string>): string {
  for (let i = 0; i < 20; i++) {
    const kind = BRANCH_KINDS[Math.floor(r() * BRANCH_KINDS.length)];
    const slug = SLUGS[Math.floor(r() * SLUGS.length)];
    const name = kind === "chore" || kind === "spike" ? `${kind}/${slug}` : `${kind}/PAY-${1000 + Math.floor(r() * 2400)}-${slug}`;
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
  }
  const name = "feature/tmp-" + used.size;
  used.add(name);
  return name;
}

/** Walks `n` first-parent steps back from `oid`. */
function firstParentBack(repo: MockRepo, oid: string, n: number): string {
  let cur = oid;
  for (let i = 0; i < n; i++) {
    const c = repo.byOid.get(cur);
    if (!c || c.parents.length === 0) break;
    cur = c.parents[0];
  }
  return cur;
}

export function generateRepo(info: RepoInfo, url: string, sc: Scenario, nowSec: number): MockRepo {
  const dom = DOMAINS[info.name] ?? GENERIC_DOMAIN;
  const repo: MockRepo = {
    info,
    url,
    lang: dom.lang,
    commits: [],
    byOid: new Map(),
    branches: new Map(),
    remotes: new Map(),
    upstreams: new Map(),
    gone: new Set(),
    tags: new Map(),
    head: { branch: "main", oid: "" },
    stashes: [],
    wt: { staged: [], unstaged: [], conflicted: [] },
    conflicts: new Map(),
    conflictCtx: null,
    state: sc.state ?? "clean",
    fetches: 0,
    filePool: dom.files,
    version: 0,
  };
  const g: Gen = { repo, r: rng(hashStr("repo:" + info.name)), nouns: dom.nouns };
  const { r } = g;
  const total = sc.commits;
  const span = 2 * 365 * 86400;
  const endBase = nowSec - 30 * 3600;
  const t0 = endBase - span;
  const avg = span / total;

  // --- root + main line, branches, merges
  let t = t0;
  const nextTime = () => {
    t += Math.max(30, -Math.log(1 - r()) * avg * 0.9);
    return Math.floor(t);
  };
  const person = () => Math.floor(r() * r() * PEOPLE.length * 1.0) % PEOPLE.length;
  let mainTip = addCommit(g, [], 0, t0, "Initial commit").oid;
  const used = new Set<string>(["main"]);
  const active: { name: string; tip: string; base: string; owner: number; n: number }[] = [];
  const keepRemote: { name: string; tip: string }[] = [];
  const merged: string[] = [];
  let prNo = 800;
  let version = [2, 0, 0];

  // budget the last `tail` commits for open branches so that some branches are unmerged at the end
  while (repo.commits.length < total) {
    const x = r();
    const issue = r() < 0.3 ? `PAY-${1000 + Math.floor(r() * 2400)}` : null;
    if (active.length < 5 && x < 0.05) {
      const name = randomBranchName(r, used);
      active.push({ name, tip: mainTip, base: mainTip, owner: person(), n: 0 });
    } else if (active.length > 0 && x < 0.5) {
      const b = active[Math.floor(r() * r() * active.length)];
      const body = r() < 0.3 ? BODIES[Math.floor(r() * BODIES.length)].replace("{n}", String(1000 + Math.floor(r() * 2400))) : "";
      b.tip = addCommit(g, [b.tip], b.owner, nextTime(), subjectFor(r, g.nouns, issue), body).oid;
      b.n++;
    } else if (active.length > 0 && x < 0.58 && repo.commits.length < total - 60) {
      const idx = Math.floor(r() * active.length);
      const b = active[idx];
      if (b.n > 0) {
        prNo += 1 + Math.floor(r() * 3);
        const m = addCommit(g, [mainTip, b.tip], person(), nextTime(), `Merge pull request #${prNo} from acme/${b.name}`, b.name.split("/").slice(1).join(" ").replace(/-/g, " "));
        mainTip = m.oid;
        active.splice(idx, 1);
        merged.push(b.name);
        if (r() < 0.2) keepRemote.push({ name: b.name, tip: b.tip });
      }
    } else if (r() < 0.012 && repo.commits.length > 80) {
      version = [version[0], version[1] + 1, 0];
      const c = addCommit(g, [mainTip], person(), nextTime(), `Release ${version.join(".")}`);
      mainTip = c.oid;
      repo.tags.set("v" + version.join("."), { oid: c.oid, annotated: r() < 0.6 });
    } else {
      const body = r() < 0.15 ? BODIES[Math.floor(r() * BODIES.length)].replace("{n}", String(1000 + Math.floor(r() * 2400))) : "";
      mainTip = addCommit(g, [mainTip], person(), nextTime(), subjectFor(r, g.nouns, issue), body).oid;
    }
  }
  // patch tag: one lightweight patch tag near the end
  version = [version[0], version[1], 1];
  repo.tags.set("v" + version.join("."), { oid: mainTip, annotated: false });

  repo.branches.set("main", mainTip);
  for (const b of active) {
    repo.branches.set(b.name, b.tip);
    if (r() < 0.75) {
      repo.remotes.set("origin/" + b.name, b.tip);
      repo.upstreams.set(b.name, "origin/" + b.name);
    }
  }
  for (const k of keepRemote) repo.remotes.set("origin/" + k.name, k.tip);
  // some merged branches linger locally with a deleted upstream
  merged.slice(-3).forEach((name, i) => {
    if (i === 1) {
      repo.branches.set(name, repo.byOid.get(mainTip)?.parents[0] ?? mainTip);
      repo.upstreams.set(name, "origin/" + name);
      repo.gone.add(name);
    }
  });
  repo.remotes.set("origin/main", mainTip);
  repo.upstreams.set("main", "origin/main");

  // --- curated "today" work on feature/PAY-2318-refunds
  const curatedName = "feature/PAY-2318-refunds";
  if (sc.curated) {
    const base = firstParentBack(repo, mainTip, 4);
    // two fresh commits on main today (before the feature work, so seq follows time)
    const m1 = addCommit(g, [mainTip], 2, nowSec - 7 * 3600, `Release ${[version[0], version[1] + 1, 0].join(".")}`);
    repo.tags.set("v" + [version[0], version[1] + 1, 0].join("."), { oid: m1.oid, annotated: true });
    const m2 = addCommit(g, [m1.oid], 4, nowSec - 6 * 3600, "Bump sqlx to 0.8.2");
    mainTip = m2.oid;
    repo.branches.set("main", mainTip);
    repo.remotes.set("origin/main", mainTip);
    const subs = [
      ["Add Refund domain types and error mapping", 5 * 3600 + 1800, 0],
      ["Wire RefundController to the ledger client", 3 * 3600 + 3000, 0],
      ["Validate partial refund amounts against capture", 2 * 3600 + 600, 0],
      ["Persist refund_entries with an idempotency column", 1 * 3600 + 1700, 1],
      ["Add idempotency key to refund endpoint", 20 * 60, 0],
    ] as const;
    let tip = base;
    subs.forEach(([s, ago, who], i) => {
      const c = addCommit(
        g,
        [tip],
        who,
        nowSec - ago,
        s,
        i === subs.length - 1
          ? "Clients retry `POST /v1/refunds` on timeouts. Store the first response under the `Idempotency-Key` header for 24 h and return it for a repeated call.\n\nRefs: PAY-2318"
          : "Refs: PAY-2318",
      );
      if (i === subs.length - 1) {
        c.files = [
          { path: "src/refunds/controller.rs", status: "modified" },
          { path: "src/refunds/idempotency.rs", status: "added" },
          { path: "src/refunds/mod.rs", status: "modified" },
          { path: "src/refunds/legacy_refund.rs", status: "deleted" },
          { path: "migrations/0042_idempotency_keys.sql", status: "added" },
          { path: "tests/refunds_test.rs", oldPath: "tests/refund_test.rs", status: "renamed" },
          { path: "Cargo.toml", status: "modified" },
        ];
      }
      tip = c.oid;
    });
    repo.branches.set(curatedName, tip);
    repo.remotes.set("origin/" + curatedName, firstParentBack(repo, tip, sc.ahead ?? 0));
    repo.upstreams.set(curatedName, "origin/" + curatedName);
  } else if (sc.head !== "main" && !repo.branches.has(sc.head)) {
    repo.branches.set(sc.head, firstParentBack(repo, mainTip, 3));
  }

  // --- behind: remote-only commits on the head branch's remote
  const headName = sc.head;
  const headTip = repo.branches.get(headName) ?? mainTip;
  if (!repo.upstreams.has(headName)) {
    repo.upstreams.set(headName, "origin/" + headName);
    repo.remotes.set("origin/" + headName, headTip);
  }
  if (sc.behind) {
    let tip = repo.remotes.get("origin/" + headName) ?? headTip;
    for (let i = 0; i < sc.behind; i++) {
      tip = addCommit(g, [tip], 1 + (i % 3), nowSec - (3 - i) * 1800 - 900, subjectFor(r, g.nouns, null)).oid;
    }
    repo.remotes.set("origin/" + headName, tip);
  }
  if (sc.ahead && !sc.curated) {
    // move the remote back by `ahead` commits
    const upstream = "origin/" + headName;
    repo.remotes.set(upstream, firstParentBack(repo, headTip, sc.ahead));
  }
  // remote-only branches (the matrix shows them as dashed rings)
  for (const name of sc.remoteOnly ?? []) repo.remotes.set("origin/" + name, firstParentBack(repo, mainTip, 2));

  repo.head = { branch: headName, oid: repo.branches.get(headName) ?? mainTip };

  // --- working tree
  const pool = repo.filePool;
  const pick = (i: number) => pool[(i * 5 + 1) % pool.length];
  const d = sc.dirty;
  let n = 0;
  if (d) {
    for (let i = 0; i < d.staged; i++) {
      const p = pick(n++);
      repo.wt.staged.push(toFileChange(p, null, i === 1 ? "added" : "modified", "wt-staged-" + p));
    }
    for (let i = 0; i < d.unstaged; i++) {
      const p = pick(n++);
      if (!repo.wt.staged.some((f) => f.path === p)) repo.wt.unstaged.push(toFileChange(p, null, "modified", "wt-unstaged-" + p));
    }
    for (let i = 0; i < d.untracked; i++) {
      const p = `src/scratch/notes_${i + 1}.${dom.lang === "rust" ? "rs" : "ts"}`;
      repo.wt.unstaged.push(toFileChange(p, null, "untracked", "wt-untracked-" + p));
    }
  }
  // Demo conflicts with real file versions (merge window): docs-site is merging, ledger-service is rebasing.
  const demo = info.name === "docs-site" ? { list: DOCS_SITE_CONFLICTS, ctx: DOCS_SITE_CONTEXT } : info.name === "ledger-service" ? { list: LEDGER_CONFLICTS, ctx: LEDGER_CONTEXT } : null;
  if (demo) {
    for (const c of demo.list) {
      repo.conflicts.set(c.path, c);
      repo.wt.conflicted.push({ path: c.path, oldPath: null, status: "conflicted", additions: null, deletions: null, binary: false });
    }
    repo.conflictCtx = demo.ctx;
  } else {
    for (let i = 0; i < (sc.conflicts ?? 0); i++) {
      const p = pick(n++ + 3);
      repo.wt.conflicted.push({ path: p, oldPath: null, status: "conflicted", additions: null, deletions: null, binary: false });
    }
  }
  for (let i = 0; i < (sc.stashes ?? 0); i++) {
    const c = repo.byOid.get(mainTip);
    repo.stashes.push({
      index: i,
      message: `WIP on ${headName}: ${(c?.oid ?? "").slice(0, 7)} ${c?.subject ?? ""}`,
      oid: hex40(info.name + ":stash:" + i),
      time: nowSec - (i + 1) * 86400,
      staged: [],
      unstaged: [toFileChange(pick(i + 2), null, "modified", "stash-" + i)],
    });
  }
  return repo;
}

// ---------------------------------------------------------------- workspace scenarios

export const PAYMENTS_ROOT = "~/work/payments-platform";
export const DEEPGIT_ROOT = "~/work/deepgit";

export const SCENARIOS: Scenario[] = [
  { name: "api-gateway", commits: 2500, head: "feature/PAY-2318-refunds", curated: true, ahead: 3, dirty: { staged: 2, unstaged: 3, untracked: 1 }, stashes: 2 },
  { name: "ledger-service", commits: 2300, head: "feature/PAY-2318-refunds", curated: true, ahead: 1, state: "rebasing", conflicts: 2, dirty: { staged: 1, unstaged: 2, untracked: 0 } },
  { name: "refunds-worker", commits: 2100, head: "main", behind: 2, remoteOnly: ["feature/PAY-2318-refunds"] },
  { name: "web-checkout", commits: 2400, head: "main", dirty: { staged: 0, unstaged: 3, untracked: 0 }, remoteOnly: ["feature/PAY-2318-refunds"] },
  { name: "shared-proto", commits: 900, head: "main" },
  { name: "docs-site", commits: 1200, head: "main", ahead: 1, stashes: 1, state: "merging", conflicts: 4 },
  { name: "deepgit", commits: 700, head: "main", dirty: { staged: 1, unstaged: 2, untracked: 1 } },
];

export function repoId(path: string): string {
  return hex40("path:" + path).slice(0, 12);
}

/** Scenario for a repo created by `project_add` in the browser mock. */
export function genericScenario(name: string): Scenario {
  return { name, commits: 350, head: "main", dirty: { staged: 0, unstaged: 1, untracked: 0 } };
}
