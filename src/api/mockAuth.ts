/**
 * Browser mock of the credential prompts (docs/PLAN.md section 5.6). Only private `https://` remotes ask
 * (`requiresLogin`): the mock repo "docs-site" and any https URL with "private" in it (try cloning
 * `https://github.com/acme/private-repo.git`). Public https URLs and ssh remotes ("the agent") never ask.
 * Like git with `GIT_ASKPASS`:
 *
 * - saved credentials (key store on, "Remember" ticked earlier) are used without a dialog;
 * - otherwise an `auth-prompt` event opens one dialog (user name + password) and the command waits
 *   for `auth_reply`;
 * - a background command (`silent`, the auto-fetch) never opens the dialog: it uses saved credentials or fails
 *   with "No credentials were given";
 * - Cancel fails the command with "No credentials were given";
 * - aborting the command (`signal`, a clone that is cancelled) closes the open dialog (`auth-prompt-close`);
 * - the password `wrong` is rejected by the fake server (a saved entry that is rejected is deleted);
 * - credentials are saved only when the command succeeds (`session.commit()`), never before.
 */
import type { AuthPrompt } from "./types";

type Emit = (event: string, payload: unknown) => void;
type Reply = { answer: string | null; remember: boolean; secondary: string | null };

const saved = new Map<string, string>();
const waiting = new Map<number, (r: Reply | "aborted") => void>();
let useStore = true;
let nextId = 1;

/** The rejection shape of a failed command (same as the Rust `ApiError`). */
const fail = (message: string, detail: string): never => {
  throw { message, detail };
};

/** Whether the fake server behind `url` wants a login. */
export const requiresLogin = (url: string): boolean => url.startsWith("https://") && (/private/i.test(url) || /\/docs-site(\.git)?\/?$/.test(url));

export interface AuthOptions {
  /** A background command: saved credentials only, no dialog. */
  silent?: boolean;
  /** Aborted while the dialog is open: the dialog closes and the command fails as cancelled. */
  signal?: AbortSignal;
}

export interface AuthSession {
  /** The command succeeded: save what the user asked to remember. */
  commit(): void;
}

const NOTHING: AuthSession = { commit() {} };

const loginKey = (origin: string) => `login:${origin}`;
const passwordKey = (user: string, origin: string) => origin.replace("://", `://${user}@`);

/**
 * Authenticates a command of the mock repo at `repoUrl`. Resolves when git would have the
 * credentials; rejects like a failed git command otherwise.
 */
export async function beginAuth(emit: Emit, repoId: string | null, repoUrl: string, command: string, opts: AuthOptions = {}): Promise<AuthSession> {
  if (!requiresLogin(repoUrl)) return NOTHING;
  const origin = new URL(repoUrl).origin;
  const rejected = () =>
    fail(
      "Authentication failed. Check your user name and password or token, then try again.",
      `remote: Invalid username or password.\nfatal: Authentication failed for '${repoUrl}'`,
    );

  if (useStore) {
    const user = saved.get(loginKey(origin));
    const password = user === undefined ? undefined : saved.get(passwordKey(user, origin));
    if (user !== undefined && password !== undefined) {
      if (password === "wrong") {
        saved.delete(loginKey(origin));
        saved.delete(passwordKey(user, origin));
        return rejected();
      }
      return NOTHING;
    }
  }

  const noCredentials = () =>
    fail(
      "No credentials were given. Run the command again and enter them, or set up a credential helper or an SSH agent.",
      `fatal: could not read Username for '${origin}': terminal prompts disabled`,
    );
  if (opts.silent) return noCredentials();

  const id = nextId++;
  const prompt: AuthPrompt = {
    id,
    kind: "username",
    prompt: `Username for '${origin}': `,
    host: origin,
    ...(repoId === null ? {} : { repoId }),
    command,
    withPassword: true,
    canRemember: useStore,
    retry: false,
  };
  const reply = new Promise<Reply | "aborted">((resolve) => {
    waiting.set(id, resolve);
    opts.signal?.addEventListener("abort", () => {
      if (waiting.delete(id)) {
        emit("auth-prompt-close", { id });
        resolve("aborted");
      }
    });
  });
  emit("auth-prompt", prompt);
  const r = await reply;
  if (r === "aborted") return fail("The operation was cancelled.", "");
  if (r.answer === null) return noCredentials();
  const user = r.answer;
  const password = r.secondary ?? "";
  if (user === "" || password === "" || password === "wrong") return rejected();
  return {
    commit() {
      if (useStore && r.remember) {
        saved.set(loginKey(origin), user);
        saved.set(passwordKey(user, origin), password);
      }
    },
  };
}

/** Command `auth_reply`. `answer = null` is Cancel. Returns false when nobody waits for `id`. */
export function authReply(args: Record<string, unknown>): boolean {
  const id = typeof args.id === "number" ? args.id : -1;
  const resolve = waiting.get(id);
  if (!resolve) return false;
  waiting.delete(id);
  resolve({
    answer: typeof args.answer === "string" ? args.answer : null,
    remember: args.remember === true,
    secondary: typeof args.secondary === "string" ? args.secondary : null,
  });
  return true;
}

/** Command `set_auth_prefs`. */
export function setAuthPrefs(args: Record<string, unknown>): void {
  useStore = args.useCredentialStore !== false;
}

/** Command `credentials_clear`: forgets everything saved; returns how many entries went. */
export function credentialsClear(): number {
  const n = saved.size;
  saved.clear();
  return n;
}

/** For tests: how many credentials the mock key store holds. */
export const savedCount = (): number => saved.size;
