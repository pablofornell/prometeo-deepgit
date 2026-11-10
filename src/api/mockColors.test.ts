// @vitest-environment node
// The mock must be as strict as the Rust backend: these cases mirror the Rust tests in
// crates/gitcore/src/palette.rs and src-tauri/src/workspace.rs.
import { describe, expect, it } from "vitest";
import { mockInvoke } from "./mock";
import { addColoredProject, colorizeRepos, nextColor, parseColorChoice, setProjectColor, setRepoColor } from "./mockColors";
import type { Project, RepoInfo, Workspace } from "./types";

const call = <T>(cmd: string, args?: Record<string, unknown>) => mockInvoke(cmd, args) as Promise<T>;

const repo = (id: string): RepoInfo => ({ id, name: id, path: `/w/${id}`, color: 0, customColor: null });
const project = (id: string, repoIds: string[] = [id]): Project => ({ id, name: id, path: `/w/${id}`, repos: repoIds.map(repo), color: 0, customColor: null });
const empty = (): Workspace => ({ projects: [], activeProjectId: null, ui: {} });
const colors = (p: Project) => p.repos.map((r) => r.color);

describe("nextColor", () => {
  it("hands out 0..11 in order, then starts again", () => {
    const used: number[] = [];
    for (let want = 0; want < 12; want++) {
      const c = nextColor(used);
      expect(c).toBe(want);
      used.push(c);
    }
    expect(nextColor(used)).toBe(0);
  });

  it("takes the least used colour, the lowest index on a tie, and ignores junk", () => {
    expect(nextColor([0, 0, 1, 1, 2])).toBe(3);
    expect(nextColor([255, 200])).toBe(0);
  });
});

describe("parseColorChoice", () => {
  it("accepts a palette index, a custom colour or neither", () => {
    expect(parseColorChoice(null, null)).toEqual({ kind: "auto" });
    expect(parseColorChoice(11, null)).toEqual({ kind: "palette", index: 11 });
    expect(parseColorChoice(null, "#1a2B3c")).toEqual({ kind: "custom", hex: "#1A2B3C" });
  });

  it("rejects bad input with the Rust messages", () => {
    expect(parseColorChoice(12, null)).toBe("Unknown palette color");
    expect(parseColorChoice(1, "#FFFFFF")).toBe("Give a palette color or a custom color, not both");
    for (const bad of ["", "red", "#12345", "#1234567", "1A2B3C", "#GGGGGG", "#12 456"]) {
      expect(parseColorChoice(null, bad), bad).toBe("Invalid color, expected #RRGGBB");
    }
  });
});

describe("assignment", () => {
  it("uses all twelve colours before repeating", () => {
    const ws = empty();
    addColoredProject(ws, project("a", Array.from({ length: 14 }, (_, i) => `r${i}`)));
    expect(colors(ws.projects[0])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 0, 1]);
  });

  it("continues with the least-used colours in a second project, and spreads the projects", () => {
    const ws = empty();
    addColoredProject(ws, project("a", ["a1", "a2", "a3"]));
    addColoredProject(ws, project("b", ["b1", "b2"]));
    expect(colors(ws.projects[0])).toEqual([0, 1, 2]);
    expect(colors(ws.projects[1])).toEqual([3, 4]);
    expect([ws.projects[0].color, ws.projects[1].color]).toEqual([0, 1]);
  });

  it("keeps one colour for a repo that two projects share", () => {
    const ws = empty();
    addColoredProject(ws, project("a", ["x", "a1"]));
    setRepoColor(ws, "x", { kind: "custom", hex: "#112233" });
    addColoredProject(ws, project("b", ["b1", "x"]));
    const b = ws.projects[1];
    expect(b.repos[1].customColor).toBe("#112233");
    // x shows a custom colour, so only a1 (colour 1) counts: b1 takes 0
    expect(b.repos[0].color).toBe(0);
  });
});

