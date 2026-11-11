/**
 * Quick open (Ctrl+P). It lists the files of every repo of the project. It ranks them with a fuzzy match on the path.
 * It uses the look of Search Everywhere (`features/palette/palette.css`). Enter opens the file.
 * Esc or a click outside the box closes it.
 */
import { type JSX, For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js";
import { Icon, RepoChip, fileIconFor, splitPath } from "../../components/ui";
import { segments } from "../palette/fuzzy";
import { rankFiles } from "./model";

export interface QuickFile {
  repoId: string;
  repoName: string;
  path: string;
}

const MAX_ROWS = 50;

/** Renders the text. The matched characters use the match colour. */
function Hl(props: { text: string; positions: number[] }): JSX.Element {
  return (
    <For each={segments(props.text, props.positions)}>
      {(s) => (s.match ? <span class="dg-palette-match">{s.text}</span> : <>{s.text}</>)}
    </For>
  );
}

export function QuickOpen(props: { files: () => QuickFile[]; multi: boolean; onPick: (f: QuickFile) => void; onClose: () => void }): JSX.Element {
  const [query, setQuery] = createSignal("");
  const [sel, setSel] = createSignal(0);
  let input: HTMLInputElement | undefined;
  let list: HTMLDivElement | undefined;

  const rows = createMemo(() => rankFiles(query(), props.files(), (f) => f.path, MAX_ROWS));

  // A new query starts at the best row.
  createEffect(() => {
    query();
    setSel(0);
    if (list) list.scrollTop = 0;
  });
  createEffect(() => {
    const i = sel();
    list?.querySelector<HTMLElement>(`[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
  });

  onMount(() => input?.focus());

  const move = (delta: number): void => {
    const n = rows().length;
    if (n === 0) return;
    setSel((sel() + delta + n) % n);
  };

  const onKey = (e: KeyboardEvent): void => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        break;
      case "Enter": {
        e.preventDefault();
        const row = rows()[sel()];
        if (row) props.onPick(row.item);
        break;
      }
      case "Escape":
        e.preventDefault();
        props.onClose();
        break;
    }
  };

  return (
    <div class="dg-palette-scrim" onMouseDown={() => props.onClose()}>
      <div
        class="dg-palette dg-fe-quick"
        role="dialog"
        aria-label="Quick open"
        onMouseDown={(e) => {
          e.stopPropagation();
          if (!(e.target instanceof HTMLInputElement)) e.preventDefault(); // keep the focus in the input
        }}
        onKeyDown={onKey}
      >
        <div class="dg-palette-input">
          <Icon name="search" size={16} class="dg-palette-input-icon" />
          <input
            ref={input}
            class="dg-palette-field"
            type="text"
            spellcheck={false}
            autocomplete="off"
            role="combobox"
            aria-expanded="true"
            aria-controls="dg-fe-quick-list"
            placeholder="Type a file name"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
        </div>
        <div class="dg-palette-results" id="dg-fe-quick-list" role="listbox" ref={list}>
          <For each={rows()}>
            {(row, i) => {
              const parts = () => splitPath(row.item.path);
              const dirLen = () => row.item.path.length - parts().name.length;
              return (
                <div
                  class="dg-palette-row"
                  classList={{ "is-active": sel() === i() }}
                  role="option"
                  aria-selected={sel() === i()}
                  data-i={i()}
                  onMouseMove={() => sel() !== i() && setSel(i())}
                  onClick={() => props.onPick(row.item)}
                >
                  <Icon name={fileIconFor(row.item.path)} class="dg-palette-icon" />
                  <Show when={props.multi}>
                    <RepoChip name={row.item.repoName} />
                  </Show>
                  <span class="dg-palette-text">
                    <Hl text={parts().name} positions={row.positions.filter((p) => p >= dirLen()).map((p) => p - dirLen())} />
                    <Show when={parts().dir}>
                      <span class="dg-palette-sub dg-palette-dir">
                        <Hl text={parts().dir} positions={row.positions.filter((p) => p < dirLen())} />
                      </span>
                    </Show>
                  </span>
                </div>
              );
            }}
          </For>
          <Show when={rows().length === 0}>
            <div class="dg-palette-empty">{query() ? `No files match “${query()}”` : "No files in this project."}</div>
          </Show>
        </div>
        <div class="dg-palette-footer">
          <span>↑↓ to move · Enter to open · Esc to close</span>
        </div>
      </div>
    </div>
  );
}
