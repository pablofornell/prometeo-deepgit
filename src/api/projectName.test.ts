// @vitest-environment node
// The same cases as `project_names_are_validated` in src-tauri/src/workspace.rs.
import { describe, expect, it } from "vitest";
import { PROJECT_NAME_MAX, validateProjectName } from "./projectName";

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
