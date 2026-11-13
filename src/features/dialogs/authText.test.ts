// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { AuthPrompt } from "../../api/types";
import { canRememberKind, commandVerb, dialogTitle, fingerprintText, hostName, secretLabel, tildePath } from "./authText";

const prompt = (o: Partial<AuthPrompt>): AuthPrompt => ({
  id: 1, kind: "unknown", prompt: "", command: "git push", withPassword: false, canRemember: true, retry: false, ...o,
});

describe("hostName", () => {
  it("drops scheme and user", () => {
    expect(hostName("https://github.com")).toBe("github.com");
    expect(hostName("https://alice@git.example.com:8443")).toBe("git.example.com:8443");
    expect(hostName("alice@example.com")).toBe("example.com");
    expect(hostName("github.com (140.82.121.4)")).toBe("github.com (140.82.121.4)");
    expect(hostName(undefined)).toBe("");
  });
});

describe("tildePath", () => {
  it("shortens the home folder", () => {
    expect(tildePath("/home/ana/.ssh/id_ed25519")).toBe("~/.ssh/id_ed25519");
    expect(tildePath("/Users/ana/.ssh/id_rsa")).toBe("~/.ssh/id_rsa");
    expect(tildePath("C:\\Users\\ana\\.ssh\\id_rsa")).toBe("~\\.ssh\\id_rsa");
    expect(tildePath("/etc/ssh/key")).toBe("/etc/ssh/key");
  });
});

describe("dialogTitle", () => {
  it("names the host, the key or the situation", () => {
    expect(dialogTitle(prompt({ kind: "username", host: "https://github.com" }))).toBe("Log in to github.com");
    expect(dialogTitle(prompt({ kind: "password", host: "https://github.com", user: "a" }))).toBe("Log in to github.com");
    expect(dialogTitle(prompt({ kind: "passphrase", keyPath: "/home/ana/.ssh/id_ed25519" }))).toBe("Unlock SSH key ~/.ssh/id_ed25519");
    expect(dialogTitle(prompt({ kind: "hostkey" }))).toBe("Unknown host");
    expect(dialogTitle(prompt({ kind: "unknown" }))).toBe("Authentication required");
  });
});

describe("fingerprintText", () => {
  it("keeps the fingerprint and drops the yes/no question", () => {
    const text = "The authenticity of host 'h (1.2.3.4)' can't be established.\nED25519 key fingerprint is SHA256:abc.\nThis key is not known by any other names.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ";
    const out = fingerprintText(text);
    expect(out).toContain("SHA256:abc");
    expect(out).not.toContain("Are you sure");
  });
});

describe("kinds", () => {
  it("only credentials can be remembered", () => {
    expect(canRememberKind("password")).toBe(true);
    expect(canRememberKind("passphrase")).toBe(true);
    expect(canRememberKind("username")).toBe(true);
    expect(canRememberKind("hostkey")).toBe(false);
    expect(canRememberKind("unknown")).toBe(false);
  });
  it("labels the secret field", () => {
    expect(secretLabel(prompt({ kind: "password", host: "https://github.com" }))).toBe("Password or token");
    expect(secretLabel(prompt({ kind: "password", host: "alice@host" }))).toBe("Password");
    expect(secretLabel(prompt({ kind: "passphrase" }))).toBe("Passphrase");
    expect(secretLabel(prompt({ kind: "unknown", prompt: "Verification code: " }))).toBe("Verification code");
  });
});

describe("commandVerb", () => {
  it("turns the git command into a plain verb", () => {
    expect(["git fetch", "git pull", "git push", "git clone", "git  Push"].map(commandVerb)).toEqual(["fetch", "pull", "push", "clone", "push"]);
  });
  it("says nothing for any other command", () => {
    expect(["git ls-remote", "git", "", "ssh host"].map(commandVerb)).toEqual(["", "", "", ""]);
  });
});
