/** Log: commit graph. */
import { type JSX } from "solid-js";
import { Checkbox } from "../../../components/ui";
import { resetSettings, setSetting, settings } from "../../../state/settings";
import { registerSettingsSection } from "../registry";
import { Row, Section } from "../widgets";

function LogSection(): JSX.Element {
  return (
    <Section title="Commit graph">
      <Row label="Show the commit graph" hint="The lines and dots left of the subject.">
        <Checkbox checked={settings.showGraph} ariaLabel="Show the commit graph" onChange={(v) => setSetting("showGraph", v)} />
      </Row>
    </Section>
  );
}

registerSettingsSection({
  id: "log",
  title: "Log",
  order: 20,
  icon: "log",
  keywords: ["graph", "lane", "lanes", "commit", "branch"],
  component: LogSection,
  reset: () => resetSettings(["showGraph"]),
});
