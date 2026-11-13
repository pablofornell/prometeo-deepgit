import { SearchQuery, replaceAll, search, setSearchQuery } from "@codemirror/search";
import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import type { EditorView } from "@codemirror/view";
import { MATCH_CAP, collectMatches, counterText, emptyQuery, escapeRegex, firstMatchFrom, isErrorState, matchStats, sameQuery, seedText, statsAt, withQuery } from "./logic";

const state = (doc: string, from = 0, to = from) => EditorState.create({ doc, selection: EditorSelection.single(from, to) });
const q = (search: string, o: Partial<ConstructorParameters<typeof SearchQuery>[0]> = {}) => new SearchQuery({ search, ...o });

describe("matchStats and counterText", () => {
  it("empty query has no text", () => {
    const s = matchStats(state("abc"), q(""));
    expect(s.kind).toBe("empty");
    expect(counterText(s)).toBe("");
    expect(isErrorState(s)).toBe(false);
  });

  it("shows the number of the match under the selection", () => {
    const doc = "foo bar foo baz foo";
    expect(counterText(matchStats(state(doc, 0, 3), q("foo")))).toBe("1 of 3");
    expect(counterText(matchStats(state(doc, 8, 11), q("foo")))).toBe("2 of 3");
    expect(counterText(matchStats(state(doc, 16, 19), q("foo")))).toBe("3 of 3");
  });

  it("shows ? when the selection is not a match", () => {
    expect(counterText(matchStats(state("foo bar foo", 4), q("foo")))).toBe("? of 2");
    expect(counterText(matchStats(state("foo bar foo", 1, 3), q("foo")))).toBe("? of 2");
  });

  it("says No results and marks the error", () => {
    const s = matchStats(state("abc"), q("zzz"));
    expect(counterText(s)).toBe("No results");
    expect(isErrorState(s)).toBe(true);
  });

  it("says Invalid regex without throwing", () => {
    const s = matchStats(state("abc"), q("(", { regexp: true }));
    expect(counterText(s)).toBe("Invalid regex");
    expect(isErrorState(s)).toBe(true);
    expect(() => matchStats(state("abc"), q("[a-", { regexp: true }))).not.toThrow();
  });

  it("a literal ( is fine without regex", () => {
    expect(counterText(matchStats(state("f(x)"), q("(")))).toBe("? of 1");
  });

  it("honours match case and whole word", () => {
    const doc = "Foo foo foobar";
    expect(matchStats(state(doc), q("foo")).total).toBe(3);
    expect(matchStats(state(doc), q("foo", { caseSensitive: true })).total).toBe(2);
    expect(matchStats(state(doc), q("foo", { wholeWord: true })).total).toBe(2);
    expect(matchStats(state(doc), q("foo", { wholeWord: true, caseSensitive: true })).total).toBe(1);
  });

  it("matches a regular expression", () => {
    expect(matchStats(state("a1 b22 c333"), q("\\d+", { regexp: true })).total).toBe(3);
  });

  it("caps the count and adds a plus", () => {
    const doc = "x".repeat(MATCH_CAP + 50);
    const s = matchStats(state(doc, 0, 1), q("x"));
    expect(s.total).toBe(MATCH_CAP);
    expect(s.capped).toBe(true);
    expect(counterText(s)).toBe(`1 of ${MATCH_CAP}+`);
    expect(counterText(matchStats(state("x".repeat(MATCH_CAP)), q("x")))).toBe(`? of ${MATCH_CAP}`);
  });

  it("uses a small cap when asked", () => {
    expect(counterText(matchStats(state("aaaaa"), q("a"), 3))).toBe("? of 3+");
  });
});

describe("firstMatchFrom", () => {
  it("finds the match at or after the position", () => {
    expect(firstMatchFrom(state("foo bar foo"), q("foo"), 0)).toEqual({ from: 0, to: 3 });
    expect(firstMatchFrom(state("foo bar foo"), q("foo"), 1)).toEqual({ from: 8, to: 11 });
  });
  it("wraps to the start", () => {
    expect(firstMatchFrom(state("foo bar"), q("foo"), 5)).toEqual({ from: 0, to: 3 });
  });
  it("returns null without a match or with a bad query", () => {
    expect(firstMatchFrom(state("abc"), q("zzz"), 0)).toBeNull();
    expect(firstMatchFrom(state("abc"), q("(", { regexp: true }), 0)).toBeNull();
    expect(firstMatchFrom(state("abc"), q(""), 0)).toBeNull();
  });
});

describe("seedText", () => {
  it("takes a one-line selection", () => {
    expect(seedText(state("hello world", 6, 11), false)).toBe("world");
  });
  it("ignores an empty or multi-line selection", () => {
    expect(seedText(state("hello world", 3), false)).toBeNull();
    expect(seedText(state("ab\ncd", 0, 5), false)).toBeNull();
  });
  it("escapes the text in regex mode", () => {
    expect(seedText(state("a.b(c)", 0, 6), true)).toBe("a\\.b\\(c\\)");
  });
  it("escapeRegex gives a pattern that matches the text", () => {
    const text = "x+y*[z]^$|\\-/{1}";
    expect(new RegExp(escapeRegex(text), "u").test(text)).toBe(true);
  });
});

