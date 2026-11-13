/** Appearance: theme, text and editor sizes, page zoom, row density, date format. */
import { type JSX } from "solid-js";
import { Checkbox, SegmentedControl, THEME_ICONS } from "../../../components/ui";
import {
  EDITOR_FONT_SIZE_DEFAULT, FONT_SIZE_MAX, FONT_SIZE_MIN, UI_SCALE_MAX, UI_SCALE_MIN, UI_SCALE_STEP, effectiveEditorFontSize,
} from "../../../state/appearance";
import { dateExample, formatDate } from "../../../state/dates";
import { formatKeys } from "../../../state/keymap";
import { type DateFormat, type ThemePref, resetSettings, setSetting, settings } from "../../../state/settings";
import { registerSettingsSection } from "../registry";
import { type Choice, ChoiceList, Row, Section, SizeControl } from "../widgets";

const THEMES: { value: ThemePref; label: string; icon: (typeof THEME_ICONS)[ThemePref] }[] = [
  { value: "dark", label: "Dark", icon: THEME_ICONS.dark },
  { value: "light", label: "Light", icon: THEME_ICONS.light },
  { value: "system", label: "System", icon: THEME_ICONS.system },
];
/** Each choice shows the moment 3 hours ago in that format; the examples follow the clock. */
const DATES: Choice<DateFormat>[] = [
  { value: "relative", label: "Relative", example: () => dateExample("relative") },
  { value: "absolute", label: "Absolute", example: () => dateExample("absolute") },
];
/** Times of the two preview commits, before now. */
const PREVIEW_AGO = [4 * 60, 26 * 3600];

/** Live sample: what the current sizes and date format look like. */
function Preview(): JSX.Element {
  const ago = (i: number) => formatDate(Math.floor(Date.now() / 1000) - PREVIEW_AGO[i]);
  return (
    <div class="dg-settings-preview" aria-hidden="true">
      <div class="dg-settings-preview-row is-selected">
        <span class="dg-settings-preview-subject">Fix race in fetch scheduler</span>
        <span class="dg-settings-preview-meta">Ana Ruiz · {ago(0)}</span>
        <span class="dg-settings-preview-hash">9f3c2a1</span>
      </div>
      <div class="dg-settings-preview-row">
        <span class="dg-settings-preview-subject">Add branch matrix</span>
        <span class="dg-settings-preview-meta">Luis Mora · {ago(1)}</span>
        <span class="dg-settings-preview-hash">c04e7b9</span>
      </div>
      <div class="dg-settings-preview-code">
        <span class="dg-settings-preview-del">- let retries = 3;</span>
        <span class="dg-settings-preview-add">+ let retries = config.fetch_retries();</span>
      </div>
    </div>
  );
}

function AppearanceSection(): JSX.Element {
  const followsUi = () => settings.editorFontSize === null;
  const editorSize = () => effectiveEditorFontSize(settings.fontSize, settings.editorFontSize);
  return (
    <>
      <Section title="Theme">
        <Row label="Color theme" hint="System follows the operating system.">
          <SegmentedControl label="Color theme" value={settings.theme} options={THEMES} onChange={(v) => setSetting("theme", v)} />
        </Row>
      </Section>

      <Section title="Size">
        <Row label="Font size" hint="Text, rows, buttons and icons grow with it. Default 13.">
          <SizeControl label="Font size" pin="layout" value={settings.fontSize} min={FONT_SIZE_MIN} max={FONT_SIZE_MAX} unit="px" onChange={(v) => setSetting("fontSize", v)} />
        </Row>
        <Row label="Editor font size" hint="Diff, console and commit hashes.">
          <div class="dg-settings-stack">
            <SizeControl
              label="Editor font size"
              pin="layout"
              value={editorSize()}
              min={FONT_SIZE_MIN}
              max={FONT_SIZE_MAX}
              unit="px"
              disabled={followsUi()}
              onChange={(v) => setSetting("editorFontSize", v)}
            />
            <Checkbox
              checked={followsUi()}
              label={`Follow the font size (default ${EDITOR_FONT_SIZE_DEFAULT} px at 13 px)`}
              onChange={(on) => setSetting("editorFontSize", on ? null : editorSize())}
            />
          </div>
        </Row>
        <Row label="UI scale" hint={`Zooms the whole window. ${formatKeys("Ctrl+=")} in, ${formatKeys("Ctrl+-")} out, ${formatKeys("Ctrl+0")} back to 100%.`}>
          <SizeControl
            label="UI scale"
            pin="zoom"
            value={settings.uiScale}
            min={UI_SCALE_MIN}
            max={UI_SCALE_MAX}
            step={UI_SCALE_STEP}
            unit="%"
            onChange={(v) => setSetting("uiScale", v)}
          />
        </Row>
        <Preview />
      </Section>

      <Section title="Lists and dates">
        <Row label="Comfortable rows" hint="Taller rows in the log.">
          <Checkbox checked={settings.comfortableRows} ariaLabel="Comfortable rows" onChange={(v) => setSetting("comfortableRows", v)} />
        </Row>
        <Row label="Date format" hint="Every date of the app. Absolute is dd-mm-yyyy. Tooltips show the full date.">
          <ChoiceList label="Date format" value={settings.dateFormat} options={DATES} onChange={(v) => setSetting("dateFormat", v)} />
        </Row>
      </Section>
    </>
  );
}

registerSettingsSection({
  id: "appearance",
  title: "Appearance",
  order: 10,
  icon: "palette",
  keywords: ["theme", "dark", "light", "font", "size", "zoom", "scale", "text", "editor", "rows", "density", "date", "eyes", "bigger"],
  component: AppearanceSection,
  reset: () => resetSettings(["theme", "fontSize", "editorFontSize", "uiScale", "comfortableRows", "dateFormat"]),
});
