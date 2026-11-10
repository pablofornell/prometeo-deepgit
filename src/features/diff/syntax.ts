/**
 * Lightweight, dependency-free syntax colouring for the diff viewer. A hand-written one-line scanner
 * (keywords, strings, comments, numbers, a few heuristics for functions, types and fields). It is
 * stateless per line, so it can run on any visible line in any order; block comments are recognised
 * on the line that opens them and on following lines that start with `*`.
 */

export type Lang = "rust" | "ts" | "json" | "toml" | "yaml" | "md" | "css" | "sql" | "py" | "go" | "java" | "kt" | "sh";
export type TokenKind = "kw" | "str" | "num" | "com" | "fn" | "type" | "field" | "meta";

export interface Token {
  start: number;
  end: number;
  kind: TokenKind;
}

/** Lines longer than this are not tokenised (minified code). */
export const MAX_SYNTAX_LINE = 1500;

const EXT: Record<string, Lang> = {
  rs: "rust", ts: "ts", tsx: "ts", js: "ts", jsx: "ts", mjs: "ts", cjs: "ts", json: "json", jsonc: "json",
  toml: "toml", yaml: "yaml", yml: "yaml", md: "md", mdx: "md", css: "css", scss: "css", sql: "sql", py: "py",
  go: "go", java: "java", kt: "kt", kts: "kt", sh: "sh", bash: "sh", zsh: "sh",
};

/** Language of a path, or null when unknown. */
export function languageFor(path: string): Lang | null {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (base === "dockerfile" || base === "makefile") return "sh";
  if (base === "cargo.lock") return "toml";
  const dot = base.lastIndexOf(".");
  return dot < 0 ? null : EXT[base.slice(dot + 1)] ?? null;
}

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

interface Spec {
  kw: Set<string>;
  /** Case-insensitive keywords (SQL). */
  ci?: boolean;
  line: string[];
  block?: [string, string];
  quotes: string;
  /** Capitalised identifiers are types. */
  types?: boolean;
  /** `name(` is a function, `name!` too (Rust macros). */
  calls?: boolean;
  /** `.name` is a field. */
  fields?: boolean;
  /** `$VAR` / `${VAR}` are fields. */
  dollar?: boolean;
  /** Matches at the start of the trimmed line (attributes, decorators). */
  meta?: RegExp;
}

const SPECS: Partial<Record<Lang, Spec>> = {
  rust: {
    kw: words("as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while"),
    line: ["//"], block: ["/*", "*/"], quotes: '"', types: true, calls: true, fields: true, meta: /^#!?\[/,
  },
  ts: {
    kw: words("abstract as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function get if implements import in instanceof interface let new null of private protected public readonly return set static super switch this throw true try type typeof undefined var void while yield declare namespace keyof satisfies"),
    line: ["//"], block: ["/*", "*/"], quotes: "\"'`", types: true, calls: true, fields: true,
  },
  json: { kw: words("true false null"), line: [], quotes: '"' },
  toml: { kw: words("true false"), line: ["#"], quotes: "\"'" },
  yaml: { kw: words("true false null yes no on off"), line: ["#"], quotes: "\"'" },
  md: { kw: new Set(), line: [], quotes: "" },
  css: { kw: words("important inherit initial none auto"), line: [], block: ["/*", "*/"], quotes: "\"'", calls: true },
  sql: {
    kw: words("select from where and or not null insert into values update set delete create table alter drop index unique primary key foreign references default check constraint join left right inner outer on group by order having limit offset as distinct union all case when then else end begin commit rollback true false if exists add column cascade desc asc with returning using over partition"),
    ci: true, line: ["--"], block: ["/*", "*/"], quotes: "\"'", calls: true,
  },
  py: {
    kw: words("and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self"),
    line: ["#"], quotes: "\"'", types: true, calls: true, fields: true, meta: /^@/,
  },
  go: {
    kw: words("break case chan const continue default defer else fallthrough false for func go goto if import interface map nil package range return select struct switch true type var"),
    line: ["//"], block: ["/*", "*/"], quotes: "\"'`", types: true, calls: true, fields: true,
  },
  java: {
    kw: words("abstract assert boolean break byte case catch char class const continue default do double else enum extends false final finally float for if implements import instanceof int interface long native new null package private protected public return short static super switch synchronized this throw throws transient true try void volatile while var record"),
    line: ["//"], block: ["/*", "*/"], quotes: '"\'', types: true, calls: true, fields: true, meta: /^@/,
  },
  kt: {
    kw: words("as break class continue do else false for fun if in interface is null object package return super this throw true try typealias typeof val var when while by catch constructor delegate dynamic field file finally get import init param property receiver set setparam where abstract actual annotation companion const crossinline data enum expect external final infix inline inner internal lateinit noinline open operator out override private protected public reified sealed suspend tailrec vararg"),
    line: ["//"], block: ["/*", "*/"], quotes: '"\'', types: true, calls: true, fields: true, meta: /^@/,
  },
  sh: {
    kw: words("if then else elif fi for while until do done case esac function in select return exit export local readonly set unset source alias true false"),
    line: ["#"], quotes: "\"'", calls: false, dollar: true,
  },
};