describe("shared repos", () => {
  // The same scenario is in src-tauri/src/workspace.rs ("a_shared_repo_counts_once_when_the_next_color_is_chosen").
  it("counts a shared repo once when the next colour is chosen", () => {
    const ws = empty();
    // a project with 12 repos uses every palette colour once; x has colour 0
    addColoredProject(ws, project("a", ["x", ...Array.from({ length: 11 }, (_, i) => `a${i + 1}`)]));
    expect(colors(ws.projects[0])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    // b holds x too: the 12 colours are each used once, so b1 takes 0, then b2 takes 1 (counting x twice would give 1 and 2)
    addColoredProject(ws, project("b", ["x", "b1", "b2"]));
    expect(colors(ws.projects[1])).toEqual([0, 0, 1]);
    // a rescan of b that keeps only x and adds b3: x is counted once, so b3 takes 0
    const fresh = project("b", ["x", "b3"]);
    colorizeRepos(ws, "b", fresh);
    expect(colors(fresh)).toEqual([0, 0]);
  });
});

describe("setRepoColor and setProjectColor", () => {
  it("handles palette, custom and Auto", () => {
    const ws = empty();
    addColoredProject(ws, project("p", ["r1", "r2", "r3"]));
    expect(setRepoColor(ws, "r1", { kind: "palette", index: 7 })).toMatchObject({ color: 7, customColor: null });
    expect(setRepoColor(ws, "r1", { kind: "custom", hex: "#0A0B0C" })).toMatchObject({ color: 7, customColor: "#0A0B0C" });
    expect(setRepoColor(ws, "r1", { kind: "palette", index: 4 })).toMatchObject({ color: 4, customColor: null });
    // r2 shows 1 and r3 shows 2: the least used index for r1 is 0
    expect(setRepoColor(ws, "r1", { kind: "auto" })).toMatchObject({ color: 0, customColor: null });
    expect(setRepoColor(ws, "nope", { kind: "auto" })).toBeNull();
  });

  it("updates every project that holds the repo", () => {
    const ws = empty();
    addColoredProject(ws, project("a", ["x"]));
    addColoredProject(ws, project("b", ["x"]));
    setRepoColor(ws, "x", { kind: "palette", index: 6 });
    expect(ws.projects.map((p) => p.repos[0].color)).toEqual([6, 6]);
  });

  it("assigns project colours and frees the index of a custom one", () => {
    const ws = empty();
    for (const id of ["a", "b", "c"]) addColoredProject(ws, project(id));
    expect(ws.projects.map((p) => p.color)).toEqual([0, 1, 2]);
    expect(setProjectColor(ws, "b", { kind: "custom", hex: "#FF00FF" })?.customColor).toBe("#FF00FF");
    addColoredProject(ws, project("d"));
    expect(ws.projects[3].color).toBe(1);
    expect(setProjectColor(ws, "a", { kind: "palette", index: 10 })?.color).toBe(10);
    expect(setProjectColor(ws, "zzz", { kind: "auto" })).toBeNull();
  });
});

describe("mock commands repo_set_color and project_set_color", () => {
  it("rejects bad arguments like the backend", async () => {
    const ws = await call<Workspace>("workspace_load");
    const id = ws.projects[0].repos[0].id;
    await expect(call("repo_set_color", { repoId: id, color: 12, custom: null })).rejects.toMatchObject({ message: "Unknown palette color" });
    await expect(call("repo_set_color", { repoId: id, color: null, custom: "blue" })).rejects.toMatchObject({ message: "Invalid color, expected #RRGGBB" });
    await expect(call("repo_set_color", { repoId: id, color: 1, custom: "#FFFFFF" })).rejects.toMatchObject({ message: "Give a palette color or a custom color, not both" });
    await expect(call("repo_set_color", { repoId: "nope", color: 1, custom: null })).rejects.toMatchObject({ message: "unknown repository" });
    // serde rejects a value that is not a u8
    await expect(call("repo_set_color", { repoId: id, color: 300, custom: null })).rejects.toMatchObject({ message: expect.stringContaining("invalid args `color`") });
    await expect(call("repo_set_color", { repoId: id, color: -1, custom: null })).rejects.toMatchObject({ message: expect.stringContaining("invalid args `color`") });
    await expect(call("project_set_color", { projectId: "nope", color: null, custom: null })).rejects.toMatchObject({ message: "unknown project" });
  });

  it("changes a colour and shows it in the next workspace_load", async () => {
    const ws = await call<Workspace>("workspace_load");
    const id = ws.projects[0].repos[1].id;
    const updated = await call<RepoInfo>("repo_set_color", { repoId: id, color: null, custom: "#abcdef" });
    expect(updated.customColor).toBe("#ABCDEF");
    const again = await call<Workspace>("workspace_load");
    expect(again.projects[0].repos[1].customColor).toBe("#ABCDEF");
    const auto = await call<RepoInfo>("repo_set_color", { repoId: id, color: null, custom: null });
    expect(auto.customColor).toBeNull();
    const p = await call<Project>("project_set_color", { projectId: ws.projects[0].id, color: 5, custom: null });
    expect(p.color).toBe(5);
  });

  it("starts with distinct colours in the demo workspace", async () => {
    const ws = await call<Workspace>("workspace_load");
    const payments = ws.projects.find((p) => p.name === "payments-platform") as Project;
    expect(new Set(payments.repos.map((r) => r.color)).size).toBe(payments.repos.length);
    expect(ws.projects.every((p) => p.customColor === null || /^#[0-9A-F]{6}$/.test(p.customColor))).toBe(true);
  });
});
