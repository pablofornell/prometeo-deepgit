/* @refresh reload */
import { render } from "solid-js/web";
import "./theme/fonts.css";
import "./theme/tokens.css";
import "./theme/extra.css";
import "./styles/global.css";
import App from "./App";

render(() => <App />, document.getElementById("root") as HTMLElement);

// Dev only: `__deepgit.actions.checkout(...)` etc. from the browser console / Playwright scripts.
if (import.meta.env.DEV) {
  void Promise.all([import("./state/actions"), import("./state/workspace"), import("./state/selection"), import("./state/settings"), import("./state/layout"), import("./api/tauri")]).then(
    ([actions, workspace, selection, settings, layout, api]) => {
      Object.assign(window, { __deepgit: { actions, workspace, selection, settings, layout, api } });
    },
  );
}