describe("withQuery", () => {
  it("changes only what the patch names", () => {
    const base = q("foo", { replace: "bar", caseSensitive: true });
    const next = withQuery(base, { regexp: true });
    expect(next.search).toBe("foo");
    expect(next.replace).toBe("bar");
    expect(next.caseSensitive).toBe(true);
    expect(next.regexp).toBe(true);
    expect(next.wholeWord).toBe(false);
  });
});

describe("cached counting", () => {
  it("statsAt gives the current match from the list without scanning", () => {
    const doc = "foo bar foo baz foo";
    const list = collectMatches(state(doc), q("foo"));
    expect(list.ranges).toEqual([{ from: 0, to: 3 }, { from: 8, to: 11 }, { from: 16, to: 19 }]);
    expect(counterText(statsAt(list, 0, 3))).toBe("1 of 3");
    expect(counterText(statsAt(list, 16, 19))).toBe("3 of 3");
    expect(counterText(statsAt(list, 8, 10))).toBe("? of 3");
    expect(counterText(statsAt(list, 4, 4))).toBe("? of 3");
  });
  it("statsAt agrees with matchStats", () => {
    const st = state("a1 b22 c333", 6, 8);
    const spec = q("\\d+", { regexp: true });
    expect(statsAt(collectMatches(st, spec), 6, 8)).toEqual(matchStats(st, spec));
  });
  it("collectMatches stops at the cap", () => {
    const list = collectMatches(state("aaaaa"), q("a"), 3);
    expect(list.ranges).toHaveLength(3);
    expect(list.capped).toBe(true);
  });
  it("a bad or empty query makes no scan and no ranges", () => {
    expect(collectMatches(state("abc"), q("")).kind).toBe("empty");
    expect(collectMatches(state("abc"), q("(", { regexp: true })).kind).toBe("invalid");
  });
});

describe("firstMatchFrom wraps once", () => {
  it("finds a match that starts before the cursor and ends after it", () => {
    expect(firstMatchFrom(state("xxabcxx"), q("abc"), 4)).toEqual({ from: 2, to: 5 });
  });
  it("finds nothing twice over without a match", () => {
    expect(firstMatchFrom(state("abc abc"), q("zzz"), 3)).toBeNull();
  });
});

describe("plain mode is literal", () => {
  const plain = (search: string, o: Partial<ConstructorParameters<typeof SearchQuery>[0]> = {}) => withQuery(emptyQuery(), { search, ...o });

  it("the session starts in plain, literal mode", () => {
    expect(emptyQuery().literal).toBe(true);
    expect(emptyQuery().regexp).toBe(false);
  });
  it("withQuery sets literal from the regex option", () => {
    expect(withQuery(emptyQuery(), { regexp: true }).literal).toBe(false);
    expect(withQuery(withQuery(emptyQuery(), { regexp: true }), { regexp: false }).literal).toBe(true);
  });
  it("C:\\temp finds itself", () => {
    const doc = "path C:\\temp\\x";
    expect(matchStats(state(doc), plain("C:\\temp")).total).toBe(1);
  });
  it("a typed backslash-n matches the two characters, not a line break", () => {
    const doc = "a\\nb\nc";
    const list = collectMatches(state(doc), plain("\\n"));
    expect(list.ranges).toEqual([{ from: 1, to: 3 }]);
  });
  it("regex mode still reads escapes", () => {
    expect(matchStats(state("a\nb"), withQuery(emptyQuery(), { search: "a\\nb", regexp: true })).total).toBe(1);
  });
  it("sameQuery tells literal from non-literal", () => {
    const lit = q("x", { literal: true });
    const raw = q("x");
    expect(lit.eq(raw)).toBe(true);
    expect(sameQuery(lit, raw)).toBe(false);
    expect(sameQuery(lit, q("x", { literal: true }))).toBe(true);
  });

  /** Runs `replaceAll` on a document with the search state, using a bare-bones view. */
  const replaced = (doc: string, spec: SearchQuery): string => {
    let st = EditorState.create({ doc, extensions: [search({ literal: true })] }).update({ effects: setSearchQuery.of(spec) }).state;
    const view = { get state() { return st; }, dispatch: (spec: TransactionSpec) => { st = st.update(spec).state; } } as unknown as EditorView;
    replaceAll(view);
    return st.doc.toString();
  };
  it("replace all inserts a typed backslash-t as two characters", () => {
    expect(replaced("a b", plain("a", { replace: "\\t" }))).toBe("\\t b");
  });
  it("regex mode replacement still reads \\t as a tab", () => {
    expect(replaced("a b", withQuery(emptyQuery(), { search: "a", replace: "\\t", regexp: true }))).toBe("\t b");
  });
});
