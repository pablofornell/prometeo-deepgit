// @vitest-environment node
import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { crlfInput, toCrlf } from "./lineEnds";

const crlfState = (doc: string, withFilter = true): EditorState =>
  EditorState.create({ doc, extensions: [EditorState.lineSeparator.of("\r\n"), ...(withFilter ? [crlfInput] : [])] });

describe("toCrlf", () => {
  it("changes LF and CRLF to CRLF", () => {
    expect(toCrlf("a\nb\r\nc")).toBe("a\r\nb\r\nc");
  });

  it("keeps a lone CR and text without breaks", () => {
    expect(toCrlf("a\rb")).toBe("a\rb");
    expect(toCrlf("plain")).toBe("plain");
    expect(toCrlf("")).toBe("");
  });
});

describe("crlfInput", () => {
  it("splits a pasted LF text into lines and keeps the CRLF on save", () => {
    const state = crlfState("").update({ changes: { from: 0, insert: "a\nb\nc" } }).state;
    expect(state.doc.lines).toBe(3);
    expect(state.sliceDoc()).toBe("a\r\nb\r\nc");
  });

  it("is the reason the filter exists: without it the text stays one line", () => {
    const state = crlfState("", false).update({ changes: { from: 0, insert: "a\nb\nc" } }).state;
    expect(state.doc.lines).toBe(1);
  });

  it("keeps the cursor after the inserted text", () => {
    const state = crlfState("x\r\ny").update({ changes: { from: 0, insert: "a\nb" }, selection: EditorSelection.cursor(3) }).state;
    expect(state.sliceDoc()).toBe("a\r\nbx\r\ny");
    expect(state.selection.main.head).toBe(3);
    expect(state.doc.lineAt(state.selection.main.head).number).toBe(2);
  });

  it("leaves an insert without a line break unchanged", () => {
    const state = crlfState("x\r\ny").update({ changes: { from: 1, insert: "zz" } }).state;
    expect(state.sliceDoc()).toBe("xzz\r\ny");
  });
});
