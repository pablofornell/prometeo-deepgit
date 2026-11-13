/**
 * The find and replace widget of the file editor. It floats at the top right of the editor, over the text.
 *
 * `@codemirror/search` keeps the query, finds the matches and highlights them. This module only supplies the panel
 * (`search({ createPanel })`) and the key bindings. The panel is a small Solid component rendered into the panel DOM.
 * The query and the three options stay for the session, for all tabs: `session` holds them, and a new panel starts from it.
 */
import {
  SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery, openSearchPanel, replaceAll, replaceNext, search, searchPanelOpen,
  setSearchQuery,
} from "@codemirror/search";
import { EditorSelection, type Extension } from "@codemirror/state";
import { type KeyBinding, type Panel, EditorView, type ViewUpdate, runScopeHandlers } from "@codemirror/view";
import { createMemo, createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import { Icon, IconButton, tip } from "../../../components/ui";
import { type FindOptions, counterText, firstMatchFrom, isErrorState, matchStats, seedText, withQuery } from "./logic";
import "./find.css";

/** The last query of the session (text, replacement and the three options). A new tab and a new panel start from it. */
let session: SearchQuery = new SearchQuery({ search: "" });

/** What the commands need from the open panel of a view. */
interface Controller {
  /** Focus and select the find input, or expand the widget and focus the replace input. */
  show(replace: boolean): void;
}
const controllers = new WeakMap<EditorView, Controller>();

/** Sets the query of the view and the session. `seek` selects the first match from the cursor, like an incremental find. */
function commitQuery(view: EditorView, spec: SearchQuery, seek: boolean): void {
  session = spec;
  if (!getSearchQuery(view.state).eq(spec)) view.dispatch({ effects: setSearchQuery.of(spec) });
  if (!seek) return;
  const { from, to } = view.state.selection.main;
  const m = firstMatchFrom(view.state, spec, from);
  if (!m || (m.from === from && m.to === to)) return;
  const range = EditorSelection.range(m.from, m.to);
  view.dispatch({ selection: EditorSelection.create([range]), effects: EditorView.scrollIntoView(range), userEvent: "select.search" });
}

/**
 * Opens the widget (Ctrl+F collapsed, Ctrl+H expanded). A one-line selection becomes the text to find,
 * the session query is used otherwise. It focuses the find input, or the replace input for Ctrl+H.
 */
export function openFind(view: EditorView, replace = false): boolean {
  const seed = seedText(view.state, session.regexp);
  const spec = seed === null ? session : withQuery(session, { search: seed });
  session = spec;
  openSearchPanel(view);
  commitQuery(view, spec, false);
  controllers.get(view)?.show(replace);
  return true;
}

/** Toggle command for one of the options. It opens the widget when it is closed. */
function toggleOption(key: keyof FindOptions) {
  return (view: EditorView): boolean => {
    if (!searchPanelOpen(view.state)) openFind(view);
    const spec = getSearchQuery(view.state);
    commitQuery(view, withQuery(spec, { [key]: !spec[key] }), true);
    return true;
  };
}

const SCOPE = "editor search-panel";

/** Key bindings of the widget. They replace `Mod-f`, `F3` and `Escape` of the default `searchKeymap`. */
export const findKeymap: KeyBinding[] = [
  { key: "Mod-f", run: (v) => openFind(v, false), scope: SCOPE, preventDefault: true },
  { key: "Mod-h", run: (v) => openFind(v, true), scope: SCOPE, preventDefault: true },
  { key: "F3", run: findNext, shift: findPrevious, scope: SCOPE, preventDefault: true },
  { key: "Mod-g", run: findNext, shift: findPrevious, scope: SCOPE, preventDefault: true },
  { key: "Escape", run: closeSearchPanel, scope: SCOPE },
  { key: "Alt-c", run: toggleOption("caseSensitive"), scope: SCOPE, preventDefault: true },
  { key: "Alt-w", run: toggleOption("wholeWord"), scope: SCOPE, preventDefault: true },
  { key: "Alt-r", run: toggleOption("regexp"), scope: SCOPE, preventDefault: true },
  { key: "Mod-Alt-Enter", run: replaceAll, scope: "search-panel", preventDefault: true },
];

/** The search engine of the editor, with the widget as its panel. Add `findKeymap` to the key bindings as well. */
export function findExtension(): Extension {
  return search({ createPanel: createFindPanel });
}

function createFindPanel(view: EditorView): Panel {
  const dom = document.createElement("div");
  dom.className = "dg-fe-find-host";

  const [spec, setSpec] = createSignal(getSearchQuery(view.state), { equals: (a, b) => a.eq(b) });
  const [stats, setStats] = createSignal(matchStats(view.state, spec()));
  const [expanded, setExpanded] = createSignal(false);
  const [readOnly, setReadOnly] = createSignal(view.state.readOnly);
  const text = createMemo(() => counterText(stats()));
  const bad = createMemo(() => isErrorState(stats()));
  const canReplace = () => !readOnly() && stats().kind === "some";
  let findInput!: HTMLInputElement;
  let replaceInput: HTMLInputElement | undefined;

  const setOption = (key: keyof FindOptions) => commitQuery(view, withQuery(spec(), { [key]: !spec()[key] }), true);
  const toggle = (key: keyof FindOptions, label: string, tipText: string, shortcut: string, content: string, extra = "") => (
    <button
      type="button"
      class={`dg-fe-find-opt${extra}`}
      classList={{ "is-on": spec()[key] }}
      aria-pressed={spec()[key]}
      aria-label={label}
      {...tip(tipText, shortcut)}
      onClick={() => setOption(key)}
    >
      {content}
    </button>
  );

  const controller: Controller = {
    show(replace) {
      if (replace && !readOnly()) {
        setExpanded(true);
        replaceInput?.focus();
        replaceInput?.select();
      } else {
        findInput.focus();
        findInput.select();
      }
    },
  };
  controllers.set(view, controller);

  const dispose = render(
    () => (
      <div class="dg-fe-find" classList={{ "is-expanded": expanded() && !readOnly() }} role="search">
        <Show when={!readOnly()} fallback={<span class="dg-fe-find-expand is-hidden" />}>
          <button
            type="button"
            class="dg-fe-find-expand"
            classList={{ "is-on": expanded() }}
            aria-expanded={expanded()}
            aria-label="Toggle replace"
            {...tip("Toggle replace", "Ctrl+H")}
            onClick={() => setExpanded(!expanded())}
          >
            <Icon name="chevronRight" size={14} />
          </button>
        </Show>
        <div class="dg-fe-find-rows">
          <div class="dg-fe-find-row">
            <div class="dg-fe-find-field">
              <input
                ref={findInput}
                main-field="true"
                class="dg-fe-find-input"
                classList={{ "is-error": bad() }}
                type="text"
                name="search"
                placeholder="Find"
                aria-label="Find"
                spellcheck={false}
                autocomplete="off"
                value={spec().search}
                onInput={(e) => commitQuery(view, withQuery(spec(), { search: e.currentTarget.value }), true)}
              />
              <div class="dg-fe-find-opts">
                {toggle("caseSensitive", "Match case", "Match case", "Alt+C", "Aa")}
                {toggle("wholeWord", "Match whole word", "Match whole word", "Alt+W", "ab", " is-word")}
                {toggle("regexp", "Use regular expression", "Use regular expression", "Alt+R", ".*")}
              </div>
            </div>
            <span class="dg-fe-find-count" classList={{ "is-error": bad() }} role="status" aria-live="polite">{text()}</span>
            <IconButton icon="arrowUp" label="Previous match" shortcut="Shift+Enter" onClick={() => findPrevious(view)} />
            <IconButton icon="arrowDown" label="Next match" shortcut="Enter" onClick={() => findNext(view)} />
            <IconButton icon="close" label="Close" shortcut="Escape" onClick={() => closeSearchPanel(view)} />
          </div>
          <Show when={expanded() && !readOnly()}>
            <div class="dg-fe-find-row">
              <div class="dg-fe-find-field">
                <input
                  ref={replaceInput}
                  class="dg-fe-find-input is-plain"
                  type="text"
                  name="replace"
                  placeholder="Replace"
                  aria-label="Replace"
                  spellcheck={false}
                  autocomplete="off"
                  value={spec().replace}
                  onInput={(e) => commitQuery(view, withQuery(spec(), { replace: e.currentTarget.value }), false)}
                />
              </div>
              <IconButton icon="replace" label="Replace" shortcut="Enter" disabled={!canReplace()} onClick={() => replaceNext(view)} />
              <IconButton icon="replaceAll" label="Replace all" shortcut="Ctrl+Alt+Enter" disabled={!canReplace()} onClick={() => replaceAll(view)} />
            </div>
          </Show>
        </div>
      </div>
    ),
    dom,
  );

  dom.addEventListener("keydown", (e) => {
    if (runScopeHandlers(view, e, "search-panel")) {
      e.preventDefault();
    } else if (e.key === "Enter" && !e.isComposing) {
      if (e.target === findInput) {
        e.preventDefault();
        (e.shiftKey ? findPrevious : findNext)(view);
      } else if (e.target === replaceInput) {
        e.preventDefault();
        replaceNext(view);
      }
    }
  });

  // A tab that was swapped in may hold an older query: the session query wins. It cannot dispatch while the view updates.
  queueMicrotask(() => {
    if (controllers.get(view) === controller && !session.eq(getSearchQuery(view.state))) {
      view.dispatch({ effects: setSearchQuery.of(session) });
    }
  });

  return {
    dom,
    top: true,
    update(u: ViewUpdate) {
      const q = getSearchQuery(u.state);
      const changed = !q.eq(getSearchQuery(u.startState));
      if (changed) {
        session = q;
        setSpec(q);
      }
      if (changed || u.docChanged || u.selectionSet) setStats(matchStats(u.state, q));
      setReadOnly(u.state.readOnly);
    },
    destroy() {
      if (controllers.get(view) === controller) controllers.delete(view);
      dispose();
    },
  };
}
