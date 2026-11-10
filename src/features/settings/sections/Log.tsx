/** Log: commit graph and lane colours. */
import { type JSX } from "solid-js";
import { Checkbox, SegmentedControl } from "../../../components/ui";
import { type LaneColorMode, resetSettings, setSetting, settings } from "../../../state/settings";
import { registerSettingsSection } from "../registry";
import { Row, Section } from "../widgets";

const LANES: { value: LaneColorMode; label: string }[] = [
  { value: "repo", label: "By repository" },
  { value: "branch", label: "By branch" },
];

function LogSection(): JSX.Element {
  return (
    <Section title="Commit graph">
      <Row label="Show the commit graph" hint="The lines and dots left of the subject.">
        <Checkbox checked={settings.showGraph} ariaLabel="Show the commit graph" onChange={(v) => setSetting("showGraph", v)} />
      </Row>
      <Row label="Lane colors" hint="In the combined log of several repositories.">
        <SegmentedControl label="Lane colors" value={settings.laneColors} options={LANES} onChange={(v) => setSetting("laneColors", v)} />
      </Row>
    </Section>
  );
}

registerSettingsSection({
  id: "log",
  title: "Log",
  order: 20,
  icon: "log",
  keywords: ["graph", "lane", "colors", "colours", "commit", "repository", "branch"],
  component: LogSection,
  reset: () => resetSettings(["showGraph", "laneColors"]),
});
