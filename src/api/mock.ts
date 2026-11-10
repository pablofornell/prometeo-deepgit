/**
 * Fake backend for `npm run dev` in a plain browser (see PLAN.md section 8).
 * `mockInvoke(cmd, args)` implements every command of PLAN.md section 5 on top of deterministic
 * in-memory repositories (`mockData.ts`); write commands mutate that state and emit `repo-changed`.
 * Every git-backed call also emits a `git-console` entry after a small random delay.
 */
import { layoutGraph } from "./graphLayout";
import {
  DEEPGIT_ROOT, PAYMENTS_ROOT, PEOPLE, SCENARIOS, genericScenario, generateRepo, hashStr, hex40, repoId,
  type MockCommit, type MockRepo, type Scenario,
} from "./mockData";
import { addColoredProject, parseColorChoice, setProjectColor, setRepoColor } from "./mockColors";
import { buildFileDiff, fileText, toFileChange } from "./mockDiff";
import type {
  CommitDetails, CommitRow, ConsoleEntry, DiffSpec, FileChange, FileDiff, GraphRow, LocalBranch, LogQuery,
  LogSessionInfo, OpResult, Project, RefLabel, Refs, RepoChanged, RepoInfo, RepoSummary, ResetMode, Workspace, WorkingTree,
} from "./types";

type Args = Record<string, unknown>;

// ---------------------------------------------------------------- args helpers

const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const optStr = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown, d = 0): number => (typeof v === "number" ? v : d);
const bool = (v: unknown): boolean => v === true;
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The rejection shape of a failed command (same as the Rust `ApiError`). */
function fail(message: string, detail?: string): never {
  throw detail ? { message, detail } : { message };
}

// ---------------------------------------------------------------- event bus

type Listener = (payload: unknown) => void;
const listeners = new Map<string, Set<Listener>>();

/** Subscribes to a backend event (`git-console`, `repo-changed`). Returns the unsubscribe function. */
export function mockListen(event: string, cb: Listener): () => void {
  let set = listeners.get(event);
  if (!set) listeners.set(event, (set = new Set()));
  set.add(cb);
  return () => set.delete(cb);
}

function emit(event: string, payload: unknown): void {
  listeners.get(event)?.forEach((cb) => cb(payload));
}

let consoleId = 0;

function emitConsole(repo: MockRepo | null, args: string[], durationMs: number, out: { stdout?: string; stderr?: string; exit?: number } = {}): void {
  const entry: ConsoleEntry = {
    id: ++consoleId,
    repoId: repo?.info.id ?? null,
    args,
    startedAt: Date.now() - durationMs,
    durationMs,
    exitCode: out.exit ?? 0,
    stdout: out.stdout ?? "",
    stderr: out.stderr ?? "",
  };
  emit("git-console", entry);
}

