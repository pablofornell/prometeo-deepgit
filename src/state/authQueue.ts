/**
 * Queue of credential questions (`auth-prompt` events). Several network commands can ask at the same time
 * (a fetch of 6 repos); the user sees one dialog at a time, in arrival order. Pure logic: the dialog and the
 * backend reply are injected (see `state/auth.ts`).
 */
import type { AuthPrompt } from "../api/types";

/** What the dialog returns. `undefined` (closed with Cancel or Esc) is a cancel. */
export interface AuthDialogResult {
  answer: string;
  /** The password of a `withPassword` dialog. */
  secondary?: string;
  remember: boolean;
}

export interface AuthQueueDeps {
  /** Opens the dialog for `prompt`; resolves when it closes. */
  show: (prompt: AuthPrompt) => Promise<AuthDialogResult | undefined>;
  /** Sends the answer (`null` = cancel) to the backend. */
  reply: (id: number, answer: string | null, remember: boolean, secondary: string | null) => Promise<unknown>;
  /** The backend withdrew the prompt that is on screen: close its dialog. */
  closeActive: (id: number) => void;
}

export interface AuthQueue {
  push(prompt: AuthPrompt): void;
  /** The backend dropped prompt `id` (timeout, command ended). */
  withdraw(id: number): void;
  /** Prompts waiting behind the one on screen. */
  waiting(): number;
  /** The id of the prompt on screen, or null. */
  active(): number | null;
}

export function createAuthQueue(deps: AuthQueueDeps): AuthQueue {
  const queue: AuthPrompt[] = [];
  let active: AuthPrompt | null = null;
  const withdrawn = new Set<number>();

  async function pump(): Promise<void> {
    if (active) return;
    const next = queue.shift();
    if (!next) return;
    active = next;
    let result: AuthDialogResult | undefined;
    try {
      result = await deps.show(next);
    } catch {
      result = undefined;
    }
    if (withdrawn.has(next.id)) {
      withdrawn.delete(next.id);
    } else {
      await deps.reply(next.id, result ? result.answer : null, result?.remember ?? false, result?.secondary ?? null).catch(() => undefined);
    }
    active = null;
    void pump();
  }

  return {
    push(prompt) {
      if (active?.id === prompt.id || queue.some((p) => p.id === prompt.id)) return;
      queue.push(prompt);
      void pump();
    },
    withdraw(id) {
      const i = queue.findIndex((p) => p.id === id);
      if (i >= 0) queue.splice(i, 1);
      else if (active?.id === id) {
        withdrawn.add(id);
        deps.closeActive(id);
      }
    },
    waiting: () => queue.length,
    active: () => active?.id ?? null,
  };
}
