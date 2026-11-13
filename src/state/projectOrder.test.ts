import { describe, expect, it } from "vitest";
import type { Project } from "../api/types";
import { compareProjects } from "./workspace";

const p = (name: string, path = `/w/${name}`): Project => ({ id: name, name, path, repos: [] });

describe("compareProjects", () => {
  it("sorts by name, ignoring case", () => {
    const sorted = [p("shared-lib"), p("HAB"), p("iris"), p("Api")].sort(compareProjects).map((x) => x.name);
    expect(sorted).toEqual(["Api", "HAB", "iris", "shared-lib"]);
  });

  it("puts numbers in numeric order", () => {
    const sorted = [p("app 10"), p("app 2"), p("app 1")].sort(compareProjects).map((x) => x.name);
    expect(sorted).toEqual(["app 1", "app 2", "app 10"]);
  });

  it("falls back to the path for equal names", () => {
    const sorted = [p("api", "/b/api"), p("API", "/a/api")].sort(compareProjects).map((x) => x.path);
    expect(sorted).toEqual(["/a/api", "/b/api"]);
  });
});
