// @vitest-environment node
// The same cases as `project_names_are_validated` in src-tauri/src/workspace.rs.
import { describe, expect, it } from "vitest";
import { PROJECT_NAME_MAX, nameKey, uniqueProjectName, validateProjectName } from "./projectName";

const projects = [{ id: "a", name: "a" }, { id: "b", name: "  Payments " }];
const check = (name: string) => validateProjectName(name, projects, "a");

describe("validateProjectName", () => {
  it("trims the name", () => {
    expect(check("  Work  ")).toEqual({ name: "Work" });
  });
  it("refuses an empty name", () => {
    expect(check(" \t ")).toEqual({ error: "The project name cannot be empty." });
    expect(check("")).toEqual({ error: "The project name cannot be empty." });
  });
  it("counts characters, not UTF-16 units or bytes", () => {
    expect(PROJECT_NAME_MAX).toBe(80);
    expect(check("x".repeat(80))).toEqual({ name: "x".repeat(80) });
    expect(check("é".repeat(80))).toEqual({ name: "é".repeat(80) });
    expect(check("😀".repeat(80))).toEqual({ name: "😀".repeat(80) });
    expect(check("x".repeat(81))).toEqual({ error: "The project name is too long: 80 characters at most." });
  });
  it("refuses control characters", () => {
    expect(check("two\nlines").error).toBe("The project name cannot contain control characters (tab, new line).");
    expect(check("a\tb").error).toBe("The project name cannot contain control characters (tab, new line).");
    expect(check("a\u0007b").error).toBe("The project name cannot contain control characters (tab, new line).");
  });
  it("refuses the name of another project, ignoring case and spaces", () => {
    expect(check("payments")).toEqual({ error: 'Another project is already called "Payments".' });
    expect(check(" PAYMENTS ")).toEqual({ error: 'Another project is already called "Payments".' });
  });
  it("accepts the project's own name in another case", () => {
    expect(check("A")).toEqual({ name: "A" });
  });
});

// The same cases as `names_are_compared_in_one_unicode_form_and_case` and `a_folder_with_a_taken_name_gets_a_number`.
describe("nameKey", () => {
  it("compares names in one Unicode form and case", () => {
    // "\u00e9" precomposed (U+00E9) and as "e" + combining acute (U+0301)
    expect(nameKey(" Caf\u00e9 ")).toBe(nameKey("CAFE\u0301"));
    expect(nameKey("\u03a3\u03c3\u03c2")).toBe("\u03c3\u03c3\u03c3");
    expect(nameKey("Stra\u017fe")).toBe(nameKey("STRASE"));
    expect(nameKey("api")).not.toBe(nameKey("apl"));
    const ps = [{ id: "a", name: "a" }, { id: "b", name: "Caf\u00e9" }];
    expect(validateProjectName("cafe\u0301", ps, "a")).toEqual({ error: 'Another project is already called "Caf\u00e9".' });
  });
});

describe("uniqueProjectName", () => {
  it("numbers a name that another project has", () => {
    const ps: { name: string }[] = [];
    const add = (name: string) => {
      const n = uniqueProjectName(name, ps);
      ps.push({ name: n });
      return n;
    };
    expect(add("api")).toBe("api");
    expect(add("api")).toBe("api (2)");
    expect(add("API")).toBe("API (3)");
    expect(add("caf\u00e9")).toBe("caf\u00e9");
    expect(add("Cafe\u0301")).toBe("Cafe\u0301 (2)");
  });
});