function emitChanged(repo: MockRepo): void {
  repo.version++;
  const payload: RepoChanged = { repoId: repo.info.id };
  setTimeout(() => emit("repo-changed", payload), 40 + Math.random() * 80);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- workspace and repo registry

const nowSec = Math.floor(Date.now() / 1000);
const metas = new Map<string, { info: RepoInfo; url: string; scenario: Scenario }>();
const repos = new Map<string, MockRepo>();

function registerRepo(info: RepoInfo, scenario: Scenario): void {
  metas.set(info.id, { info, url: `git@github.com:acme/${scenario.name}.git`, scenario });
}

/** Colours come from the same assignment as the Rust backend (`mockColors.ts`). */
function buildInitialProjects(): Workspace["projects"] {
  const ws: Workspace = { projects: [], activeProjectId: null, ui: {} };
  const payments: Project = { id: "p-payments", name: "payments-platform", path: PAYMENTS_ROOT, repos: [], color: 0, customColor: null };
  const scenarios = new Map<string, Scenario>();
  for (const sc of SCENARIOS.filter((s) => s.name !== "deepgit")) {
    const path = `${PAYMENTS_ROOT}/${sc.name}`;
    payments.repos.push({ id: repoId(path), name: sc.name, path, color: 0, customColor: null });
    scenarios.set(repoId(path), sc);
  }
  addColoredProject(ws, payments);
  const dg = SCENARIOS.find((s) => s.name === "deepgit") as Scenario;
  const dgInfo: RepoInfo = { id: repoId(DEEPGIT_ROOT), name: "deepgit", path: DEEPGIT_ROOT, color: 0, customColor: null };
  scenarios.set(dgInfo.id, dg);
  addColoredProject(ws, { id: "p-deepgit", name: "deepgit", path: DEEPGIT_ROOT, repos: [dgInfo], color: 0, customColor: null });
  // the registry holds the live objects of the workspace, so a colour change shows in every later read
  for (const r of ws.projects.flatMap((p) => p.repos)) registerRepo(r, scenarios.get(r.id) as Scenario);
  return ws.projects;
}

const workspace: Workspace = { projects: buildInitialProjects(), activeProjectId: "p-payments", ui: {} };

function repoOf(id: unknown): MockRepo {
  const key = str(id);
  let r = repos.get(key);
  if (!r) {
    const meta = metas.get(key);
    if (!meta) fail(`Repository not found: ${key}`, `fatal: not a git repository: ${key}`);
    r = generateRepo(meta.info, meta.url, meta.scenario, nowSec);
    repos.set(key, r);
  }
  return r;
}

// ---------------------------------------------------------------- graph helpers

const ancCache = new WeakMap<MockRepo, { v: number; m: Map<string, Set<string>> }>();

/** All commits reachable from `oid` (including itself). Cached until the repo mutates. */
function ancestors(repo: MockRepo, oid: string): Set<string> {
  let c = ancCache.get(repo);
  if (!c || c.v !== repo.version) ancCache.set(repo, (c = { v: repo.version, m: new Map() }));
  const hit = c.m.get(oid);
  if (hit) return hit;
  const seen = new Set<string>();
  const stack = [oid];
  while (stack.length) {
    const cur = stack.pop() as string;
    if (seen.has(cur)) continue;
    const commit = repo.byOid.get(cur);
    if (!commit) continue;
    seen.add(cur);
    for (const p of commit.parents) stack.push(p);
  }
  c.m.set(oid, seen);
  return seen;
}

function aheadBehind(repo: MockRepo, a: string, b: string): { ahead: number; behind: number } {
  const sa = ancestors(repo, a);
  const sb = ancestors(repo, b);
  let ahead = 0;
  let behind = 0;
  for (const o of sa) if (!sb.has(o)) ahead++;
  for (const o of sb) if (!sa.has(o)) behind++;
  return { ahead, behind };
}

/** Resolves a branch, remote branch, tag, "HEAD" or (prefix of an) oid. */
function resolve(repo: MockRepo, name: string): string | null {
  if (name === "HEAD") return repo.head.oid;
  const b = repo.branches.get(name) ?? repo.remotes.get(name) ?? repo.tags.get(name)?.oid;
  if (b) return b;
  const stripped = name.replace(/^refs\/(heads|remotes|tags)\//, "");
  const s = repo.branches.get(stripped) ?? repo.remotes.get(stripped) ?? repo.tags.get(stripped)?.oid;
  if (s) return s;
  if (/^[0-9a-f]{4,40}$/i.test(name)) {
    const n = name.toLowerCase();
    for (let i = repo.commits.length - 1; i >= 0; i--) if (repo.commits[i].oid.startsWith(n)) return repo.commits[i].oid;
  }
  return null;
}

function needRef(repo: MockRepo, name: string): string {
  return resolve(repo, name) ?? fail(`Unknown revision: ${name}`, `fatal: ambiguous argument '${name}': unknown revision or path not in the working tree.`);
}

function labelsByOid(repo: MockRepo): Map<string, RefLabel[]> {
  const m = new Map<string, RefLabel[]>();
  const add = (oid: string, l: RefLabel) => {
    const a = m.get(oid);
    if (a) a.push(l);
    else m.set(oid, [l]);
  };
  if (repo.head.branch === null) add(repo.head.oid, { kind: "head", name: "HEAD", isCurrent: true });
  for (const [name, oid] of repo.branches) add(oid, { kind: "local", name, isCurrent: name === repo.head.branch });
  for (const [name, oid] of repo.remotes) if (!name.endsWith("/HEAD")) add(oid, { kind: "remote", name, isCurrent: false });
  for (const [name, t] of repo.tags) add(t.oid, { kind: "tag", name, isCurrent: false });
  return m;
}

const short = (oid: string) => oid.slice(0, 7);

/** Configured remote names; they may contain "/" (like git, which matches the longest configured remote). */
const remoteNamesOf = (repo: MockRepo): string[] => ["origin", ...(repo.extraRemotes ?? [])];
/** "team/fork/main" -> { remote: "team/fork", branch: "main" } by the longest configured remote; null when none matches. */
function splitRemoteRef(repo: MockRepo, full: string): { remote: string; branch: string } | null {
  const remote = remoteNamesOf(repo).filter((r) => full.startsWith(r + "/") && full.length > r.length + 1).sort((a, b) => b.length - a.length)[0];
  return remote === undefined ? null : { remote, branch: full.slice(remote.length + 1) };
}

// ---------------------------------------------------------------- refs, summaries, working tree

function buildRefs(repo: MockRepo): Refs {
  const local: LocalBranch[] = [];
  for (const [name, oid] of repo.branches) {
    const up = repo.upstreams.get(name) ?? null;
    const upOid = up ? repo.remotes.get(up) : undefined;
    const ab = upOid ? aheadBehind(repo, oid, upOid) : { ahead: 0, behind: 0 };
    local.push({
      name, oid, upstream: up && (upOid || repo.gone.has(name)) ? up : null,
      ahead: ab.ahead, behind: ab.behind, isHead: name === repo.head.branch, gone: repo.gone.has(name),
    });
  }
  local.sort((a, b) => (a.isHead === b.isHead ? a.name.localeCompare(b.name) : a.isHead ? -1 : 1));
  const remote = [...repo.remotes].map(([fullName, oid]) => {
    const sp = splitRemoteRef(repo, fullName) ?? { remote: fullName.slice(0, fullName.indexOf("/")), branch: fullName.slice(fullName.indexOf("/") + 1) };
    return { remote: sp.remote, name: sp.branch, fullName, oid };
  }).sort((a, b) => a.fullName.localeCompare(b.fullName));
  const tags = [...repo.tags].map(([name, t]) => ({ name, oid: t.oid, annotated: t.annotated }))
    .sort((a, b) => (repo.byOid.get(b.oid)?.seq ?? 0) - (repo.byOid.get(a.oid)?.seq ?? 0));
  return {
    local, remote, tags,
    stashes: repo.stashes.map((s) => ({ index: s.index, message: s.message, oid: s.oid, time: s.time })),
    remotes: remoteNamesOf(repo).map((name) => ({ name, url: repo.url })),
    submodules: repo.lang === "proto" ? [{ path: "vendor/googleapis", oid: hex40("sub" + repo.info.name), status: " " }] : [],
  };
}

function buildSummary(repo: MockRepo): RepoSummary {
  const branch = repo.head.branch;
  const upstream = branch ? repo.upstreams.get(branch) ?? null : null;
  const upOid = upstream ? repo.remotes.get(upstream) : undefined;
  const ab = upOid ? aheadBehind(repo, repo.head.oid, upOid) : { ahead: 0, behind: 0 };
  return {
    repoId: repo.info.id, branch, headOid: repo.head.oid, upstream: upOid ? upstream : null,
    ahead: ab.ahead, behind: ab.behind,
    staged: repo.wt.staged.length,
    unstaged: repo.wt.unstaged.filter((f) => f.status !== "untracked").length,
    untracked: repo.wt.unstaged.filter((f) => f.status === "untracked").length,
    conflicted: repo.wt.conflicted.length,
    state: repo.state, stashCount: repo.stashes.length,
  };
}

// ---------------------------------------------------------------- commits and files

const filesCache = new Map<string, FileChange[]>();

function commitFiles(repo: MockRepo, c: MockCommit): FileChange[] {
  const key = repo.info.id + c.oid;
  const hit = filesCache.get(key);
  if (hit) return hit;
  let out: FileChange[];
  if (c.files) {
    out = c.files.map((f) => toFileChange(f.path, f.oldPath ?? null, f.status, c.oid));
  } else {
    const r = hashRng(c.oid);
    const pool = repo.filePool;
    const n = c.parents.length > 1 ? 2 + Math.floor(r() * 4) : 1 + Math.floor(r() * r() * 6);
    const start = Math.floor(r() * pool.length);
    out = [];
    for (let i = 0; i < n && i < pool.length; i++) {
      const path = pool[(start + i * 3) % pool.length];
      if (out.some((f) => f.path === path)) continue;
      const x = r();
      if (x < 0.14) out.push(toFileChange(path, null, "added", c.oid));
      else if (x < 0.19) out.push(toFileChange(path, null, "deleted", c.oid));
      else if (x < 0.25 && path.includes("/")) out.push(toFileChange(path, path.replace(/\/([^/]+)$/, "/old_$1"), "renamed", c.oid));
      else out.push(toFileChange(path, null, "modified", c.oid));
    }
  }
  filesCache.set(key, out);
  return out;
}

function hashRng(seed: string): () => number {
  let a = hashStr(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function personOf(i: number, time: number) {
  const p = PEOPLE[i % PEOPLE.length];
  return { name: p.name, email: p.email, time, tz: p.tz };
}

/** Creates a commit on top of `parents` (used by every write command that records history). */
function makeCommit(repo: MockRepo, parents: string[], subject: string, body = "", time = Math.floor(Date.now() / 1000)): MockCommit {
  const seq = repo.commits.length;
  const oid = hex40(`${repo.info.name}:${seq}:${subject}:${time}:${Math.random()}`);
  const c: MockCommit = { oid, parents, seq, person: 0, time, subject, body };
  repo.commits.push(c);
  repo.byOid.set(oid, c);
  repo.version++;
  return c;
}

function advanceHead(repo: MockRepo, oid: string): void {
  if (repo.head.branch) repo.branches.set(repo.head.branch, oid);
  repo.head.oid = oid;
  repo.version++;
}

// ---------------------------------------------------------------- log sessions

interface Session {
  id: number;
  order: { repo: MockRepo; commit: MockCommit }[];
  graph: GraphRow[];
  labels: Map<string, Map<string, RefLabel[]>>;
}
const sessions: Session[] = [];
let sessionSeq = 0;

function visibleCommits(repo: MockRepo, q: LogQuery): MockCommit[] {
  let tips: string[];
  if (q.refs.length > 0) {
    tips = q.refs.map((r) => resolve(repo, r)).filter((x): x is string => x !== null);
  } else {
    tips = [...repo.branches.values(), ...repo.remotes.values(), ...[...repo.tags.values()].map((t) => t.oid), repo.head.oid];
  }
  const seen = new Set<string>();
  for (const t of tips) for (const o of ancestors(repo, t)) seen.add(o);
  let list: MockCommit[] = [];
  for (const o of seen) {
    const c = repo.byOid.get(o);
    if (c) list.push(c);
  }
  list.sort((a, b) => b.seq - a.seq);
  const text = q.text?.trim().toLowerCase();
  if (text) {
    const hex = /^[0-9a-f]{4,40}$/.test(text);
    list = list.filter((c) => c.subject.toLowerCase().includes(text) || c.body.toLowerCase().includes(text) || (hex && c.oid.startsWith(text)));
  }
  const author = q.author?.trim().toLowerCase();
  if (author) list = list.filter((c) => PEOPLE[c.person % PEOPLE.length].name.toLowerCase().includes(author) || PEOPLE[c.person % PEOPLE.length].email.toLowerCase().includes(author));
  if (q.since != null) list = list.filter((c) => c.time >= (q.since as number));
  if (q.until != null) list = list.filter((c) => c.time <= (q.until as number));
  const path = q.path?.trim();
  if (path) list = list.filter((c) => commitFiles(repo, c).some((f) => f.path.includes(path)));
  return list;
}

function openLog(q: LogQuery): LogSessionInfo {
  const maxCount = q.maxCount && q.maxCount > 0 ? q.maxCount : 50_000;
  const per = q.repoIds.map((id) => repoOf(id));
  let truncated = false;
  const lists = per.map((repo) => {
    const l = visibleCommits(repo, q);
    if (l.length > maxCount) {
      truncated = true;
      l.length = maxCount;
    }
    return l;
  });
  const filtered = Boolean(q.text?.trim() || q.author?.trim() || q.path?.trim() || q.since != null || q.until != null);
  // k-way merge by committer time (only list fronts are popped, so each repo keeps its order)
  const idx = lists.map(() => 0);
  const order: Session["order"] = [];
  for (;;) {
    let best = -1;
    for (let i = 0; i < lists.length; i++) {
      if (idx[i] >= lists[i].length) continue;
      if (best < 0 || lists[i][idx[i]].time > lists[best][idx[best]].time) best = i;
    }
    if (best < 0) break;
    order.push({ repo: per[best], commit: lists[best][idx[best]++] });
  }
  const { rows, maxLanes } = layoutGraph(
    order.map(({ repo, commit }) => ({
      key: repo.info.id + commit.oid,
      parents: filtered ? [] : commit.parents.map((p) => repo.info.id + p),
    })),
    [],
    { stableFirstParent: true },
  );
  const labels = new Map<string, Map<string, RefLabel[]>>();
  for (const repo of per) labels.set(repo.info.id, labelsByOid(repo));
  const s: Session = { id: ++sessionSeq, order, graph: rows, labels };
  sessions.push(s);
  while (sessions.length > 4) sessions.shift();
  return { sessionId: s.id, total: order.length, maxLanes, truncated, skipped: [] };
}

function sessionRows(a: Args): CommitRow[] {
  const s = sessions.find((x) => x.id === num(a.sessionId));
  if (!s) fail("Log session expired", "The session was evicted; open a new one.");
  const start = Math.max(0, num(a.start));
  const end = Math.min(s.order.length, start + num(a.count, 200));
  const out: CommitRow[] = [];
  for (let i = start; i < end; i++) {
    const { repo, commit: c } = s.order[i];
    const p = PEOPLE[c.person % PEOPLE.length];
    out.push({
      repoId: repo.info.id, oid: c.oid, parents: c.parents,
      authorName: p.name, authorEmail: p.email,
      authorTime: c.time - (hashStr(c.oid) % 6 === 0 ? 1800 : 0), committerTime: c.time,
      subject: c.subject, refs: s.labels.get(repo.info.id)?.get(c.oid) ?? [], graph: s.graph[i],
    });
  }
  return out;
}

// ---------------------------------------------------------------- diffs and details

function commitDetails(repo: MockRepo, oid: string): CommitDetails {
  const full = resolve(repo, oid);
  const c = full ? repo.byOid.get(full) : undefined;
  if (!c) fail(`Unknown commit ${oid}`, `fatal: bad object ${oid}`);
  const committerIdx = hashStr(c.oid) % 11 === 0 ? (c.person + 1) % PEOPLE.length : c.person;
  return {
    repoId: repo.info.id, oid: c.oid, parents: c.parents,
    author: personOf(c.person, c.time - (hashStr(c.oid) % 6 === 0 ? 1800 : 0)),
    committer: personOf(committerIdx, c.time),
    subject: c.subject, body: c.body,
    refs: labelsByOid(repo).get(c.oid) ?? [],
    files: commitFiles(repo, c),
  };
}

function fileDiff(repo: MockRepo, spec: DiffSpec, path: string, oldPath: string | null, context: number): FileDiff {
  let status: "added" | "modified" | "deleted" = "modified";
  let seed = path;
  if (spec.kind === "commit") {
    const full = resolve(repo, spec.oid);
    const c = full ? repo.byOid.get(full) : undefined;
    const f = c ? commitFiles(repo, c).find((x) => x.path === path) : undefined;
    if (f) status = f.status === "added" ? "added" : f.status === "deleted" ? "deleted" : "modified";
    seed = (full ?? spec.oid) + (spec.parent ?? "");
  } else {
    const list = spec.kind === "staged" ? repo.wt.staged : repo.wt.unstaged;
    const f = list.find((x) => x.path === path);
    if (f) status = f.status === "added" || f.status === "untracked" ? "added" : f.status === "deleted" ? "deleted" : "modified";
    seed = (spec.kind === "staged" ? "wt-staged-" : f?.status === "untracked" ? "wt-untracked-" : "wt-unstaged-") + path;
  }
  if (path.endsWith(".png")) return { path, oldPath, binary: true, hunks: [], tooLarge: false };
  return buildFileDiff(path, oldPath, seed, status, context);
}

// ---------------------------------------------------------------- write helpers

const ok = (message = ""): OpResult => ({ ok: true, message, conflicts: false });
const notOk = (message: string): OpResult => ({ ok: false, message, conflicts: false });
const conflict = (message: string): OpResult => ({ ok: false, message, conflicts: true });

const wtDirty = (repo: MockRepo) => repo.wt.staged.length + repo.wt.unstaged.filter((f) => f.status !== "untracked").length > 0;
const wouldConflict = (name: string) => /spike|conflict/i.test(name);

function enterConflictState(repo: MockRepo, kind: "merging" | "rebasing" | "cherryPicking" | "reverting"): void {
  repo.state = kind;
  const pool = repo.filePool;
  repo.wt.conflicted = [pool[1 % pool.length], pool[4 % pool.length]].map((p) => ({ path: p, oldPath: null, status: "conflicted", additions: null, deletions: null, binary: false }));
}

function rebaseOnto(repo: MockRepo, ontoOid: string): string {
  const ancOnto = ancestors(repo, ontoOid);
  const unique = [...ancestors(repo, repo.head.oid)].filter((o) => !ancOnto.has(o)).map((o) => repo.byOid.get(o) as MockCommit).sort((a, b) => a.seq - b.seq);
  if (unique.length === 0) return ontoOid;
  const inUnique = new Set(unique.map((c) => c.oid));
  const map = new Map<string, string>();
  const t = Math.floor(Date.now() / 1000);
  let tip = ontoOid;
  for (const c of unique) {
    if (c.parents.length > 1) {
      map.set(c.oid, map.get(c.parents[0]) ?? tip);
      continue;
    }
    const parent = c.parents[0] && inUnique.has(c.parents[0]) ? map.get(c.parents[0]) ?? tip : ontoOid;
    const copy = makeCommit(repo, [parent], c.subject, c.body, t);
    copy.person = c.person;
    map.set(c.oid, copy.oid);
    tip = copy.oid;
  }
  return tip;
}

function wtStatusCounts(repo: MockRepo): string {
  return `${repo.wt.staged.length} file${repo.wt.staged.length === 1 ? "" : "s"} changed`;
}

// ---------------------------------------------------------------- command handlers

interface Ctx {
  delay: number;
  git(repo: MockRepo | null, args: string[], out?: { stdout?: string; stderr?: string; exit?: number }): void;
}

type Handler = (a: Args, c: Ctx) => unknown;

/** `Option<u8>` argument: a missing or null value is None; anything else that is not an integer 0..255 is rejected like serde does. */
function colorArg(a: Args, key: string, cmd: string): number | null {
  const v = a[key];
  if (v === undefined || v === null) return null;
  if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 255) return v;
  fail(`invalid args \`${key}\` for command \`${cmd}\`: invalid value`);
}

/** `Option<String>` argument. */
function customArg(a: Args, cmd: string): string | null {
  const v = a.custom;
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v;
  fail(`invalid args \`custom\` for command \`${cmd}\`: invalid type`);
}

const READ_FAST = new Set(["log_rows", "log_find", "log_close", "workspace_load", "workspace_save_ui", "project_set_active", "project_remove", "repo_set_color", "project_set_color"]);

const handlers: Record<string, Handler> = {
  // ---- workspace
  workspace_load: () => structuredClone(workspace),
  workspace_save_ui: (a) => {
    workspace.ui = a.ui ?? {};
  },
  project_add: (a) => {
    const path = str(a.path).replace(/\/+$/, "");
    const name = path.split("/").pop() || "project";
    const existing = workspace.projects.find((p) => p.path === path);
    if (existing) return structuredClone(existing);
    const defs: [string, string][] = [[path, name], [`${path}/api`, "api"], [`${path}/web`, "web"]];
    const project: Project = { id: "p-" + hex40(path).slice(0, 8), name, path, repos: [], color: 0, customColor: null };
    for (const [p, n] of defs) project.repos.push({ id: repoId(p), name: n, path: p, color: 0, customColor: null });
    addColoredProject(workspace, project);
    for (const info of project.repos) registerRepo(info, genericScenario(info.name, info.color));
    workspace.activeProjectId = project.id;
    return structuredClone(project);
  },
  project_remove: (a) => {
    workspace.projects = workspace.projects.filter((p) => p.id !== str(a.projectId));
    if (workspace.activeProjectId === str(a.projectId)) workspace.activeProjectId = workspace.projects[0]?.id ?? null;
  },
  project_rescan: (a) => {
    const p = workspace.projects.find((x) => x.id === str(a.projectId)) ?? fail("Project not found");
    // the mock finds the same repos again; a real rescan keeps their colours, so nothing changes
    return structuredClone(p);
  },
  repo_set_color: (a) => {
    const choice = parseColorChoice(colorArg(a, "color", "repo_set_color"), customArg(a, "repo_set_color"));
    if (typeof choice === "string") fail(choice);
    return setRepoColor(workspace, str(a.repoId), choice) ?? fail("unknown repository");
  },
  project_set_color: (a) => {
    const choice = parseColorChoice(colorArg(a, "color", "project_set_color"), customArg(a, "project_set_color"));
    if (typeof choice === "string") fail(choice);
    return setProjectColor(workspace, str(a.projectId), choice) ?? fail("unknown project");
  },
  project_set_active: (a) => {
    workspace.activeProjectId = str(a.projectId);
  },
  repo_summaries: (a, c) => {
    return strs(a.repoIds).map((id) => {
      const repo = repoOf(id);
      c.git(repo, ["status", "--porcelain=v2", "--branch", "--show-stash"], { stdout: `# branch.oid ${repo.head.oid}\n# branch.head ${repo.head.branch ?? "(detached)"}\n` });
      return buildSummary(repo);
    });
  },

  // ---- log
  log_open: (a, c) => {
    const q = a.query as LogQuery;
    const info = openLog(q);
    for (const id of q.repoIds) {
      const repo = repoOf(id);
      const args = ["log", "--topo-order", "--date-order", "--no-color", `--max-count=${q.maxCount || 50000}`, "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%ct%x1f%s%x1e"];
      if (q.text) args.push(`--grep=${q.text}`, "-i");
      if (q.author) args.push(`--author=${q.author}`, "-i");
      args.push(...(q.refs.length ? q.refs : ["--branches", "--remotes", "--tags", "HEAD"]));
      if (q.path) args.push("--", q.path);
      c.git(repo, args);
    }
    return info;
  },
  log_rows: (a) => sessionRows(a),
  log_find: (a) => {
    const s = sessions.find((x) => x.id === num(a.sessionId));
    if (!s) return null;
    const oid = str(a.oid).toLowerCase();
    const repoId = optStr(a.repoId);
    const i = s.order.findIndex((o) => o.commit.oid.startsWith(oid) && (!repoId || o.repo.info.id === repoId));
    return i < 0 ? null : i;
  },
  log_close: (a) => {
    const i = sessions.findIndex((x) => x.id === num(a.sessionId));
    if (i >= 0) sessions.splice(i, 1);
  },

  // ---- read
  refs: (a, c) => {
    const repo = repoOf(a.repoId);
    c.git(repo, ["for-each-ref", "--format=%(objectname)%00%(*objectname)%00%(refname)%00%(HEAD)", "refs/heads", "refs/remotes", "refs/tags"]);
    return buildRefs(repo);
  },
  commit_details: (a, c) => {
    const repo = repoOf(a.repoId);
    const d = commitDetails(repo, str(a.oid));
    c.git(repo, ["show", "--no-patch", "--format=%H%n%P%n%an%n%ae%n%at%n%s%n%b", d.oid]);
    c.git(repo, ["diff-tree", "--no-commit-id", "--numstat", "-r", "-M", "--root", d.oid]);
    return d;
  },
  branches_containing: (a, c) => {
    const repo = repoOf(a.repoId);
    const oid = needRef(repo, str(a.oid));
    c.git(repo, ["branch", "-a", "--contains", oid, "--format=%(refname:short)"]);
    const out: string[] = [];
    for (const [n, o] of repo.branches) if (ancestors(repo, o).has(oid)) out.push(n);
    for (const [n, o] of repo.remotes) if (ancestors(repo, o).has(oid)) out.push(n);
    return out;
  },
  working_tree: (a, c): WorkingTree => {
    const repo = repoOf(a.repoId);
    c.git(repo, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
    return {
      repoId: repo.info.id,
      staged: structuredClone(repo.wt.staged),
      unstaged: structuredClone(repo.wt.unstaged),
      conflicted: structuredClone(repo.wt.conflicted),
    };
  },
  file_diff: (a, c) => {
    const repo = repoOf(a.repoId);
    const spec = a.spec as DiffSpec;
    const context = num(a.context, 3);
    const path = str(a.path);
    const args = ["diff", "--no-color", `-U${context}`];
    if (spec.kind === "staged") args.push("--cached");
    if (spec.kind === "commit") args.push(`${spec.parent ?? spec.oid + "^"}`, spec.oid);
    c.git(repo, [...args, "--", path]);
    return fileDiff(repo, spec, path, optStr(a.oldPath), context);
  },
  file_content: (a, c) => {
    const repo = repoOf(a.repoId);
    const rev = optStr(a.rev);
    c.git(repo, rev ? ["show", `${rev}:${str(a.path)}`] : ["cat-file", "--filters", str(a.path)]);
    return fileText(str(a.path), rev ?? "worktree");
  },
  last_commit_message: (a, c) => {
    const repo = repoOf(a.repoId);
    c.git(repo, ["log", "-1", "--format=%B"]);
    const h = repo.byOid.get(repo.head.oid);
    return h ? (h.body ? `${h.subject}\n\n${h.body}` : h.subject) : "";
  },

  // ---- index and working tree
  stage: (a, c) => {
    const repo = repoOf(a.repoId);
    const paths = strs(a.paths);
    for (const p of paths) {
      for (const list of [repo.wt.unstaged, repo.wt.conflicted]) {
        const i = list.findIndex((f) => f.path === p);
        if (i < 0) continue;
        const [f] = list.splice(i, 1);
        const status = f.status === "untracked" ? "added" : f.status === "conflicted" ? "modified" : f.status;
        const prev = repo.wt.staged.findIndex((s) => s.path === p);
        const next = f.status === "conflicted" ? toFileChange(p, null, "modified", "wt-staged-" + p) : { ...f, status };
        if (prev >= 0) repo.wt.staged[prev] = next;
        else repo.wt.staged.push(next);
      }
    }
    c.git(repo, ["add", "--", ...paths]);
    emitChanged(repo);
  },
  unstage: (a, c) => {
    const repo = repoOf(a.repoId);
    const paths = strs(a.paths);
    for (const p of paths) {
      const i = repo.wt.staged.findIndex((f) => f.path === p);
      if (i < 0) continue;
      const [f] = repo.wt.staged.splice(i, 1);
      repo.wt.unstaged.push({ ...f, status: f.status === "added" ? "untracked" : f.status });
    }
    c.git(repo, ["restore", "--staged", "--", ...paths]);
    emitChanged(repo);
  },
  discard: (a, c) => {
    const repo = repoOf(a.repoId);
    const paths = strs(a.paths);
    repo.wt.unstaged = repo.wt.unstaged.filter((f) => !paths.includes(f.path));
    repo.wt.conflicted = repo.wt.conflicted.filter((f) => !paths.includes(f.path));
    c.git(repo, ["restore", "--worktree", "--", ...paths]);
    emitChanged(repo);
  },
  stage_hunk: (a, c) => {
    const repo = repoOf(a.repoId);
    const path = str(a.path);
    const reverse = bool(a.reverse);
    const staged = repo.wt.staged.findIndex((f) => f.path === path);
    if (!reverse && staged < 0) repo.wt.staged.push(toFileChange(path, null, "modified", "wt-staged-" + path));
    if (reverse && staged >= 0) repo.wt.staged.splice(staged, 1);
    c.git(repo, ["apply", "--cached", ...(reverse ? ["-R"] : []), "--unidiff-zero=false", "-"]);
    emitChanged(repo);
  },
  discard_hunk: (a, c) => {
    const repo = repoOf(a.repoId);
    c.git(repo, ["apply", "-R", "--unidiff-zero=false", "-"]);
    emitChanged(repo);
  },
  commit: (a, c) => {
    const repo = repoOf(a.repoId);
    const message = str(a.message).trim();
    const amend = bool(a.amend);
    if (!message) fail("Aborting commit due to empty commit message.", "Aborting commit due to empty commit message.");
    if (repo.wt.staged.length === 0 && !amend) return notOk("nothing to commit");
    const [subject, ...rest] = message.split("\n");
    const head = repo.byOid.get(repo.head.oid);
    const parents = amend && head ? head.parents : [repo.head.oid];
    const n = wtStatusCounts(repo);
    const commit = makeCommit(repo, parents, subject, rest.join("\n").trim());
    advanceHead(repo, commit.oid);
    repo.wt.staged = [];
    c.git(repo, ["commit", ...(amend ? ["--amend"] : []), "-m", subject], { stdout: `[${repo.head.branch ?? "HEAD detached"} ${short(commit.oid)}] ${subject}\n ${n}\n` });
    emitChanged(repo);
    return ok(`[${repo.head.branch ?? "HEAD"} ${short(commit.oid)}] ${subject}\n ${n}`);
  },

  // ---- branches
  checkout: (a, c) => {
    const repo = repoOf(a.repoId);
    const target = str(a.target);
    const newBranch = optStr(a.newBranch);
    if (repo.state !== "clean") return notOk(`error: you need to resolve your current index first (${repo.state} in progress)`);
    if (newBranch) {
      if (repo.branches.has(newBranch)) fail(`A branch named '${newBranch}' already exists`, `fatal: a branch named '${newBranch}' already exists`);
      const oid = needRef(repo, target);
      repo.branches.set(newBranch, oid);
      if (repo.remotes.has(target)) {
        repo.upstreams.set(newBranch, target);
        c.git(repo, ["checkout", "-b", newBranch, "--track", target], { stderr: `branch '${newBranch}' set up to track '${target}'.\nSwitched to a new branch '${newBranch}'\n` });
      } else {
        c.git(repo, ["checkout", "-b", newBranch, target], { stderr: `Switched to a new branch '${newBranch}'\n` });
      }
      repo.head = { branch: newBranch, oid };
    } else if (repo.branches.has(target)) {
      repo.head = { branch: target, oid: repo.branches.get(target) as string };
      c.git(repo, ["checkout", target], { stderr: `Switched to branch '${target}'\n` });
    } else if (repo.remotes.has(target)) {
      const local = splitRemoteRef(repo, target)?.branch ?? target.slice(target.indexOf("/") + 1);
      if (repo.branches.has(local)) {
        repo.head = { branch: local, oid: repo.branches.get(local) as string };
      } else {
        repo.branches.set(local, repo.remotes.get(target) as string);
        repo.upstreams.set(local, target);
        repo.head = { branch: local, oid: repo.remotes.get(target) as string };
      }
      c.git(repo, ["checkout", local], { stderr: `Switched to branch '${local}'\n` });
    } else {
      const oid = needRef(repo, target);
      repo.head = { branch: null, oid };
      c.git(repo, ["checkout", "--detach", target], { stderr: `HEAD is now at ${short(oid)}\n` });
    }
    emitChanged(repo);
    return ok(`Switched to ${repo.head.branch ? `branch '${repo.head.branch}'` : "detached HEAD " + short(repo.head.oid)}`);
  },
  branch_create: (a, c) => {
    const repo = repoOf(a.repoId);
    const name = str(a.name);
    if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.endsWith("/") || name.includes("..")) fail(`'${name}' is not a valid branch name`, `fatal: '${name}' is not a valid branch name`);
    if (repo.branches.has(name)) fail(`A branch named '${name}' already exists`, `fatal: a branch named '${name}' already exists`);
    const oid = needRef(repo, str(a.startPoint, "HEAD"));
    repo.branches.set(name, oid);
    if (bool(a.checkout)) repo.head = { branch: name, oid };
    c.git(repo, bool(a.checkout) ? ["checkout", "-b", name, str(a.startPoint, "HEAD")] : ["branch", name, str(a.startPoint, "HEAD")]);
    emitChanged(repo);
    return ok(`Created branch '${name}' at ${short(oid)}`);
  },
  branch_delete: (a, c) => {
    const repo = repoOf(a.repoId);
    const name = str(a.name);
    if (bool(a.remote)) {
      // like Rust: the name must be "<remote>/<branch>" with a configured remote
      const split = splitRemoteRef(repo, name);
      if (!split) fail(`${name} does not belong to a configured remote`, `error: '${name}' does not belong to a configured remote`);
      const { remote, branch } = split;
      if (!repo.remotes.has(name)) fail(`remote ref does not exist: ${name}`, `error: unable to delete '${branch}': remote ref does not exist`);
      repo.remotes.delete(name);
      c.git(repo, ["push", remote, "--delete", branch], { stderr: `To ${repo.url}\n - [deleted]         ${branch}\n` });
      emitChanged(repo);
      return ok(`Deleted remote branch ${name}`);
    }
    const oid = repo.branches.get(name);
    if (!oid) fail(`Branch '${name}' not found`, `error: branch '${name}' not found.`);
    if (repo.head.branch === name) fail(`Cannot delete the branch '${name}' which is checked out`, `error: cannot delete branch '${name}' used by worktree`);
    const mainTip = repo.branches.get("main") ?? repo.head.oid;
    if (!bool(a.force) && !ancestors(repo, mainTip).has(oid) && !ancestors(repo, repo.head.oid).has(oid)) {
      fail(`The branch '${name}' is not fully merged`, `error: the branch '${name}' is not fully merged.\nIf you are sure you want to delete it, run 'git branch -D ${name}'.`);
    }
    repo.branches.delete(name);
    repo.upstreams.delete(name);
    repo.gone.delete(name);
    c.git(repo, ["branch", bool(a.force) ? "-D" : "-d", name], { stdout: `Deleted branch ${name} (was ${short(oid)}).\n` });
    emitChanged(repo);
    return ok(`Deleted branch ${name} (was ${short(oid)}).`);
  },
  branch_rename: (a, c) => {
    const repo = repoOf(a.repoId);
    const oldName = str(a.oldName);
    const newName = str(a.newName);
    const oid = repo.branches.get(oldName) ?? fail(`Branch '${oldName}' not found`, `error: refname refs/heads/${oldName} not found`);
    if (repo.branches.has(newName)) fail(`A branch named '${newName}' already exists`, `fatal: a branch named '${newName}' already exists.`);
    repo.branches.delete(oldName);
    repo.branches.set(newName, oid);
    const up = repo.upstreams.get(oldName);
    if (up) {
      repo.upstreams.delete(oldName);
      repo.upstreams.set(newName, up);
    }
    if (repo.head.branch === oldName) repo.head.branch = newName;
    c.git(repo, ["branch", "-m", oldName, newName]);
    emitChanged(repo);
    return ok(`Branch '${oldName}' renamed to '${newName}'`);
  },

  // ---- integration
  merge: (a, c) => {
    const repo = repoOf(a.repoId);
    const target = str(a.target);
    const oid = needRef(repo, target);
    const noFf = bool(a.noFf);
    const squash = bool(a.squash);
    const flags = [...(noFf ? ["--no-ff"] : []), ...(squash ? ["--squash"] : [])];
    if (ancestors(repo, repo.head.oid).has(oid)) {
      c.git(repo, ["merge", ...flags, target], { stdout: "Already up to date.\n" });
      return ok("Already up to date.");
    }
    if (wouldConflict(target)) {
      enterConflictState(repo, "merging");
      c.git(repo, ["merge", ...flags, target], { stdout: `Auto-merging ${repo.wt.conflicted[0].path}\nCONFLICT (content): Merge conflict in ${repo.wt.conflicted[0].path}\nAutomatic merge failed; fix conflicts and then commit the result.\n`, exit: 1 });
      emitChanged(repo);
      return conflict(`CONFLICT (content): Merge conflict in ${repo.wt.conflicted[0].path}\nAutomatic merge failed; fix conflicts and then commit the result.`);
    }
    const fastForward = ancestors(repo, oid).has(repo.head.oid) && !noFf && !squash;
    if (fastForward) {
      advanceHead(repo, oid);
      c.git(repo, ["merge", ...flags, target], { stdout: `Updating ${short(repo.head.oid)}..${short(oid)}\nFast-forward\n` });
    } else if (squash) {
      repo.wt.staged = commitFiles(repo, repo.byOid.get(oid) as MockCommit).slice(0, 3);
      c.git(repo, ["merge", ...flags, target], { stdout: "Squash commit -- not updating HEAD\n" });
    } else {
      const m = makeCommit(repo, [repo.head.oid, oid], `Merge branch '${target}' into ${repo.head.branch ?? "HEAD"}`);
      advanceHead(repo, m.oid);
      c.git(repo, ["merge", ...flags, target], { stdout: "Merge made by the 'ort' strategy.\n" });
    }
    emitChanged(repo);
    return ok(fastForward ? "Fast-forward" : "Merge made by the 'ort' strategy.");
  },
  rebase: (a, c) => {
    const repo = repoOf(a.repoId);
    const onto = str(a.onto);
    const oid = needRef(repo, onto);
    if (!repo.head.branch) return notOk("fatal: cannot rebase: you are not on a branch");
    if (ancestors(repo, oid).has(repo.head.oid) && oid !== repo.head.oid) {
      advanceHead(repo, oid);
      c.git(repo, ["rebase", onto], { stderr: `Successfully rebased and updated refs/heads/${repo.head.branch}.\n` });
      emitChanged(repo);
      return ok("Fast-forwarded");
    }
    if (wouldConflict(onto)) {
      enterConflictState(repo, "rebasing");
      c.git(repo, ["rebase", onto], { stdout: `CONFLICT (content): Merge conflict in ${repo.wt.conflicted[0].path}\nerror: could not apply ${short(repo.head.oid)}... \n`, exit: 1 });
      emitChanged(repo);
      return conflict(`CONFLICT (content): Merge conflict in ${repo.wt.conflicted[0].path}`);
    }
    const tip = rebaseOnto(repo, oid);
    advanceHead(repo, tip);
    c.git(repo, ["rebase", onto], { stderr: `Successfully rebased and updated refs/heads/${repo.head.branch}.\n` });
    emitChanged(repo);
    return ok(`Successfully rebased and updated refs/heads/${repo.head.branch}.`);
  },
  cherry_pick: (a, c) => {
    const repo = repoOf(a.repoId);
    const oids = strs(a.oids).map((o) => needRef(repo, o));
    for (const oid of oids) {
      const src = repo.byOid.get(oid) as MockCommit;
      const copy = makeCommit(repo, [repo.head.oid], src.subject, src.body);
      copy.person = src.person;
      advanceHead(repo, copy.oid);
    }
    c.git(repo, ["cherry-pick", ...oids.map(short)]);
    emitChanged(repo);
    return ok(`Cherry-picked ${oids.length} commit${oids.length === 1 ? "" : "s"}`);
  },
  revert: (a, c) => {
    const repo = repoOf(a.repoId);
    const oid = needRef(repo, str(a.oid));
    const src = repo.byOid.get(oid) as MockCommit;
    const rev = makeCommit(repo, [repo.head.oid], `Revert "${src.subject}"`, `This reverts commit ${oid}.`);
    advanceHead(repo, rev.oid);
    c.git(repo, ["revert", "--no-edit", oid]);
    emitChanged(repo);
    return ok(`Reverted ${short(oid)}`);
  },
  reset: (a, c) => {
    const repo = repoOf(a.repoId);
    const target = str(a.target);
    const mode = str(a.mode, "mixed") as ResetMode;
    const oid = needRef(repo, target);
    advanceHead(repo, oid);
    if (mode === "hard") {
      repo.wt.staged = [];
      repo.wt.unstaged = repo.wt.unstaged.filter((f) => f.status === "untracked");
    } else if (mode === "mixed") {
      for (const f of repo.wt.staged) repo.wt.unstaged.push({ ...f, status: f.status === "added" ? "untracked" : f.status });
      repo.wt.staged = [];
    }
    c.git(repo, ["reset", `--${mode}`, target], { stdout: mode === "hard" ? `HEAD is now at ${short(oid)} ${repo.byOid.get(oid)?.subject ?? ""}\n` : "" });
    emitChanged(repo);
    return ok(`HEAD is now at ${short(oid)}`);
  },
  op_continue: (a, c) => {
    const repo = repoOf(a.repoId);
    if (repo.state === "clean") return notOk("No operation in progress");
    const kind = repo.state;
    const sub = kind === "rebasing" ? "rebase" : kind === "merging" ? "merge" : kind === "cherryPicking" ? "cherry-pick" : "revert";
    if (repo.wt.conflicted.length > 0) {
      c.git(repo, [sub, "--continue"], { stderr: "error: Committing is not possible because you have unmerged files.\n", exit: 1 });
      return conflict(`${repo.wt.conflicted.length} files still have conflicts`);
    }
    repo.state = "clean";
    c.git(repo, [sub, "--continue"], { stdout: "Successfully rebased\n" });
    emitChanged(repo);
    return ok("Operation completed");
  },
  op_abort: (a, c) => {
    const repo = repoOf(a.repoId);
    if (repo.state === "clean") return notOk("No operation in progress");
    const sub = repo.state === "rebasing" ? "rebase" : repo.state === "merging" ? "merge" : repo.state === "cherryPicking" ? "cherry-pick" : "revert";
    repo.state = "clean";
    repo.wt.conflicted = [];
    c.git(repo, [sub, "--abort"]);
    emitChanged(repo);
    return ok("Operation aborted");
  },
  op_skip: (a, c) => {
    const repo = repoOf(a.repoId);
    if (repo.state === "clean") return notOk("No operation in progress");
    const sub = repo.state === "rebasing" ? "rebase" : "cherry-pick";
    repo.state = "clean";
    repo.wt.conflicted = [];
    c.git(repo, [sub, "--skip"]);
    emitChanged(repo);
    return ok("Skipped");
  },

  // ---- remotes
  fetch: (a, c) => {
    const repo = repoOf(a.repoId);
    repo.fetches++;
    const remote = optStr(a.remote);
    const args = ["fetch", ...(remote ? [remote] : ["--all"]), ...(bool(a.prune) ? ["--prune"] : [])];
    let message = "";
    // every third fetch of a repo brings one new commit on origin/main
    if (repo.fetches % 3 === 0) {
      const tip = repo.remotes.get("origin/main") ?? repo.head.oid;
      const commit = makeCommit(repo, [tip], "Bump dependencies", "", Math.floor(Date.now() / 1000) - 60);
      commit.person = 1 + (repo.fetches % 5);
      repo.remotes.set("origin/main", commit.oid);
      message = `From ${repo.url}\n   ${short(tip)}..${short(commit.oid)}  main       -> origin/main`;
    }
    c.git(repo, args, { stderr: message });
    emitChanged(repo);
    return ok(message || "Already up to date.");
  },
  pull: (a, c) => {
    const repo = repoOf(a.repoId);
    const up = repo.head.branch ? repo.upstreams.get(repo.head.branch) : undefined;
    const upOid = up ? repo.remotes.get(up) : undefined;
    if (!repo.head.branch || !up || !upOid) return notOk("There is no tracking information for the current branch.");
    const ab = aheadBehind(repo, repo.head.oid, upOid);
    const rebase = bool(a.rebase);
    if (ab.behind === 0) {
      c.git(repo, ["pull", ...(rebase ? ["--rebase"] : [])], { stdout: "Already up to date.\n" });
      return ok("Already up to date.");
    }
    if (ab.ahead === 0) advanceHead(repo, upOid);
    else if (rebase) advanceHead(repo, rebaseOnto(repo, upOid));
    else advanceHead(repo, makeCommit(repo, [repo.head.oid, upOid], `Merge branch '${repo.head.branch}' of ${repo.url}`).oid);
    c.git(repo, ["pull", ...(rebase ? ["--rebase"] : [])], { stdout: `Updating...\nFast-forward\n ${ab.behind} commits\n` });
    emitChanged(repo);
    return ok(`Pulled ${ab.behind} commit${ab.behind === 1 ? "" : "s"}`);
  },
  push: (a, c) => {
    const repo = repoOf(a.repoId);
    const branch = optStr(a.branch) ?? repo.head.branch;
    if (!branch) fail("You are not on a branch", "fatal: You are not currently on a branch.");
    const upstream = repo.upstreams.get(branch);
    const upSplit = upstream ? splitRemoteRef(repo, upstream) : null;
    // `git push` without a refspec needs an upstream (push.default=simple) with the same branch name
    if (!optStr(a.branch)) {
      if (!upstream) {
        fail(`The current branch ${branch} has no upstream branch`, `fatal: The current branch ${branch} has no upstream branch.\nTo push the current branch and set the remote as upstream, use\n\n    git push --set-upstream origin ${branch}`);
      }
      if (upSplit && upSplit.branch !== branch) {
        fail(`The upstream branch of ${branch} (${upstream}) does not match its name`, `fatal: The upstream branch of your current branch does not match\nthe name of your current branch.  To push to the upstream branch\non the remote, use\n\n    git push ${upSplit.remote} HEAD:${upSplit.branch}\n\nTo push to the branch of the same name on the remote, use\n\n    git push ${upSplit.remote} HEAD`);
      }
    }
    const remote = optStr(a.remote) ?? upSplit?.remote ?? "origin";
    if (!remoteNamesOf(repo).includes(remote)) fail(`'${remote}' does not appear to be a git repository`, `fatal: '${remote}' does not appear to be a git repository`);
    const oid = repo.branches.get(branch) ?? fail(`Branch '${branch}' not found`, `error: src refspec ${branch} does not match any`);
    // like `git push <remote> <branch>`: the remote branch has the local name, whatever the upstream is
    const key = `${remote}/${branch}`;
    const remoteOid = repo.remotes.get(key);
    if (remoteOid && !bool(a.force) && !ancestors(repo, oid).has(remoteOid)) {
      const n = aheadBehind(repo, oid, remoteOid).behind;
      c.git(repo, ["push", "--porcelain", remote, `refs/heads/${branch}:refs/heads/${branch}`], {
        stderr: `To ${repo.url}\n!\trefs/heads/${branch}:refs/heads/${branch}\t[rejected] (fetch first)\n`, exit: 1,
      });
      fail(`Push rejected by ${remote}. The remote has ${n} new commit${n === 1 ? "" : "s"}. Pull, then push again.`, `! [rejected]        ${branch} -> ${branch} (fetch first)\nerror: failed to push some refs to '${repo.url}'`);
    }
    const n = remoteOid ? aheadBehind(repo, oid, remoteOid).ahead : ancestors(repo, oid).size;
    repo.remotes.set(key, oid);
    if (bool(a.setUpstream) || !repo.upstreams.has(branch)) repo.upstreams.set(branch, key);
    c.git(repo, ["push", "--porcelain", ...(bool(a.force) ? ["--force-with-lease"] : []), ...(bool(a.setUpstream) ? ["--set-upstream"] : []), remote, `refs/heads/${branch}:refs/heads/${branch}`], {
      stdout: `To ${repo.url}\n${remoteOid ? " " : "*"}\trefs/heads/${branch}:refs/heads/${branch}\t${remoteOid ? `${short(remoteOid)}..${short(oid)}` : "[new branch]"}\nDone\n`,
    });
    emitChanged(repo);
    return ok(`Pushed ${branch} (${n} commit${n === 1 ? "" : "s"})`);
  },

  // ---- stash and tags
  stash_save: (a, c) => {
    const repo = repoOf(a.repoId);
    const includeUntracked = bool(a.includeUntracked);
    const staged = bool(a.keepIndex) ? [] : repo.wt.staged;
    const unstaged = repo.wt.unstaged.filter((f) => f.status !== "untracked" || includeUntracked);
    if (staged.length + unstaged.length === 0 && !wtDirty(repo)) return notOk("No local changes to save");
    const head = repo.byOid.get(repo.head.oid);
    const message = optStr(a.message) || `WIP on ${repo.head.branch ?? "(no branch)"}: ${short(repo.head.oid)} ${head?.subject ?? ""}`;
    repo.stashes.forEach((s) => s.index++);
    repo.stashes.unshift({ index: 0, message, oid: hex40("stash" + Date.now() + Math.random()), time: Math.floor(Date.now() / 1000), staged, unstaged });
    if (!bool(a.keepIndex)) repo.wt.staged = [];
    repo.wt.unstaged = repo.wt.unstaged.filter((f) => !unstaged.includes(f));
    c.git(repo, ["stash", "push", ...(includeUntracked ? ["--include-untracked"] : []), ...(bool(a.keepIndex) ? ["--keep-index"] : []), ...(optStr(a.message) ? ["-m", optStr(a.message) as string] : [])], { stdout: `Saved working directory and index state ${message}\n` });
    emitChanged(repo);
    return ok(`Saved working directory and index state ${message}`);
  },
  stash_apply: (a, c) => stashRestore(a, c, false),
  stash_pop: (a, c) => stashRestore(a, c, true),
  stash_drop: (a, c) => {
    const repo = repoOf(a.repoId);
    const i = repo.stashes.findIndex((s) => s.index === num(a.index));
    if (i < 0) fail("No stash found", `error: stash@{${num(a.index)}} is not a valid reference`);
    const [s] = repo.stashes.splice(i, 1);
    repo.stashes.forEach((x, k) => (x.index = k));
    c.git(repo, ["stash", "drop", `stash@{${num(a.index)}}`], { stdout: `Dropped stash@{${num(a.index)}} (${short(s.oid)})\n` });
    emitChanged(repo);
    return ok(`Dropped stash@{${num(a.index)}}`);
  },
  tag_create: (a, c) => {
    const repo = repoOf(a.repoId);
    const name = str(a.name);
    if (repo.tags.has(name)) fail(`tag '${name}' already exists`, `fatal: tag '${name}' already exists`);
    const oid = needRef(repo, str(a.target, "HEAD"));
    const message = optStr(a.message);
    repo.tags.set(name, { oid, annotated: Boolean(message) });
    c.git(repo, ["tag", ...(message ? ["-a", "-m", message] : []), name, str(a.target, "HEAD")]);
    emitChanged(repo);
    return ok(`Created tag ${name}`);
  },
  tag_delete: (a, c) => {
    const repo = repoOf(a.repoId);
    const name = str(a.name);
    const t = repo.tags.get(name) ?? fail(`tag '${name}' not found`, `error: tag '${name}' not found.`);
    repo.tags.delete(name);
    c.git(repo, ["tag", "-d", name], { stdout: `Deleted tag '${name}' (was ${short(t.oid)})\n` });
    emitChanged(repo);
    return ok(`Deleted tag '${name}'`);
  },
};

function stashRestore(a: Args, c: Ctx, drop: boolean): OpResult {
  const repo = repoOf(a.repoId);
  const idx = num(a.index);
  const s = repo.stashes.find((x) => x.index === idx) ?? fail("No stash found", `error: stash@{${idx}} is not a valid reference`);
  for (const f of s.unstaged) if (!repo.wt.unstaged.some((x) => x.path === f.path)) repo.wt.unstaged.push(f);
  for (const f of s.staged) if (!repo.wt.staged.some((x) => x.path === f.path)) repo.wt.staged.push(f);
  c.git(repo, ["stash", drop ? "pop" : "apply", `stash@{${idx}}`], { stdout: `On branch ${repo.head.branch ?? "(detached)"}\nChanges not staged for commit:\n` });
  if (drop) {
    repo.stashes = repo.stashes.filter((x) => x !== s);
    repo.stashes.forEach((x, k) => (x.index = k));
  }
  emitChanged(repo);
  return ok(drop ? `Dropped stash@{${idx}}` : "Applied");
}

// ---------------------------------------------------------------- entry point

/** Runs a command of PLAN.md section 5 against the fake backend. Rejects with `{ message, detail? }`. */
export async function mockInvoke(cmd: string, args: Args = {}): Promise<unknown> {
  const handler = handlers[cmd];
  if (!handler) fail(`No browser mock for command "${cmd}"`);
  const delay = READ_FAST.has(cmd) ? 2 + Math.random() * 8 : 20 + Math.random() * 130;
  await sleep(delay);
  let emitted = false;
  const ctx: Ctx = {
    delay,
    git: (repo, gitArgs, out) => {
      emitted = true;
      emitConsole(repo, gitArgs, Math.round(delay), out);
    },
  };
  try {
    return handler(args, ctx);
  } catch (e) {
    // a failed git command shows up in the console too
    const repo = typeof args.repoId === "string" ? repos.get(args.repoId) ?? null : null;
    if (!emitted && repo) {
      const detail = typeof e === "object" && e !== null && "detail" in e ? String((e as { detail: unknown }).detail) : "";
      emitConsole(repo, [cmd.split("_")[0]], Math.round(delay), { stderr: detail, exit: 1 });
    }
    throw e;
  }
}
