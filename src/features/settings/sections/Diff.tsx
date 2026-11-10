/** Diff viewer: scrolling of long lines. */
import { type JSX } from "solid-js";
import { Checkbox } from "../../../components/ui";
import { resetSettings, setSetting, settings } from "../../../state/settings";
import { registerSettingsSection } from "../registry";
import { Row, Section } from "../widgets";

function DiffSection(): JSX.Element {
  return (
    <Section title="Scrolling">
      <Row label="Scroll horizontally with the pointer" hint="Move the pointer left or right to scroll long lines. The wheel still scrolls vertically.">
        <Checkbox checked={settings.diffPointerScroll} ariaLabel="Scroll horizontally with the pointer" onChange={(v) => setSetting("diffPointerScroll", v)} />
      </Row>
    </Section>
  );
}

registerSettingsSection({
  id: "diff",
  title: "Diff viewer",
  order: 25,
  keywords: ["diff", "scroll", "horizontal", "mouse", "pointer", "long", "lines"],
  component: DiffSection,
  reset: () => resetSettings(["diffPointerScroll"]),
});
