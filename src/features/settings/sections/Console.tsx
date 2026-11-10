/** Console: what the git console records. */
import { type JSX } from "solid-js";
import { Checkbox } from "../../../components/ui";
import { resetSettings, setSetting, settings } from "../../../state/settings";
import { registerSettingsSection } from "../registry";
import { Row, Section } from "../widgets";

function ConsoleSection(): JSX.Element {
  return (
    <Section title="Git console">
      <Row label="Show background commands" hint="Commands DeepGit runs by itself (status, log, ...). Off: only the commands you start.">
        <Checkbox checked={settings.showBackgroundCommands} ariaLabel="Show background commands" onChange={(v) => setSetting("showBackgroundCommands", v)} />
      </Row>
    </Section>
  );
}

registerSettingsSection({
  id: "console",
  title: "Console",
  order: 30,
  icon: "console",
  keywords: ["git", "commands", "background", "output", "log"],
  component: ConsoleSection,
  reset: () => resetSettings(["showBackgroundCommands"]),
});
