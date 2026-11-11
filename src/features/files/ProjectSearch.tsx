/**
 * The "Search" tab of the Files view. It searches every repo of the project with `search_files`.
 * The hits are grouped by file. Enter or a click calls `onOpen`. The view then opens the file and selects the match.
 */
import { type JSX, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import * as api from "../../api/tauri";
import type { RepoInfo, SearchHit } from "../../api/types";
import { Badge, Icon, RepoChip, TextField, VirtualList, type VirtualListApi, fileIconFor, plural, splitPath, tip } from "../../components/ui";
import { cssPx } from "../../state/metrics";
import { projectRepos } from "../../state/workspace";
import { errorText, groupHits, matchRange } from "./model";

/** Lets the view focus the input and set its text. */
export interface SearchApi {
  focus(prefill?: string): void;
}

/** A hit that the user chose, with the query that found it. */
export interface SearchOpen {
  repoId: string;
  path: string;
  hit: SearchHit;
  query: string;
  caseSensitive: boolean;
  regex: boolean;
}

const DEBOUNCE_MS = 250;

interface Group {
  repoId: string;
  repoName: string;
  path: string;
  hits: SearchHit[];
}

interface Results {
  query: string;
  caseSensitive: boolean;
  regex: boolean;
  groups: Group[];
  total: number;
  truncated: boolean;
  error: string | null;
}

type Row = { t: "file"; group: Group } | { t: "hit"; group: Group; hit: SearchHit };

/** Searches every repo. A repo that fails gives an error. The other repos still return their hits. */
async function runSearch(query: string, caseSensitive: boolean, regex: boolean, repos: RepoInfo[]): Promise<Results> {
  const outs = await Promise.all(
    repos.map(async (r) => {
      try {
        return { repo: r, res: await api.searchFiles(r.id, query, { caseSensitive, regex }), error: null };
      } catch (e) {
        return { repo: r, res: null, error: errorText(e) };
      }
    }),
  );
  const groups: Group[] = [];
  let total = 0;
  let truncated = false;
  let error: string | null = null;
  for (const o of outs) {
    if (!o.res) {
      if (error === null) error = o.error;
      continue;
    }
    total += o.res.hits.length;
    if (o.res.truncated) truncated = true;
    for (const g of groupHits(o.res.hits)) groups.push({ repoId: o.repo.id, repoName: o.repo.name, path: g.path, hits: g.hits });
  }
  return { query, caseSensitive, regex, groups, total, truncated, error };
}

export function ProjectSearch(props: { onOpen: (o: SearchOpen) => void; apiRef: (api: SearchApi) => void }): JSX.Element {
  const [query, setQuery] = createSignal("");
  const [caseSensitive, setCaseSensitive] = createSignal(false);
  const [regex, setRegex] = createSignal(false);
  const [results, setResults] = createSignal<Results | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [sel, setSel] = createSignal(0);
  let input: HTMLInputElement | undefined;
  let list: VirtualListApi | undefined;
  // `seq` numbers the requests. An answer to an older request is dropped.
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = async (my: number): Promise<void> => {
    const q = query();
    const cs = caseSensitive();
    const rx = regex();
    if (q === "") {
      setResults(null);
      setBusy(false);
      return;
    }
    setBusy(true);
    const out = await runSearch(q, cs, rx, projectRepos());
    if (my !== seq) return;
    setResults(out);
    setBusy(false);
    setSel(0);
  };

  // A change of the text or the options starts a new request after a short pause. This makes older requests stale.
  const schedule = (): void => {
    clearTimeout(timer);
    const my = ++seq;
    timer = setTimeout(() => void run(my), DEBOUNCE_MS);
  };
  const runNow = (): void => {
    clearTimeout(timer);
    void run(++seq);
  };
  createEffect(on([query, caseSensitive, regex], schedule, { defer: true }));
  onCleanup(() => {
    clearTimeout(timer);
    seq++;
  });

  props.apiRef({
    focus(prefill) {
      if (prefill !== undefined) setQuery(prefill);
      queueMicrotask(() => {
        input?.focus();
        input?.select();
      });
    },
  });

  const rows = createMemo<Row[]>(() => {
    const r = results();
    if (!r) return [];
    const out: Row[] = [];
    for (const group of r.groups) {
      out.push({ t: "file", group });
      for (const hit of group.hits) out.push({ t: "hit", group, hit });
    }
    return out;
  });

  const multi = () => projectRepos().length > 1;

  const openRow = (row: Row): void => {
    const r = results();
    if (!r) return;
    const hit = row.t === "hit" ? row.hit : row.group.hits[0];
    props.onOpen({ repoId: row.group.repoId, path: row.group.path, hit, query: r.query, caseSensitive: r.caseSensitive, regex: r.regex });
  };

  const summary = (): { text: string; error: boolean } | null => {
    const r = results();
    if (busy()) return { text: "Searching…", error: false };
    if (!r || query() === "") return null;
    if (r.error) return { text: r.error, error: true };
    if (r.total === 0) return { text: "No results", error: false };
    const text = `${plural(r.total, "result")} in ${plural(r.groups.length, "file")}` + (r.truncated ? ". Showing the first 2 000 results." : "");
    return { text, error: false };
  };

  const onInputKey = (e: KeyboardEvent): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      runNow();
    } else if (e.key === "ArrowDown" && rows().length > 0) {
      e.preventDefault();
      list?.focus();
    }
  };

  const onListKey = (e: KeyboardEvent): void => {
    if (e.key !== "Enter") return;
    const row = rows()[sel()];
    if (!row) return;
    e.preventDefault();
    openRow(row);
  };

  const rowHeight = cssPx("--dg-tree-row-height", 24);

  const renderRow = (i: number): JSX.Element => (
    <Show when={rows()[i]}>
      {(row) => {
        const pick = () => {
          setSel(i);
          openRow(row());
        };
        return row().t === "file" ? (
          <FileRow group={(row() as Extract<Row, { t: "file" }>).group} multi={multi()} selected={sel() === i} onPick={pick} />
        ) : (
          <HitRow
            hit={(row() as Extract<Row, { t: "hit" }>).hit}
            query={results()?.query ?? ""}
            caseSensitive={results()?.caseSensitive ?? false}
            regex={results()?.regex ?? false}
            selected={sel() === i}
            onPick={pick}
          />
        );
      }}
    </Show>
  );

  return (
    <div class="dg-fe-search">
      <div class="dg-fe-search-bar">
        <TextField
          value={query()}
          onInput={(v) => setQuery(v)}
          placeholder="Search in the project"
          inputRef={(el) => (input = el)}
          onKeyDown={onInputKey}
          spellcheck={false}
          leading={<Icon name="search" size={14} class="dg-field-icon" />}
          trailing={
            <>
              <button type="button" class="dg-fe-toggle" classList={{ "is-on": caseSensitive() }} aria-pressed={caseSensitive()} aria-label="Match case" {...tip("Match case")} onClick={() => setCaseSensitive(!caseSensitive())}>
                Aa
              </button>
              <button type="button" class="dg-fe-toggle" classList={{ "is-on": regex() }} aria-pressed={regex()} aria-label="Regular expression" {...tip("Regular expression")} onClick={() => setRegex(!regex())}>
                .*
              </button>
            </>
          }
        />
      </div>
      <Show when={summary()}>
        {(s) => (
          <div class="dg-fe-status" classList={{ "is-error": s().error }} role="status">
            {s().text}
          </div>
        )}
      </Show>
      <VirtualList
        class="dg-fe-list"
        role="listbox"
        ariaLabel="Search results"
        count={rows().length}
        rowHeight={rowHeight}
        selectedIndex={sel()}
        onSelect={setSel}
        onKeyDown={onListKey}
        apiRef={(a) => (list = a)}
        renderRow={renderRow}
      />
    </div>
  );
}

