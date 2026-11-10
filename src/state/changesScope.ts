/**
 * Which repos the Local changes view looks at, and how many changed files they have. Pure (no Solid, no DOM):
 * the view, the sidebar count, the tab badge and the stripe badge all go through here so they cannot disagree.
 * Unit tested in `changesScope.test.ts`.
 */
import type { RepoSummary } from "../api/types";

/**
 * The repos of the Local changes scope: the single repo the user picked (`onlyId`) when the project has several
 * repos and that repo is in the project, otherwise the repos that pass the repo filter (the project-level view).
 */
export function changesScope<T extends { id: string }>(all: readonly T[], filtered: readonly T[], onlyId: string | null): T[] {
  if (onlyId && all.length > 1) {
    const one = all.find((r) => r.id === onlyId);
    if (one) return [one];
  }
  return [...filtered];
}

/**
 * The repo that selecting a sidebar node scopes Local changes to, or null when it must not narrow anything: only a
 * repo row does it (not a branch, tag, stash, group or "more" row), and only in a project with several repos.
 */
export function changesRepoForNode(nodeKind: string, repoId: string, repoCount: number): string | null {
  return nodeKind === "repo" && repoCount > 1 ? repoId : null;
}

/** Changed files in a repo: staged + unstaged + untracked + conflicted (what the working tree list shows). */
export function dirtyCount(s: Pick<RepoSummary, "staged" | "unstaged" | "untracked" | "conflicted"> | undefined): number {
  return s ? s.staged + s.unstaged + s.untracked + s.conflicted : 0;
}

/** Changed files over `repos`, from their summaries. Repos without a summary yet count 0. */
export function changesCount(repos: readonly { id: string }[], summaryOf: (repoId: string) => RepoSummary | undefined): number {
  return repos.reduce((n, r) => n + dirtyCount(summaryOf(r.id)), 0);
}
