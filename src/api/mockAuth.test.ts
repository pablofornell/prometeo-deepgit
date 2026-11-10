// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockInvoke, mockListen } from "./mock";
import { requiresLogin, savedCount } from "./mockAuth";
import type { AuthPrompt, CloneResult, OpResult, Workspace } from "./types";

const call = <T>(cmd: string, args?: Record<string, unknown>) => mockInvoke(cmd, args) as Promise<T>;

async function docsSite(): Promise<string> {
  const ws = await call<Workspace>("workspace_load");
  const repo = ws.projects.flatMap((p) => p.repos).find((r) => r.name === "docs-site");
  if (!repo) throw new Error("docs-site missing");
  return repo.id;
}

/** Answers the next `auth-prompt` with `reply` (null = cancel) and returns what was asked. */
function answerNext(reply: { answer: string | null; secondary?: string | null; remember?: boolean }): { asked: AuthPrompt[] } {
  const asked: AuthPrompt[] = [];
  const off = mockListen("auth-prompt", (p) => {
    off();
    asked.push(p as AuthPrompt);
    void call("auth_reply", { id: (p as AuthPrompt).id, answer: reply.answer, secondary: reply.secondary ?? null, remember: reply.remember ?? false });
  });
  return { asked };
}

async function clean(): Promise<void> {
  await call("credentials_clear");
  await call("set_auth_prefs", { useCredentialStore: true });
}

describe("mock credential prompts", () => {
  beforeEach(clean);

  it("a push to an https remote opens one dialog with user name and password", async () => {
    const id = await docsSite();
    const { asked } = answerNext({ answer: "alice", secondary: "s3cret" });
    const r = await call<OpResult>("push", { repoId: id });
    expect(r.ok).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ kind: "username", host: "https://github.com", repoId: id, command: "git push", withPassword: true, canRemember: true, retry: false });
    // the answer never shows up in the console entry
  });

  it("cancel fails the command like git without credentials", async () => {
    const id = await docsSite();
    answerNext({ answer: null });
    await expect(call("push", { repoId: id })).rejects.toMatchObject({ message: expect.stringContaining("No credentials were given") });
  });

  it("a rejected password fails with the authentication message and saves nothing", async () => {
    const id = await docsSite();
    answerNext({ answer: "alice", secondary: "wrong", remember: true });
    await expect(call("push", { repoId: id })).rejects.toMatchObject({ message: expect.stringContaining("Authentication failed") });
    expect(savedCount()).toBe(0);
  });

  it("Remember saves after success only, and the next command asks nothing", async () => {
    const id = await docsSite();
    answerNext({ answer: "alice", secondary: "s3cret", remember: true });
    await call("fetch", { repoId: id });
    expect(savedCount()).toBe(2);
    let asked = 0;
    const off = mockListen("auth-prompt", () => asked++);
    await call("fetch", { repoId: id });
    off();
    expect(asked).toBe(0);
  });

  it("without Remember the next command asks again", async () => {
    const id = await docsSite();
    answerNext({ answer: "alice", secondary: "s3cret", remember: false });
    await call("fetch", { repoId: id });
    expect(savedCount()).toBe(0);
    const { asked } = answerNext({ answer: "alice", secondary: "s3cret" });
    await call("fetch", { repoId: id });
    expect(asked).toHaveLength(1);
  });

  it("with the key store off nothing is read or offered", async () => {
    const id = await docsSite();
    answerNext({ answer: "alice", secondary: "s3cret", remember: true });
    await call("fetch", { repoId: id });
    expect(savedCount()).toBe(2);
    await call("set_auth_prefs", { useCredentialStore: false });
    const { asked } = answerNext({ answer: "alice", secondary: "s3cret", remember: true });
    await call("fetch", { repoId: id });
    expect(asked).toHaveLength(1);
    expect(asked[0].canRemember).toBe(false);
    expect(savedCount()).toBe(2);
  });

  it("credentials_clear forgets what was saved", async () => {
    const id = await docsSite();
    answerNext({ answer: "alice", secondary: "s3cret", remember: true });
    await call("fetch", { repoId: id });
    expect(await call<number>("credentials_clear")).toBe(2);
    expect(savedCount()).toBe(0);
  });

  it("a repo with an ssh remote never asks", async () => {
    const ws = await call<Workspace>("workspace_load");
    const repo = ws.projects.flatMap((p) => p.repos).find((r) => r.name === "api-gateway");
    if (!repo) throw new Error("api-gateway missing");
    let asked = 0;
    const off = mockListen("auth-prompt", () => asked++);
    await call("fetch", { repoId: repo.id });
    off();
    expect(asked).toBe(0);
  });

  it("auth_reply for an unknown prompt returns false", async () => {
    expect(await call<boolean>("auth_reply", { id: 99999, answer: "x", remember: false })).toBe(false);
  });

  it("a background fetch (auto-fetch) never opens the dialog: it fails fast without saved credentials", async () => {
    const id = await docsSite();
    let asked = 0;
    const off = mockListen("auth-prompt", () => asked++);
    await expect(call("fetch", { repoId: id, remote: null, prune: true, background: true })).rejects.toMatchObject({
      message: expect.stringContaining("No credentials were given"),
    });
    expect(asked).toBe(0);
    // with saved credentials the same background fetch works, still without a dialog
    answerNext({ answer: "alice", secondary: "s3cret", remember: true });
    await call("fetch", { repoId: id });
    await call("fetch", { repoId: id, background: true });
    off();
    expect(asked).toBe(1);
  });

  describe("clone", () => {
    const opts = { branch: null, depth: null, recurseSubmodules: false };
    const clone = (url: string, dirName: string, operationId: string) =>
      call<CloneResult>("clone_repo", { operationId, url, parentDir: "~/work/payments-platform", dirName, opts, target: { kind: "newProject" } });

    it("a private https URL asks for a login (a public or ssh one does not)", async () => {
      expect(requiresLogin("https://github.com/acme/widgets.git")).toBe(false);
      expect(requiresLogin("git@github.com:acme/private-widgets.git")).toBe(false);
      const answer = answerNext({ answer: "alice", secondary: "s3cret" });
      await clone("https://github.com/acme/private-widgets.git", "private-widgets", "op-private");
      expect(answer.asked).toHaveLength(1);
      expect(answer.asked[0]).toMatchObject({ command: "git clone", host: "https://github.com", withPassword: true });
      expect(answer.asked[0].repoId).toBeUndefined();
    }, 15000);

    it("cancelling the clone closes the open dialog", async () => {
      const events: string[] = [];
      const offPrompt = mockListen("auth-prompt", () => events.push("prompt"));
      const offClose = mockListen("auth-prompt-close", () => events.push("close"));
      const running = clone("https://github.com/acme/private-gadgets.git", "private-gadgets", "op-cancel");
      const settled = running.then(
        () => "ok",
        (e: { message?: string }) => e.message,
      );
      await vi.waitFor(() => expect(events).toEqual(["prompt"]));
      await call("clone_cancel", { operationId: "op-cancel" });
      expect(await settled).toBe("The operation was cancelled.");
      offPrompt();
      offClose();
      expect(events).toEqual(["prompt", "close"]);
    });
  });
});