const isIdStart = (c: string) => /[A-Za-z_$]/.test(c);
const isIdChar = (c: string) => /[\w$]/.test(c);
const isDigit = (c: string) => c >= "0" && c <= "9";

/** Tokens of one line (only coloured ones; gaps are plain text). Sorted and non-overlapping. */
export function tokenize(lang: Lang, text: string): Token[] {
  if (text.length > MAX_SYNTAX_LINE || text.length === 0) return [];
  if (lang === "md") return tokenizeMarkdown(text);
  const spec = SPECS[lang];
  if (!spec) return [];
  const out: Token[] = [];
  const trimmed = text.trimStart();
  const lead = text.length - trimmed.length;

  if (spec.meta && spec.meta.test(trimmed)) return [{ start: lead, end: text.length, kind: "meta" }];
  if (lang === "toml") {
    const sec = /^\s*(\[\[?[^\]]+\]\]?)/.exec(text);
    if (sec) {
      out.push({ start: sec.index + sec[0].length - sec[1].length, end: sec.index + sec[0].length, kind: "type" });
      return out.concat(scan(spec, text, sec[0].length, "toml"));
    }
  }
  // JSDoc-like continuation lines
  if (spec.block && /^\*(\s|\/|$)/.test(trimmed)) {
    return [{ start: lead, end: text.length, kind: "com" }];
  }
  return scan(spec, text, 0, lang);
}

