/** Colors: strength of the repository tints, and the color of the project and each of its repositories. */
import { For, type JSX, Show } from "solid-js";
import { Button, openMenu, plural } from "../../../components/ui";
import { projectColorMenu, repoColorMenu, resetColorsToAuto } from "../../../state/colorActions";
import { confirmAction } from "../../../state/dialogs";
import { TINT_STRENGTH_MAX, TINT_STRENGTH_MIN, TINT_STRENGTH_STEP } from "../../../state/appearance";
import { repoColor } from "../../../state/colors";
import { resetSettings, setSetting, settings } from "../../../state/settings";
import { activeProject, projectRepos } from "../../../state/workspace";
import { type ColorChoice, HEX_COLOR, REPO_COLOR_NAMES, paletteIndex } from "../../../theme/palette";
import { registerSettingsSection } from "../registry";
import { Row, Section, SizeControl } from "../widgets";

type Holder = { id: string; name: string } & ColorChoice;

/** "Electric blue" for a palette color, "#1A2B3C" for a custom one. */
const colorName = (c: ColorChoice): string => (c.customColor && HEX_COLOR.test(c.customColor) ? c.customColor.toUpperCase() : REPO_COLOR_NAMES[paletteIndex(c.color)]);

/** One project or repository: swatch, color name and the "Change…" menu (the same swatches, Auto and Custom… as the Set Color menu). */
function ColorRow(props: { item: Holder; kind: "project" | "repo"; hint?: string }): JSX.Element {
  const change = (anchor: HTMLElement) => {
    const menu = props.kind === "project" ? projectColorMenu(props.item) : repoColorMenu(props.item);
    openMenu(anchor, menu.submenu ?? []);
  };
  return (
    <Row label={props.item.name} hint={props.hint}>
      <div class="dg-settings-color">
        <span class="dg-settings-swatch" style={{ background: repoColor(props.item) }} aria-hidden="true" />
        <span class="dg-settings-color-name">{colorName(props.item)}</span>
        <Button size="small" icon="palette" aria-label={`Change the color of ${props.item.name}`} onClick={(e) => change(e.currentTarget)}>
          Change…
        </Button>
      </div>
    </Row>
  );
}

function ColorsSection(): JSX.Element {
  const resetColors = async () => {
    const project = activeProject();
    if (!project) return;
    const ok = await confirmAction({
      title: "Reset all colors to Auto?",
      message: `The color of ${project.name} and of its ${plural(projectRepos().length, "repository", "repositories")} goes back to the automatic one. Colors you picked are lost.`,
      confirmLabel: "Reset colors",
      danger: true,
    });
    if (ok) await resetColorsToAuto();
  };
  return (
    <>
      <Section title="Tints">
        <Row label="Repository tint strength" hint="How strongly rows and headers are tinted with the color of their repository. 0 turns the tints off. Default 100%.">
          <SizeControl
            label="Repository tint strength"
            value={settings.repoTintStrength}
            min={TINT_STRENGTH_MIN}
            max={TINT_STRENGTH_MAX}
            step={TINT_STRENGTH_STEP}
            unit="%"
            zeroLabel="Off"
            onChange={(v) => setSetting("repoTintStrength", v)}
          />
        </Row>
      </Section>

      <Section title={activeProject() ? `Colors of ${activeProject()!.name}` : "Colors"}>
        <Show when={activeProject()} fallback={<div class="dg-settings-note">Open a project to change the colors of its repositories.</div>}>
          {(project) => (
            <>
              <ColorRow item={project()} kind="project" hint="The project itself." />
              <For each={projectRepos()}>{(repo) => <ColorRow item={repo} kind="repo" />}</For>
              <div class="dg-settings-actions">
                <Button icon="reset" onClick={() => void resetColors()}>
                  Reset all colors to Auto
                </Button>
              </div>
            </>
          )}
        </Show>
      </Section>
    </>
  );
}

registerSettingsSection({
  id: "colors",
  title: "Colors",
  order: 50,
  icon: "palette",
  keywords: ["tint", "tints", "strength", "repository", "repo", "project", "color", "colour", "swatch", "palette", "auto", "custom", "reset"],
  component: ColorsSection,
  // The colors themselves are workspace data, not settings: only the tint strength comes back to its default.
  reset: () => resetSettings(["repoTintStrength"]),
});
