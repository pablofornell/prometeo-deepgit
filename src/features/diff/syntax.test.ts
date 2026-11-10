// @vitest-environment node
import { describe, expect, it } from "vitest";
import { languageFor, segmentsOf, tokenize, type Lang, type Token } from "./syntax";

const kinds = (lang: Lang, text: string) => tokenize(lang, text).map((t) => `${t.kind}:${text.slice(t.start, t.end)}`);

describe("languageFor", () => {
  it("maps common extensions", () => {
    expect(languageFor("src/a/b.rs")).toBe("rust");
    expect(languageFor("x.tsx")).toBe("ts");
    expect(languageFor("Cargo.toml")).toBe("toml");
    expect(languageFor("a/.github/ci.yml")).toBe("yaml");
    expect(languageFor("Makefile")).toBe("sh");
    expect(languageFor("photo.png")).toBeNull();
    expect(languageFor("LICENSE")).toBeNull();
  });
});

describe("tokenize", () => {
  it("colours rust keywords, functions, strings and numbers", () => {
    expect(kinds("rust", 'pub async fn create(x: u32) -> Result<()> { let a = "hi"; 42 }')).toEqual(
      expect.arrayContaining(["kw:pub", "kw:async", "kw:fn", "fn:create", "kw:let", 'str:"hi"', "num:42", "type:Result"]),
    );
  });
  it("handles line comments and does not tokenise inside them", () => {
    expect(kinds("rust", "let a = 1; // fn x()")).toEqual(["kw:let", "num:1", "com:// fn x()"]);
  });
  it("handles block comments and continuation lines", () => {
    expect(kinds("ts", "a /* b */ c")).toEqual(["com:/* b */"]);
    expect(kinds("ts", "   * @param x")).toEqual(["com:* @param x"]);
    expect(kinds("ts", "   */")).toEqual(["com:*/"]);
  });
  it("handles escaped quotes", () => {
    expect(kinds("ts", 'const s = "a\\"b";')).toEqual(["kw:const", 'str:"a\\"b"']);
  });
  it("marks json keys as fields", () => {
    expect(kinds("json", '  "name": "x", "n": 3, "ok": true')).toEqual(['field:"name"', 'str:"x"', 'field:"n"', "num:3", 'field:"ok"', "kw:true"]);
  });
  it("toml sections and keys", () => {
    expect(kinds("toml", "[dependencies]")).toEqual(["type:[dependencies]"]);
    expect(kinds("toml", 'axum = "0.7"')).toEqual(["field:axum", 'str:"0.7"']);
  });
  it("yaml keys and comments", () => {
    expect(kinds("yaml", "  runs-on: ubuntu-latest # c")).toEqual(["field:runs-on", "com:# c"]);
  });
  it("sql keywords are case insensitive", () => {
    expect(kinds("sql", "CREATE table t (id int NOT NULL);")).toEqual(expect.arrayContaining(["kw:CREATE", "kw:table", "kw:NOT", "kw:NULL"]));
  });
  it("markdown headings and inline code", () => {
    expect(kinds("md", "## Title")).toEqual(["kw:## Title"]);
    expect(kinds("md", "use `a` here")).toEqual(["str:`a`"]);
  });
  it("shell variables", () => {
    expect(kinds("sh", 'echo "$HOME" $PATH')).toEqual(['str:"$HOME"', "field:$PATH"]);
  });
  it("skips minified lines", () => {
    expect(tokenize("ts", "a".repeat(3000))).toEqual([]);
  });
  it("tokens are ordered and never overlap", () => {
    const lines = ['const x = foo.bar("a", 1) /* c */ + `t`;', "#[derive(Debug)]", "fn main() { println!(\"{}\", 1.5e3); }"];
    for (const l of lines) {
      for (const lang of ["rust", "ts"] as const) {
        let prev = 0;
        for (const t of tokenize(lang, l)) {
          expect(t.start).toBeGreaterThanOrEqual(prev);
          expect(t.end).toBeGreaterThan(t.start);
          prev = t.end;
        }
      }
    }
  });
});

describe("segmentsOf", () => {
  it("returns one plain segment without tokens or spans", () => {
    expect(segmentsOf("abc", [], [])).toEqual([{ text: "abc" }]);
    expect(segmentsOf("", [], [])).toEqual([]);
  });
  it("splits at token and word boundaries", () => {
    const tokens: Token[] = [{ start: 0, end: 3, kind: "kw" }];
    const segs = segmentsOf("let ab", tokens, [{ start: 2, end: 5 }]);
    expect(segs.map((s) => s.text).join("")).toBe("let ab");
    expect(segs).toEqual([
      { text: "le", kind: "kw", word: undefined },
      { text: "t", kind: "kw", word: true },
      { text: " a", kind: undefined, word: true },
      { text: "b", kind: undefined, word: undefined },
    ]);
  });
});
