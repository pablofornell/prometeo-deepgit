/**
 * Credential prompts of the network commands (fetch, pull, push). The backend sends `auth-prompt` while a command
 * waits for a user name, password, token, key passphrase or host-key decision; this module shows the "auth" dialog
 * (`features/dialogs/AuthDialog`) one prompt at a time and sends the answer back with `authReply`.
 * Subscribed once by `startEvents()`; features never call it.
 */
import { createSignal } from "solid-js";
import * as api from "../api/tauri";
import { toast } from "../components/ui";
import { createAuthQueue } from "./authQueue";
import { showDialog } from "./dialogs";

const [withdrawnId, setWithdrawnId] = createSignal<number | null>(null);

/** The dialog closes itself when this becomes its prompt id (the backend withdrew the question). */
export const withdrawnPromptId = withdrawnId;

const queue = createAuthQueue({
  show: (prompt) => showDialog("auth", { prompt }),
  reply: (id, answer, remember, secondary) => api.authReply(id, answer, remember, secondary),
  closeActive: (id) => setWithdrawnId(id),
});

let started = false;

/** Subscribes to `auth-prompt`, `auth-prompt-close` and `auth-notice`. Safe to call repeatedly. */
export function startAuth(): void {
  if (started) return;
  started = true;
  void api.onAuthPrompt((p) => queue.push(p));
  void api.onAuthPromptClose((e) => queue.withdraw(e.id));
  void api.onAuthNotice((n) => {
    if (n.kind === "storeUnavailable") {
      toast({
        kind: "warning",
        title: "Passwords cannot be saved",
        body: "DeepGit found no system key store (Secret Service, Keychain or Credential Manager). It will ask every time.",
      });
    }
  });
}

/** Forgets every credential DeepGit saved in the system key store; resolves to how many were removed. */
export const clearSavedCredentials = (): Promise<number> => api.credentialsClear();
