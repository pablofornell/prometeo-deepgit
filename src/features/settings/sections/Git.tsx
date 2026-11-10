/** Git: auto-fetch, commit sign-off and the saved logins of fetch, pull, push and clone. */
import { type JSX, Show, createSignal } from "solid-js";
import { Button, Checkbox, Select, plural, toast } from "../../../components/ui";
import { toApiError } from "../../../api/tauri";
import { clearSavedCredentials, credentialStoreUnavailable } from "../../../state/auth";
import { confirmAction } from "../../../state/dialogs";
import { AUTO_FETCH_CHOICES, resetSettings, setSetting, settings } from "../../../state/settings";
import { registerSettingsSection } from "../registry";
import { Row, Section } from "../widgets";

const INTERVALS = AUTO_FETCH_CHOICES.map((m) => ({ value: String(m), label: m === 0 ? "Off" : `Every ${m} min` }));

function GitSection(): JSX.Element {
  const [clearing, setClearing] = createSignal(false);

  const forget = async () => {
    const ok = await confirmAction({
      title: "Forget saved logins?",
      message: "DeepGit removes every password, token and key passphrase it saved in the system key store. It asks again the next time a remote needs a login.",
      confirmLabel: "Forget",
      danger: true,
    });
    if (!ok) return;
    setClearing(true);
    try {
      const n = await clearSavedCredentials();
      toast({
        kind: "success",
        title: n === 0 ? "No saved logins to forget" : `Forgot ${plural(n, "saved entry", "saved entries")}`,
        body: n === 0 ? undefined : "DeepGit removed them from the system key store.",
      });
    } catch (e) {
      toast({ kind: "error", title: "Could not forget the saved logins", body: toApiError(e).message });
    } finally {
      setClearing(false);
    }
  };

  return (
    <>
      <Section title="Fetch">
        <Row label="Auto-fetch" hint="Fetches every repository of the project in the background. It never asks for a login: it uses saved logins and SSH agent keys only.">
          <Select
            ariaLabel="Auto-fetch interval"
            value={String(settings.autoFetchMinutes)}
            options={INTERVALS}
            onChange={(v) => setSetting("autoFetchMinutes", Number(v))}
          />
        </Row>
        <Row label="Prune on fetch" hint="Auto-fetch also removes remote branches that no longer exist.">
          <Checkbox
            checked={settings.autoFetchPrune}
            ariaLabel="Prune on fetch"
            disabled={settings.autoFetchMinutes === 0}
            onChange={(v) => setSetting("autoFetchPrune", v)}
          />
        </Row>
      </Section>

      <Section title="Commit">
        <Row label="Sign-off commits by default" hint="Adds a Signed-off-by line. The Sign-off box of the commit box starts ticked.">
          <Checkbox checked={settings.commitSignOff} ariaLabel="Sign-off commits by default" onChange={(v) => setSetting("commitSignOff", v)} />
        </Row>
      </Section>

      <Section title="Credentials">
        <Row label="Save passwords in the system key store" hint="Secret Service, Keychain or Credential Manager. Off: DeepGit still asks, but never reads or saves a login.">
          <Checkbox checked={settings.useCredentialStore} ariaLabel="Save passwords in the system key store" onChange={(v) => setSetting("useCredentialStore", v)} />
        </Row>
        <Show when={credentialStoreUnavailable()}>
          <div class="dg-settings-note" role="status">
            DeepGit found no system key store (Secret Service, Keychain or Credential Manager), so it cannot save logins. It asks every time.
          </div>
        </Show>
        <Row label="Saved logins" hint="Forget every password, token and key passphrase DeepGit saved.">
          <Button icon="delete" disabled={clearing()} onClick={() => void forget()}>
            Forget saved logins…
          </Button>
        </Row>
      </Section>
    </>
  );
}

registerSettingsSection({
  id: "git",
  title: "Git",
  order: 40,
  icon: "fetch",
  keywords: ["fetch", "auto-fetch", "automatic", "prune", "sign-off", "signoff", "signed-off", "commit", "credentials", "password", "token", "login", "keyring", "key store", "passphrase", "ssh", "https", "forget"],
  component: GitSection,
  reset: () => resetSettings(["autoFetchMinutes", "autoFetchPrune", "commitSignOff", "useCredentialStore"]),
});