/** One matching line. It shows the line number and the text. The match uses the accent colour. */
function HitRow(props: { hit: SearchHit; query: string; caseSensitive: boolean; regex: boolean; selected: boolean; onPick: () => void }): JSX.Element {
  const parts = () => {
    const m = matchRange(props.hit.text, props.hit.column, props.query, { caseSensitive: props.caseSensitive, regex: props.regex });
    return { before: props.hit.text.slice(0, m.from), match: props.hit.text.slice(m.from, m.to), after: props.hit.text.slice(m.to) };
  };
  return (
    <div class="dg-fe-row dg-fe-hit" classList={{ "is-sel": props.selected }} role="option" aria-selected={props.selected} onClick={() => props.onPick()}>
      <span class="dg-fe-line">{props.hit.line}</span>
      <span class="dg-fe-text">
        {parts().before}
        <Show when={parts().match}>
          <span class="dg-fe-match">{parts().match}</span>
        </Show>
        {parts().after}
      </span>
    </div>
  );
}

/** A file in the results. It shows the icon, the name, the folder and the hit count. A click opens its first hit. */
function FileRow(props: { group: Group; multi: boolean; selected: boolean; onPick: () => void }): JSX.Element {
  const parts = () => splitPath(props.group.path);
  return (
    <div class="dg-fe-row dg-fe-group" classList={{ "is-sel": props.selected }} role="option" aria-selected={props.selected} onClick={() => props.onPick()}>
      <Icon name={fileIconFor(props.group.path)} size={16} class="dg-fe-ficon" />
      <span class="dg-fe-fname" title={props.group.path}>
        {parts().name}
      </span>
      <Show when={parts().dir}>
        <span class="dg-fe-fdir" title={props.group.path}>
          {parts().dir.replace(/\/$/, "")}
        </span>
      </Show>
      <span class="dg-fe-grow" />
      <Show when={props.multi}>
        <RepoChip name={props.group.repoName} />
      </Show>
      <Badge>{props.group.hits.length}</Badge>
    </div>
  );
}
