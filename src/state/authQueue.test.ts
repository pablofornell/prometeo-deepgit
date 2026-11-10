// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { AuthPrompt } from "../api/types";
import { type AuthDialogResult, createAuthQueue } from "./authQueue";

const prompt = (id: number, o: Partial<AuthPrompt> = {}): AuthPrompt => ({
  id, kind: "password", prompt: "Password: ", command: "git push", withPassword: false, canRemember: true, retry: false, ...o,
});

/** A dialog the test closes by hand. */
function harness() {
  const shown: number[] = [];
  const replies: { id: number; answer: string | null; remember: boolean; secondary: string | null }[] = [];
  const closers = new Map<number, (r: AuthDialogResult | undefined) => void>();
  const closedByBackend: number[] = [];
  const queue = createAuthQueue({
    show: (p) =>
      new Promise((resolve) => {
        shown.push(p.id);
        closers.set(p.id, resolve);
      }),
    reply: async (id, answer, remember, secondary) => {
      replies.push({ id, answer, remember, secondary });
    },
    closeActive: (id) => {
      closedByBackend.push(id);
      closers.get(id)?.(undefined);
    },
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { queue, shown, replies, closers, closedByBackend, flush };
}

describe("auth prompt queue", () => {
  it("shows one dialog at a time, in arrival order", async () => {
    const h = harness();
    h.queue.push(prompt(1));
    h.queue.push(prompt(2));
    h.queue.push(prompt(3));
    await h.flush();
    expect(h.shown).toEqual([1]);
    expect(h.queue.waiting()).toBe(2);
    h.closers.get(1)?.({ answer: "a", remember: false });
    await h.flush();
    expect(h.shown).toEqual([1, 2]);
    h.closers.get(2)?.({ answer: "b", remember: true });
    await h.flush();
    h.closers.get(3)?.({ answer: "c", remember: false, secondary: "pw" });
    await h.flush();
    expect(h.replies).toEqual([
      { id: 1, answer: "a", remember: false, secondary: null },
      { id: 2, answer: "b", remember: true, secondary: null },
      { id: 3, answer: "c", remember: false, secondary: "pw" },
    ]);
    expect(h.queue.active()).toBeNull();
  });

  it("sends a cancel when the dialog closes without a result", async () => {
    const h = harness();
    h.queue.push(prompt(1));
    await h.flush();
    h.closers.get(1)?.(undefined);
    await h.flush();
    expect(h.replies).toEqual([{ id: 1, answer: null, remember: false, secondary: null }]);
  });

  it("drops a waiting prompt the backend withdrew", async () => {
    const h = harness();
    h.queue.push(prompt(1));
    h.queue.push(prompt(2));
    await h.flush();
    h.queue.withdraw(2);
    h.closers.get(1)?.({ answer: "a", remember: false });
    await h.flush();
    expect(h.shown).toEqual([1]);
    expect(h.replies.map((r) => r.id)).toEqual([1]);
  });

  it("closes the dialog on screen when the backend withdraws it, and sends no reply", async () => {
    const h = harness();
    h.queue.push(prompt(1));
    h.queue.push(prompt(2));
    await h.flush();
    h.queue.withdraw(1);
    await h.flush();
    expect(h.closedByBackend).toEqual([1]);
    expect(h.replies).toEqual([]);
    // the next prompt follows
    expect(h.shown).toEqual([1, 2]);
  });

  it("ignores the same prompt id twice", async () => {
    const h = harness();
    h.queue.push(prompt(1));
    h.queue.push(prompt(1));
    await h.flush();
    expect(h.shown).toEqual([1]);
    expect(h.queue.waiting()).toBe(0);
  });
});
