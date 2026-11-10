// @vitest-environment node
// The mock must be as strict as the Rust backend: these cases mirror the rename tests in
// src-tauri/src/workspace.rs and src-tauri/src/state.rs.
import { describe, expect, it } from "vitest";
import { mockInvoke } from "./mock";
import type { Project, Workspace } from "./types";

const call = <T>(cmd: string, args?: Record<string, unknown>) => mockInvoke(cmd, args) as Promise<T>;

describe("mock command project_rename", () => {
  it("renames a project, keeps its id and shows the name in the next workspace_load and after a rescan", async () => {
    const ws = await call<Workspace>("workspace_load");
    const p = ws.projects[0];
    const renamed = await call<Project>("project_rename", { projectId: p.id, name: "  Client work " });
    expect(renamed).toEqual({ ...p, name: "Client work" });
    const again = await call<Workspace>("workspace_load");
    expect(again.projects[0].name).toBe("Client work");
    expect(again.activeProjectId).toBe(ws.activeProjectId);
    expect((await call<Project>("project_rescan", { projectId: p.id })).name).toBe("Client work");
    await call<Project>("project_rename", { projectId: p.id, name: p.name });
  });

  it("refuses bad names with the Rust messages", async () => {
    const ws = await call<Workspace>("workspace_load");
    const [a, b] = ws.projects;
    const rename = (projectId: string, name: unknown) => call("project_rename", { projectId, name });
    await expect(rename(a.id, "   ")).rejects.toMatchObject({ message: "The project name cannot be empty." });
    await expect(rename(a.id, "x".repeat(81))).rejects.toMatchObject({ message: "The project name is too long: 80 characters at most." });
    await expect(rename(a.id, "a\nb")).rejects.toMatchObject({ message: "The project name cannot contain control characters (tab, new line)." });
    await expect(rename(a.id, b.name.toUpperCase())).rejects.toMatchObject({ message: `Another project is already called "${b.name}".` });
    await expect(rename("nope", "x")).rejects.toMatchObject({ message: "unknown project" });
    await expect(rename(a.id, 5)).rejects.toMatchObject({ message: "invalid args `name` for command `project_rename`: invalid type" });
    await expect(call("project_rename", { projectId: a.id })).rejects.toMatchObject({ message: expect.stringContaining("missing required key name") });
    expect((await call<Workspace>("workspace_load")).projects.map((p) => p.name)).toEqual(ws.projects.map((p) => p.name));
  });
});
