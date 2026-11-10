// @vitest-environment node
import { describe, expect, it } from "vitest";
import { inline, parseBody } from "./messageText";

describe("inline", () => {
  it("finds code spans, urls and issue keys", () => {
    expect(inline("Retry `POST /v1` for PAY-2318, see https://x.dev/a?b=1.")).toEqual([
      { t: "text", text: "Retry " },
      { t: "code", text: "POST /v1" },
      { t: "text", text: " for " },
      { t: "issue", text: "PAY-2318" },
      { t: "text", text: ", see " },
      { t: "url", text: "https://x.dev/a?b=1", href: "https://x.dev/a?b=1" },
      { t: "text", text: "." },
    ]);
  });
  it("finds #123 references but not glued ones", () => {
    expect(inline("Merge #1287").map((x) => x.t)).toEqual(["text", "issue"]);
    expect(inline("a#12 &#39;")).toEqual([{ t: "text", text: "a#12 &#39;" }]);
  });
  it("does not take the closing parenthesis into the url", () => {
    expect(inline("(see https://x.dev/p)")[1]).toEqual({ t: "url", text: "https://x.dev/p", href: "https://x.dev/p" });
  });
  it("leaves ordinary words alone", () => {
    expect(inline("UTF-8 and A-1")).toEqual([{ t: "text", text: "UTF-8 and A-1" }]);
  });
});

describe("parseBody", () => {
  it("returns nothing for an empty body", () => {
    expect(parseBody("")).toEqual([]);
    expect(parseBody("\n\n  \n")).toEqual([]);
  });
  it("reflows wrapped lines and keeps paragraphs", () => {
    expect(parseBody("Clients retry\non timeouts.\n\nSecond paragraph.")).toEqual([
      { t: "p", text: "Clients retry on timeouts." },
      { t: "p", text: "Second paragraph." },
    ]);
  });
  it("detects lists with continuation lines", () => {
    expect(parseBody("Changes:\n- one\n- two\n  continues\n* three")).toEqual([
      { t: "p", text: "Changes:" },
      { t: "list", items: ["one", "two continues", "three"] },
    ]);
  });
  it("detects trailers", () => {
    expect(parseBody("Body.\n\nRefs: PAY-2318\nCo-authored-by: A B <a@b.c>")).toEqual([
      { t: "p", text: "Body." },
      { t: "trailers", lines: [{ key: "Refs", value: "PAY-2318" }, { key: "Co-authored-by", value: "A B <a@b.c>" }] },
    ]);
  });
  it("does not take ordinary 'Note: text' lines for trailers", () => {
    expect(parseBody("Note: this is prose")[0].t).toBe("p");
  });
  it("keeps indented and fenced code", () => {
    expect(parseBody("Run:\n\n    cargo test\n    cargo fmt")).toEqual([
      { t: "p", text: "Run:" },
      { t: "code", text: "cargo test\ncargo fmt" },
    ]);
    expect(parseBody("a\n```\nx  y\n\nz\n```\nb")).toEqual([
      { t: "p", text: "a" },
      { t: "code", text: "x  y\n\nz" },
      { t: "p", text: "b" },
    ]);
  });
  it("handles CRLF", () => {
    expect(parseBody("a\r\n\r\nb")).toEqual([{ t: "p", text: "a" }, { t: "p", text: "b" }]);
  });
});