function scan(spec: Spec, text: string, from: number, lang: Lang): Token[] {
  const out: Token[] = [];
  const n = text.length;
  let i = from;
  // YAML / TOML keys and JSON keys are fields
  let keyEnd = -1;
  if (lang === "yaml") {
    const m = /^(\s*(?:-\s+)?)([A-Za-z0-9_.\-/"']+)\s*:(\s|$)/.exec(text.slice(i));
    if (m) {
      const s = i + m[1].length;
      keyEnd = s + m[2].length;
      out.push({ start: s, end: keyEnd, kind: "field" });
      i = keyEnd;
    }
  } else if (lang === "toml") {
    const m = /^\s*([A-Za-z0-9_.\-"']+)\s*=/.exec(text.slice(i));
    if (m && i === 0) {
      const s = text.indexOf(m[1]);
      keyEnd = s + m[1].length;
      out.push({ start: s, end: keyEnd, kind: "field" });
      i = keyEnd;
    }
  }
  while (i < n) {
    const c = text[i];
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    // comments
    const lc = spec.line.find((m) => text.startsWith(m, i));
    if (lc && !(lc === "#" && lang === "sh" && i > 0 && !/\s/.test(text[i - 1]))) {
      out.push({ start: i, end: n, kind: "com" });
      break;
    }
    if (spec.block && text.startsWith(spec.block[0], i)) {
      const close = text.indexOf(spec.block[1], i + spec.block[0].length);
      const end = close < 0 ? n : close + spec.block[1].length;
      out.push({ start: i, end, kind: "com" });
      i = end;
      continue;
    }
    // strings
    if (spec.quotes.includes(c)) {
      let j = i + 1;
      while (j < n && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      const end = Math.min(n, j + 1);
      let kind: TokenKind = "str";
      if (lang === "json") {
        const after = text.slice(end).trimStart();
        if (after.startsWith(":")) kind = "field";
      }
      out.push({ start: i, end, kind });
      i = end;
      continue;
    }
    if (spec.dollar && c === "$") {
      const m = /^\$(\{[^}]*\}|[A-Za-z_]\w*|[0-9@#?*$!-])/.exec(text.slice(i));
      if (m) {
        out.push({ start: i, end: i + m[0].length, kind: "field" });
        i += m[0].length;
        continue;
      }
    }
    // numbers
    const prev = i > 0 ? text[i - 1] : " ";
    if (isDigit(c) && !isIdChar(prev)) {
      const m = /^(0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?)[A-Za-z]*%?/.exec(text.slice(i));
      if (m) {
        out.push({ start: i, end: i + m[0].length, kind: "num" });
        i += m[0].length;
        continue;
      }
    }
    if (lang === "css" && c === "#" && /^#[0-9a-fA-F]{3,8}\b/.test(text.slice(i))) {
      const m = /^#[0-9a-fA-F]{3,8}/.exec(text.slice(i)) as RegExpExecArray;
      out.push({ start: i, end: i + m[0].length, kind: "num" });
      i += m[0].length;
      continue;
    }
    // identifiers
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && (isIdChar(text[j]) || (lang === "css" && text[j] === "-"))) j++;
      const word = text.slice(i, j);
      const key = spec.ci ? word.toLowerCase() : word;
      if (spec.kw.has(key) && !(lang === "css" && text[i - 1] === "-")) {
        out.push({ start: i, end: j, kind: "kw" });
      } else if (lang === "css" && /^\s*:/.test(text.slice(j)) && !/^\s*:\s*[a-z-]*\s*[{,]/.test(text.slice(j))) {
        out.push({ start: i, end: j, kind: "field" });
      } else if (spec.calls && (text[j] === "(" || (lang === "rust" && text[j] === "!" && text[j + 1] !== "="))) {
        out.push({ start: i, end: j, kind: "fn" });
      } else if (spec.fields && prev === "." && lang !== "sql") {
        out.push({ start: i, end: j, kind: "field" });
      } else if (spec.types && /^[A-Z]/.test(word) && /[a-z]/.test(word)) {
        out.push({ start: i, end: j, kind: "type" });
      }
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

function tokenizeMarkdown(text: string): Token[] {
  const out: Token[] = [];
  const head = /^\s{0,3}(#{1,6})\s/.exec(text);
  if (head) return [{ start: 0, end: text.length, kind: "kw" }];
  if (/^\s*(```|~~~)/.test(text)) return [{ start: 0, end: text.length, kind: "meta" }];
  const bullet = /^\s*([-*+]|\d+\.)\s/.exec(text);
  if (bullet) out.push({ start: bullet[0].length - bullet[1].length - 1, end: bullet[0].length - 1, kind: "kw" });
  const code = /`[^`]*`/g;
  let m: RegExpExecArray | null;
  while ((m = code.exec(text))) out.push({ start: m.index, end: m.index + m[0].length, kind: "str" });
  if (/^\s*\|/.test(text)) {
    const bar = /\|/g;
    while ((m = bar.exec(text))) out.push({ start: m.index, end: m.index + 1, kind: "meta" });
  }
  return out.sort((a, b) => a.start - b.start);
}

export interface Segment {
  text: string;
  kind?: TokenKind;
  /** Part of a word-level change. */
  word?: boolean;
}

/** Cuts a line at every token and word-span boundary so the view can render one element per segment. */
export function segmentsOf(text: string, tokens: readonly Token[], spans: readonly { start: number; end: number }[]): Segment[] {
  if (text.length === 0) return [];
  if (tokens.length === 0 && spans.length === 0) return [{ text }];
  const cuts = new Set<number>([0, text.length]);
  for (const t of tokens) {
    cuts.add(t.start);
    cuts.add(t.end);
  }
  for (const s of spans) {
    cuts.add(Math.max(0, s.start));
    cuts.add(Math.min(text.length, s.end));
  }
  const points = [...cuts].filter((p) => p >= 0 && p <= text.length).sort((a, b) => a - b);
  const out: Segment[] = [];
  let ti = 0;
  let si = 0;
  for (let k = 0; k + 1 < points.length; k++) {
    const a = points[k];
    const b = points[k + 1];
    while (ti < tokens.length && tokens[ti].end <= a) ti++;
    while (si < spans.length && spans[si].end <= a) si++;
    const tok = ti < tokens.length && tokens[ti].start <= a ? tokens[ti] : undefined;
    const word = si < spans.length && spans[si].start <= a;
    out.push({ text: text.slice(a, b), kind: tok?.kind, word: word || undefined });
  }
  return out;
}
