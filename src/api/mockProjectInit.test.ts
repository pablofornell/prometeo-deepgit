// @vitest-environment node
// The mock must be as strict as the Rust backend: these cases mirror crates/gitcore/tests/init.rs and
// `add_project` / `init_project` in src-tauri/src/state.rs.
import { describe, expect, it } from "vitest";
import { mockInvoke } from "./mock";
import type { Project, Workspace } from "./types";

const call = <T>(cmd: string, args?: Record<string, unknown>) => mockInvoke(cmd, args) as Promise<T>;

describe("mock commands project_add and project_init on a folder without a repository", () => {
  const folder = "/home/dev/IRIS-docs";

  it("rejects project_add with the noRepository code, and adds nothing", async () => {
    const before = await call<Workspace>("workspace_load");
    await expect(call("project_add", { path: folder })).rejects.toMatchObject({ code: "noRepository", message: `No Git repository found in ${folder}` });
    expect((await call<Workspace>("workspace_load")).projects.length).toBe(before.projects.length);
  });

  it("says what the dialog shows: name, default branch and the repository that contains the folder", async () => {
    expect(await call("project_init_info", { path: folder })).toEqual({ path: folder, name: "IRIS-docs", defaultBranch: "main", parentRepo: null });
    const ws = await call<Workspace>("workspace_load");
    const root = ws.projects[0].repos[0].path;
    expect(await call("project_init_info", { path: `${root}/docs` })).toMatchObject({ name: "docs", parentRepo: root });
  });

  it("refuses bad branches and folders that have a repository, like init_repository in Rust", async () => {
    const init = (path: string, branch: unknown) => call("project_init", { path, branch });
    await expect(init(folder, "  ")).rejects.toMatchObject({ message: "Enter a branch name." });
    await expect(init(folder, "-x")).rejects.toMatchObject({ message: expect.stringContaining("cannot start with '-'") });
    await expect(init(folder, "a b")).rejects.toMatchObject({ message: "This is not a valid branch name." });
    await expect(init(folder, "@")).rejects.toMatchObject({ message: "This is not a valid branch name." });
    const ws = await call<Workspace>("workspace_load");
    await expect(init(ws.projects[0].path, "main")).rejects.toMatchObject({ message: `${ws.projects[0].path} holds a Git repository already.` });
    // nothing was created
    await expect(call("project_add", { path: folder })).rejects.toMatchObject({ code: "noRepository" });
  });

  it("checks the folder before the branch, like init_repository in Rust, and refuses '@{'", async () => {
    const init = (path: string, branch: unknown) => call("project_init", { path, branch });
    const ws = await call<Workspace>("workspace_load");
    // a folder with a repository and an empty branch: the folder error comes first
    await expect(init(ws.projects[0].path, "")).rejects.toMatchObject({ message: `${ws.projects[0].path} holds a Git repository already.` });
    await expect(init("/srv/foo.git", "")).rejects.toMatchObject({ code: "bareRepository" });
    await expect(init(folder, "@{-1}")).rejects.toMatchObject({ message: "This is not a valid branch name." });
    await expect(init(folder, "a@{b}")).rejects.toMatchObject({ message: "This is not a valid branch name." });
    await expect(init(folder, "HEAD")).rejects.toMatchObject({ message: "This is not a valid branch name." });
  });

  it("offers no initialization for a bare repository, a .git folder or a repository that is too deep", async () => {
    const bare = "Foo.git";
    await expect(call("project_add", { path: `/srv/${bare}` })).rejects.toMatchObject({ code: "noRepository" });
    await expect(call("project_init_info", { path: `/srv/${bare}` })).rejects.toMatchObject({
      code: "bareRepository",
      message: "This folder is a bare Git repository. DeepGit needs a working folder.",
    });
    await expect(call("project_init_info", { path: "/work/app/.git" })).rejects.toMatchObject({ code: "insideGitDir" });
    const deep = "This folder has Git repositories deeper than DeepGit looks (5 levels). Add the folder that holds them.";
    await expect(call("project_add", { path: "/work/deep-stuff" })).rejects.toMatchObject({ code: "deepRepository", message: deep });
    await expect(call("project_init_info", { path: "/work/deep-stuff" })).rejects.toMatchObject({ code: "deepRepository" });
    await expect(call("project_init", { path: "/work/deep-stuff", branch: "main" })).rejects.toMatchObject({ code: "deepRepository" });
  });

  it("initializes the folder: one empty repository on the branch, and an active project", async () => {
    const before = await call<Workspace>("workspace_load");
    const project = await call<Project>("project_init", { path: folder, branch: " trunk " });
    expect(project).toMatchObject({ name: "IRIS-docs", path: folder });
    expect(project.repos).toHaveLength(1);
    const ws = await call<Workspace>("workspace_load");
    expect(ws.activeProjectId).toBe(project.id);
    expect(ws.projects).toHaveLength(before.projects.length + 1);
    // the repository has no commit yet
    const [summary] = await call<{ branch: string | null; headOid: string }[]>("repo_summaries", { repoIds: [project.repos[0].id] });
    expect(summary).toMatchObject({ branch: "trunk", headOid: "" });
    // the folder is a project now: adding it again returns the project, and init is refused
    expect((await call<Project>("project_add", { path: folder })).id).toBe(project.id);
    await expect(call("project_init", { path: folder, branch: "main" })).rejects.toMatchObject({ message: `${folder} holds a Git repository already.` });
    await call("project_remove", { projectId: project.id });
    await call("project_set_active", { projectId: before.activeProjectId });
  });
});
