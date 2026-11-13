// Adding a folder that has no repository asks for `git init` instead of failing (ITERATION-3.md section 4).
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/tauri";
import type { InitInfo, Project } from "../api/types";

const showDialog = vi.fn();
const toast = vi.fn();
vi.mock("./dialogs", () => ({ showDialog: (...args: unknown[]) => showDialog(...args) }));
vi.mock("../components/ui/Toast", () => ({ toast: (...args: unknown[]) => toast(...args) }));

import { addProject, loadWorkspace, workspace } from "./workspace";

const folder = "/home/dev/Notes-docs";

describe("addProject with a folder that has no repository", () => {
  beforeEach(async () => {
    showDialog.mockReset();
    toast.mockReset();
    await loadWorkspace();
  });

  it("opens the initialize dialog with what the backend says, and adds nothing when the user cancels", async () => {
    showDialog.mockResolvedValue(undefined);
    const before = workspace.projects.length;
    expect(await addProject(folder)).toBeNull();
    expect(showDialog).toHaveBeenCalledTimes(1);
    const [name, props] = showDialog.mock.calls[0] as [string, { info: InitInfo }];
    expect(name).toBe("initRepository");
    expect(props.info).toEqual({ path: folder, name: "Notes-docs", defaultBranch: "main", parentRepo: null });
    expect(workspace.projects.length).toBe(before);
    expect(toast).not.toHaveBeenCalled();
    // nothing was created: the folder still has no repository
    await expect(api.projectAdd(folder)).rejects.toMatchObject({ code: "noRepository" });
  });

  it("adds the project the dialog made and makes it the active one", async () => {
    showDialog.mockImplementation(async (_name: string, props: { info: InitInfo }) => {
      const project: Project = await api.projectInit(props.info.path, "trunk");
      return { project, branch: "trunk" };
    });
    const project = await addProject(folder);
    expect(project?.name).toBe("Notes-docs");
    expect(workspace.activeProjectId).toBe(project?.id);
    expect(workspace.projects.some((p) => p.id === project?.id)).toBe(true);
    expect(toast).toHaveBeenCalledWith({ kind: "success", title: "Initialized a repository in Notes-docs", body: "Branch trunk." });
  });

  it("does not open the dialog for a folder that has repositories", async () => {
    const project = await addProject("/home/dev/work/api");
    expect(showDialog).not.toHaveBeenCalled();
    expect(project?.path).toBe("/home/dev/work/api");
  });
});
