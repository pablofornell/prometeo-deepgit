/**
 * Commit message rendering helpers (pure): splits a body into paragraphs, lists, code blocks and trailers,
 * and finds inline code, URLs and issue keys inside a line of text.
 */

export type Inline =
  | { t: "text"; text: string }
  | { t: "code"; text: string }
  | { t: "url"; text: string; href: string }
  | { t: "issue"; text: string };

export type Block =
  | { t: "p"; text: string }
  | { t: "list"; items: string[] }
  | { t: "code"; text: string }
  | { t: "trailers"; lines: { key: string; value: string }[] };

// 1 code span, 2 URL, 3 issue key (PAY-2318), 4 issue number (#1287)
const INLINE_RE = /`([^`\n]+)`|(https?:\/\/[^\s<>]*[^\s<>)\]}.,;:!?'"])|\b([A-Z][A-Z0-9]{1,9}-\d+)\b|#(\d+)\b/g;

const NOT_KEYS = new Set(["UTF", "SHA", "ISO", "AES", "RSA", "MD", "TLS", "SSL", "HTTP", "RFC", "CVE", "USB", "IPV", "SSE", "PEP"]);

/** Splits a line of text into plain text, `code`, URLs and issue references. */
export function inline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  INLINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_RE.exec(text))) {
    // "#123" glued to a word ("abc#123", "&#123;") is not a reference
    if (m[4] !== undefined && m.index > 0 && /[\w&]/.test(text[m.index - 1])) continue;
    // "UTF-8", "SHA-256" and friends are not issue keys
    if (m[3] !== undefined && NOT_KEYS.has(m[3].slice(0, m[3].indexOf("-")))) continue;
    if (m.index > last) out.push({ t: "text", text: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ t: "code", text: m[1] });
    else if (m[2] !== undefined) out.push({ t: "url", text: m[2], href: m[2] });
    else out.push({ t: "issue", text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ t: "text", text: text.slice(last) });
  return out;
}

const TRAILER_RE = /^([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*): (\S.*)$/;
const BULLET_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function isTrailerBlock(lines: string[]): boolean {
  return lines.length > 0 && lines.every((l) => TRAILER_RE.test(l)) && lines.some((l) => /^(Refs?|Fixes|Closes|Resolves|See-also|Cc|(Co-authored|Signed-off|Reviewed|Acked|Tested|Reported|Suggested|Helped)-by|BREAKING[- ]CHANGE|Change-Id|Issue|Ticket)\b/i.test(l));
}

/** Blocks of a commit body (the text after the subject line). */
export function parseBody(body: string): Block[] {
  const text = body.replace(/\r\n?/g, "\n").replace(/^\n+|\s+$/g, "");
  if (!text) return [];
  const out: Block[] = [];
  let fence: string[] | null = null;
  const paragraphs: string[][] = [];
  let cur: string[] = [];
  const pushPara = () => {
    if (cur.length) paragraphs.push(cur);
    cur = [];
  };
  for (const line of text.split("\n")) {
    if (fence) {
      if (/^\s*```/.test(line)) {
        out.push({ t: "code", text: fence.join("\n") });
        fence = null;
      } else fence.push(line);
      continue;
    }
    if (/^\s*```/.test(line)) {
      // flush the paragraphs gathered so far, keeping order
      pushPara();
      flush(paragraphs, out);
      fence = [];
      continue;
    }
    if (line.trim() === "") pushPara();
    else cur.push(line.replace(/\s+$/, ""));
  }
  if (fence) out.push({ t: "code", text: fence.join("\n") });
  pushPara();
  flush(paragraphs, out);
  return out;
}

function flush(paragraphs: string[][], out: Block[]): void {
  for (const lines of paragraphs) {
    if (isTrailerBlock(lines)) {
      out.push({ t: "trailers", lines: lines.map((l) => ({ key: (TRAILER_RE.exec(l) as RegExpExecArray)[1], value: (TRAILER_RE.exec(l) as RegExpExecArray)[2] })) });
    } else if (lines.every((l) => /^( {4}|\t)/.test(l))) {
      out.push({ t: "code", text: lines.map((l) => l.replace(/^( {4}|\t)/, "")).join("\n") });
    } else {
      // text lines are reflowed into one paragraph; bullet lines form lists
      let para: string[] = [];
      let items: string[] | null = null;
      const endPara = () => {
        if (para.length) out.push({ t: "p", text: para.join(" ") });
        para = [];
      };
      const endList = () => {
        if (items) out.push({ t: "list", items });
        items = null;
      };
      for (const l of lines) {
        const b = BULLET_RE.exec(l);
        if (b) {
          endPara();
          (items ??= []).push(b[3]);
        } else if (items && /^\s+\S/.test(l)) {
          items[items.length - 1] += " " + l.trim();
        } else {
          endList();
          para.push(l.trim());
        }
      }
      endPara();
      endList();
    }
  }
  paragraphs.length = 0;
}
