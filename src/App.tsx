/**
 * Application root: starts the stores (settings, events, keymap, workspace), mounts the global hosts
 * (menus, dialogs, toasts, tooltips, search everywhere) once, and shows the `Welcome` screen or the `Shell`.
 */
import { type JSX, Show, onCleanup, onMount } from "solid-js";
import { Gallery } from "./components/ui/Gallery";
import { DialogHost, MenuHost, ToastHost, TooltipHost } from "./components/ui";
import { registerAllDialogs } from "./features/dialogs";
import { SearchEverywhere } from "./features/palette/SearchEverywhere";
import { SettingsHost, registerSettings } from "./features/settings";
import { Shell } from "./features/shell/Shell";
import { Welcome } from "./features/welcome/Welcome";
import { startAutoFetch } from "./state/autoFetch";
import { startEvents } from "./state/events";
import { installKeymap } from "./state/keymap";
import { initSettings } from "./state/settings";
import { registerGlobalShortcuts } from "./state/shortcuts";
import { activeProject, loadWorkspace, workspace } from "./state/workspace";

export default function App(): JSX.Element {
  onMount(() => {
    initSettings();
    startEvents();
    startAutoFetch();
    registerAllDialogs();
    registerSettings();
    registerGlobalShortcuts();
    onCleanup(installKeymap());
    void loadWorkspace();
  });
  return (
    <>
      <div class="dg-app">
        <Show when={location.hash !== "#gallery"} fallback={<Gallery />}>
          <Show when={workspace.loaded}>
            <Show when={activeProject()} fallback={<Welcome />}>
              <Shell />
            </Show>
          </Show>
        </Show>
      </div>
      <SearchEverywhere />
      <MenuHost />
      <DialogHost />
      <ToastHost />
      <SettingsHost />
      <TooltipHost />
    </>
  );
}
