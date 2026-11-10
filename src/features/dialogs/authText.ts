/** Texts of the credential dialog (`AuthDialog`): titles, host and path shortening, the host-key fingerprint. */
import type { AuthPrompt } from "../../api/types";

/** `https://alice@github.com:443` -> `github.com:443`; `alice@host` -> `host`; a host-key host stays as is. */
export function hostName(host: string | undefined): string {
  if (!host) return "";
  return host.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^[^@\s]*@/, "");
}

/** `/home/ana/.ssh/id_ed25519` -> `~/.ssh/id_ed25519` (also macOS and Windows home folders). */
export function tildePath(path: string | undefined): string {
  if (!path) return "";
  return path.replace(/^\/home\/[^/]+\//, "~/").replace(/^\/Users\/[^/]+\//, "~/").replace(/^[A-Za-z]:\\Users\\[^\\]+\\/, "~\\");
}

export function dialogTitle(p: AuthPrompt): string {
  switch (p.kind) {
    case "username":
    case "password": {
      const h = hostName(p.host);
      return h ? `Log in to ${h}` : "Log in";
    }
    case "passphrase":
      return p.keyPath ? `Unlock SSH key ${tildePath(p.keyPath)}` : "Unlock SSH key";
    case "pin":
      return "Enter PIN";
    case "hostkey":
      return "Unknown host";
    default:
      return "Authentication required";
  }
}

/** The question ssh asks at the end of a host-key text, without the trailing answer hint. */
const HOSTKEY_QUESTION = /\n?\s*Are you sure you want to continue connecting[^\n]*$/i;

/** The host-key text for the dialog: what ssh says about the host and its fingerprint, without the yes/no question. */
export function fingerprintText(prompt: string): string {
  return prompt.replace(HOSTKEY_QUESTION, "").trim();
}

/** Secret kinds are masked and can be remembered; `username` is plain text. */
export function isSecretKind(kind: AuthPrompt["kind"]): boolean {
  return kind === "password" || kind === "passphrase" || kind === "pin";
}

/** Kinds whose answer can be saved in the key store. `unknown` and `hostkey` never are. */
export function canRememberKind(kind: AuthPrompt["kind"]): boolean {
  return kind === "username" || isSecretKind(kind);
}

/** The label above the secret field. */
export function secretLabel(p: AuthPrompt): string {
  switch (p.kind) {
    case "passphrase":
      return "Passphrase";
    case "pin":
      return "PIN";
    case "password":
      return p.host?.startsWith("http") ? "Password or token" : "Password";
    default:
      return p.prompt.replace(/[:\s]+$/, "") || "Secret";
  }
}
