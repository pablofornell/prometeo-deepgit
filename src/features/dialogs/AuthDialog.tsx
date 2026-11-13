/**
 * Login dialog of the network commands (fetch, pull, push), in the style of the JetBrains login dialog: one
 * dialog per question of git or ssh. User name + password in one dialog for HTTPS, a masked field for a password,
 * token or key passphrase, a fingerprint with Accept / Reject for an unknown host. "Remember" saves the secret in
 * the system key store after the command succeeded (the backend decides when).
 */
import { type JSX, Show, createEffect, createSignal } from "solid-js";
import { Checkbox, Dialog, type DialogComponentProps, IconButton, TextField } from "../../components/ui";
import { withdrawnPromptId } from "../../state/auth";
import type { AuthProps } from "../../state/dialogs";
import { settings } from "../../state/settings";
import { repoById } from "../../state/workspace";
import type { AuthDialogResult } from "../../state/authQueue";
import { canRememberKind, dialogTitle, fingerprintText, hostName, isSecretKind, secretLabel } from "./authText";
import { Field, Note, ReadOnly } from "./parts";

/** A masked field with a show / hide toggle. */
function SecretField(props: { value: string; onInput: (v: string) => void; label: string; hint?: string }): JSX.Element {
  const [shown, setShown] = createSignal(false);
  return (
    <Field label={props.label} hint={props.hint}>
      <TextField
        type={shown() ? "text" : "password"}
        value={props.value}
        onInput={props.onInput}
        autocomplete="off"
        spellcheck={false}
        aria-label={props.label}
        trailing={<IconButton icon="eye" label={shown() ? "Hide" : "Show"} active={shown()} size="small" iconSize={14} tabindex={-1} onClick={() => setShown(!shown())} />}
      />
    </Field>
  );
}

export function AuthDialog(props: AuthProps & DialogComponentProps<AuthDialogResult>): JSX.Element {
  const p = () => props.prompt;
  const [user, setUser] = createSignal(p().user ?? "");
  const [secret, setSecret] = createSignal("");
  const [remember, setRemember] = createSignal(true);

  // the backend dropped the question (timeout, the command ended): nothing to answer any more
  createEffect(() => {
    if (withdrawnPromptId() === p().id) props.close();
  });

  const repoName = () => (p().repoId ? repoById(p().repoId as string)?.name : undefined);
  const secretKind = () => isSecretKind(p().kind);
  const offerRemember = () => p().canRemember && canRememberKind(p().kind);
  // the user wants saving (setting on) but the key store does not work
  const noKeyStore = () => settings.useCredentialStore && !p().canRemember && canRememberKind(p().kind) && p().kind !== "unknown";

  const canSubmit = (): boolean => {
    switch (p().kind) {
      case "hostkey":
        return true;
      case "username":
        return user().trim() !== "";
      case "unknown":
        return true;
      default:
        return secret() !== "";
    }
  };

  const submit = (): void => {
    if (!canSubmit()) return;
    const kind = p().kind;
    const remembered = offerRemember() && remember();
    if (kind === "hostkey") props.close({ answer: "yes", remember: false });
    else if (kind === "username") props.close({ answer: user().trim(), secondary: p().withPassword ? secret() : undefined, remember: remembered });
    else props.close({ answer: secret(), remember: remembered });
  };

  return (
    <Dialog
      title={dialogTitle(p())}
      onClose={() => props.close()}
      cancelLabel={p().kind === "hostkey" ? "Reject" : "Cancel"}
      primary={{ label: p().kind === "hostkey" ? "Accept" : "OK", disabled: !canSubmit(), onClick: submit }}
      footerLeft={
        <Show when={offerRemember()}>
          <Checkbox checked={remember()} onChange={setRemember} label="Remember" title="Save in the system key store after the command succeeds" />
        </Show>
      }
    >
      <Show when={repoName()}>
        {(name) => (
          <div class="dg-dialogs-text">
            Needed by <strong>{name()}</strong>.
          </div>
        )}
      </Show>
      <Show when={p().retry}>
        <Note kind="error">The previous answer was rejected. Try again.</Note>
      </Show>

      {/* unknown host */}
      <Show when={p().kind === "hostkey"}>
        <div class="dg-dialogs-text">
          DeepGit cannot verify <strong>{hostName(p().host) || "this host"}</strong>.
        </div>
        <pre class="dg-dialogs-fingerprint dg-selectable">{fingerprintText(p().prompt)}</pre>
        <Note kind="warning">Accept only if the fingerprint is the one your host publishes. DeepGit then adds it to your known hosts.</Note>
      </Show>

      {/* user name (+ password) */}
      <Show when={p().kind === "username"}>
        <Field label="Username">
          <TextField value={user()} onInput={setUser} autocomplete="username" spellcheck={false} aria-label="Username" />
        </Field>
        <Show when={p().withPassword}>
          <SecretField value={secret()} onInput={setSecret} label="Password or token" hint="Use a personal access token if the host does not accept your password." />
        </Show>
      </Show>

      {/* password, passphrase, PIN */}
      <Show when={p().kind === "password" || p().kind === "passphrase" || p().kind === "pin"}>
        <Show when={p().kind === "password" && p().user}>
          <Field label="Username">
            <ReadOnly icon="user">{p().user}</ReadOnly>
          </Field>
        </Show>
        <SecretField value={secret()} onInput={setSecret} label={secretLabel(p())} />
      </Show>

      {/* anything else git or ssh asks */}
      <Show when={p().kind === "unknown"}>
        <SecretField value={secret()} onInput={setSecret} label={secretLabel(p())} />
      </Show>

      <Show when={noKeyStore()}>
        <Note kind="info">No system key store was found, so this cannot be saved. DeepGit will ask again next time.</Note>
      </Show>
      <Show when={secretKind() && !noKeyStore() && !p().canRemember && !settings.useCredentialStore}>
        <div class="dg-dialogs-hint">Saving is off (Settings: use the credential store).</div>
      </Show>
    </Dialog>
  );
}
