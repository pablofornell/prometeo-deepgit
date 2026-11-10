/**
 * Clone Repository: URL (a pasted URL fills the folder name), parent folder with a picker, folder name (derived from the
 * URL, editable), branch, shallow depth, submodules, and where to add the repo (current project / new project). The
 * dialog runs the clone itself (`actions.startClone`) and stays open to show the progress of git with a Cancel button;
 * errors show inside it so the user can fix the input and go again. The rules are in `api/cloneRules.ts` (the backend
 * and the mock apply the same ones).
 */
import { type JSX, Show, createMemo, createSignal, onMount } from "solid-js";
import { pickFolder } from "../../api/dialog";
import { checkCloneInput, checkCloneUrl, checkDirName, defaultDirName, insideProject, isAbsolutePath, joinPath, looksLikeRepoUrl } from "../../api/cloneRules";
import type { CloneProgress } from "../../api/types";
import { Button, Checkbox, Dialog, type DialogComponentProps, ProgressBar, Spinner, TextField } from "../../components/ui";
import * as actions from "../../state/actions";
import type { CloneDialogResult, CloneProps } from "../../state/dialogs";
import { loadPersisted, savePersisted } from "../../state/persist";
import { activeProject } from "../../state/workspace";
import { shellQuote } from "./command";
import { Field, Note, RadioGroup } from "./parts";

const PARENT_KEY = "cloneParentDir";

const trimSep = (p: string): string => p.replace(/(.)[\\/]+$/, "$1");

export function CloneDialog(props: CloneProps & DialogComponentProps<CloneDialogResult>): JSX.Element {
  const project = activeProject();
  const [url, setUrl] = createSignal((props.url ?? "").trim());
  const [parentDir, setParentDir] = createSignal(project?.path ?? loadPersisted<string>(PARENT_KEY, ""));
  const [dirName, setDirName] = createSignal(defaultDirName(props.url ?? "") ?? "");
  /** The user typed in the name field: stop following the URL. */
  const [nameTouched, setNameTouched] = createSignal(false);
  const [branch, setBranch] = createSignal("");
  const [depth, setDepth] = createSignal("");
  const [submodules, setSubmodules] = createSignal(false);
  const [addTo, setAddTo] = createSignal<"current" | "new">(project ? "current" : "new");

  const [running, setRunning] = createSignal(false);
  const [cancelling, setCancelling] = createSignal(false);
  const [progress, setProgress] = createSignal<CloneProgress | null>(null);
  const [failure, setFailure] = createSignal<{ message: string; detail?: string } | null>(null);
  const [cancelled, setCancelled] = createSignal(false);
  let run: actions.CloneRun | undefined;

  const changeUrl = (value: string) => {
    setUrl(value);
    if (!nameTouched()) setDirName(defaultDirName(value) ?? "");
    setFailure(null);
  };

  onMount(() => {
    // a URL on the clipboard is a good start; reading it can be refused, then the field stays empty
    if (url() === "" && typeof navigator !== "undefined" && navigator.clipboard?.readText) {
      navigator.clipboard.readText().then(
        (text) => {
          if (url() === "" && looksLikeRepoUrl(text)) changeUrl(text.trim());
        },
        () => undefined,
      );
    }
  });

  const depthValue = (): number | null => {
    const d = depth().trim();
    return d === "" ? null : /^\d+$/.test(d) ? Number(d) : Number.NaN;
  };
  const input = () => ({ url: url(), parentDir: parentDir(), dirName: dirName(), branch: branch().trim() === "" ? null : branch().trim(), depth: depthValue() });

  const urlError = createMemo(() => (url().trim() === "" ? null : checkCloneUrl(url())));
  const nameError = createMemo(() => (dirName().trim() === "" && !nameTouched() ? null : checkDirName(dirName())));
  const parentError = createMemo(() => (parentDir().trim() !== "" && !isAbsolutePath(parentDir().trim()) ? "The parent folder must be an absolute path." : null));
  const depthError = createMemo(() => (depth().trim() !== "" && Number.isNaN(depthValue()) ? "The depth is a whole number." : depthValue() === 0 ? "The depth must be at least 1." : null));
  const inputError = createMemo(() => checkCloneInput(input()));

  const canAddToCurrent = () => !!project && (parentDir().trim() === "" || insideProject(parentDir(), project.path));
  const target = (): "current" | "new" => (addTo() === "current" && canAddToCurrent() ? "current" : "new");

  const targetPath = () => (parentDir().trim() !== "" && dirName().trim() !== "" ? joinPath(trimSep(parentDir().trim()), dirName().trim()) : "<folder>");
  const command = () => {
    const i = input();
    const parts = ["git", "clone", "--progress"];
    if (i.branch) parts.push("--branch", shellQuote(i.branch));
    if (i.depth !== null && !Number.isNaN(i.depth)) parts.push("--depth", String(i.depth));
    if (submodules()) parts.push("--recurse-submodules");
    parts.push("--", url().trim() === "" ? "<url>" : shellQuote(url().trim()), shellQuote(targetPath()));
    return parts.join(" ");
  };

  const canClone = () => !running() && inputError() === null;

  const start = () => {
    if (!canClone()) return;
    const i = input();
    setFailure(null);
    setCancelled(false);
    setProgress(null);
    setCancelling(false);
    setRunning(true);
    run = actions.startClone(
      { url: i.url.trim(), parentDir: i.parentDir.trim(), dirName: i.dirName.trim(), branch: i.branch, depth: i.depth, recurseSubmodules: submodules(), addTo: target() },
      setProgress,
    );
    void run.done.then((outcome) => {
      setRunning(false);
      run = undefined;
      if (outcome.ok) {
        savePersisted(PARENT_KEY, i.parentDir.trim());
        props.close({ path: outcome.result.path, projectId: outcome.result.project.id });
      } else if (outcome.cancelled) {
        setCancelled(true);
      } else if (outcome.error) {
        setFailure({ message: outcome.error.message, detail: outcome.error.detail });
      }
    });
  };

  const close = () => {
    if (run) {
      // Esc or Cancel during a clone stops it; the dialog goes back to the form when git has stopped
      setCancelling(true);
      run.cancel();
      return;
    }
    props.close();
  };

  const browse = async () => {
    const picked = await pickFolder("Choose the parent folder");
    if (picked) setParentDir(picked);
  };

  const phaseText = () => {
    if (cancelling()) return "Cancelling…";
    const p = progress();
    if (!p) return "Connecting…";
    return p.percent === null ? p.phase : `${p.phase}: ${p.percent}%`;
  };
  /** The lines of git's error that say more than the message: no hints, no "Cloning into", no repeat of the message. */
  const details = () => {
    const f = failure();
    if (!f?.detail) return "";
    const more = f.detail.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("hint:") && !l.startsWith("Cloning into") && l !== f.message);
    return more.slice(0, 3).join(" ");
  };

  return (
    <Dialog
      title="Clone repository"
      width="wide"
      onClose={close}
      cancelLabel={running() ? "Cancel clone" : "Cancel"}
      command={command()}
      primary={{ label: running() ? "Cloning…" : "Clone", disabled: !canClone(), onClick: start }}
    >
      <Field label="Repository URL" error={urlError()}>
        <TextField
          value={url()}
          onInput={changeUrl}
          onPaste={(e) => {
            // a pasted URL is trimmed and fills the folder name; the paste itself is taken over
            const text = e.clipboardData?.getData("text") ?? "";
            if (looksLikeRepoUrl(text)) {
              e.preventDefault();
              changeUrl(text.trim());
            }
          }}
          disabled={running()}
          error={urlError() !== null}
          placeholder="https://github.com/owner/repo.git or git@host:owner/repo.git"
          aria-label="Repository URL"
          spellcheck={false}
        />
      </Field>
      <div class="dg-dialogs-fieldrow">
        <Field label="Parent folder" error={parentError()}>
          <TextField value={parentDir()} onInput={setParentDir} disabled={running()} error={parentError() !== null} placeholder="/home/you/work" aria-label="Parent folder" spellcheck={false} />
        </Field>
        <Button icon="folder" disabled={running()} onClick={() => void browse()} title="Choose the parent folder">
          Browse…
        </Button>
      </div>
      <Field label="Folder name" error={nameError()} hint={nameError() === null && parentDir().trim() !== "" && dirName().trim() !== "" ? `Clones into ${targetPath()}` : undefined}>
        <TextField
          value={dirName()}
          onInput={(v) => {
            setNameTouched(true);
            setDirName(v);
          }}
          disabled={running()}
          error={nameError() !== null}
          aria-label="Folder name"
          spellcheck={false}
        />
      </Field>
      <div class="dg-dialogs-pair">
        <Field label="Branch (optional)">
          <TextField value={branch()} onInput={setBranch} disabled={running()} placeholder="Default branch of the remote" aria-label="Branch" spellcheck={false} />
        </Field>
        <Field label="Shallow clone depth (optional)" error={depthError()}>
          <TextField value={depth()} onInput={setDepth} disabled={running()} error={depthError() !== null} placeholder="Full history" inputMode="numeric" aria-label="Shallow clone depth" />
        </Field>
      </div>
      <div class="dg-dialogs-options">
        <Checkbox checked={submodules()} onChange={setSubmodules} disabled={running()} label="Clone submodules (--recurse-submodules)" />
      </div>
      <Show when={project}>
        {(p) => (
          <>
            <RadioGroup
              name="clone-add-to"
              label="Add to"
              value={target()}
              onChange={(v) => !running() && setAddTo(v)}
              options={[
                { value: "current", label: `Current project: ${p().name}`, description: canAddToCurrent() ? "The repository joins the repositories of this project." : `Needs a parent folder inside ${p().path}.` },
                { value: "new", label: "New project", description: "A project of its own, with the cloned folder as its root." },
              ]}
            />
            <Show when={!canAddToCurrent()}>
              <Note kind="info">The parent folder is outside the project folder, so the clone becomes a new project.</Note>
            </Show>
          </>
        )}
      </Show>
      <Show when={running()}>
        <div class="dg-dialogs-clone-progress" aria-live="polite">
          <div class="dg-dialogs-clone-phase">
            <Spinner size={14} />
            <span>{phaseText()}</span>
          </div>
          <ProgressBar value={progress()?.percent ?? undefined} max={100} indeterminate={cancelling() || progress()?.percent == null} width={600} />
        </div>
      </Show>
      <Show when={failure()}>{(f) => <Note kind="error">{f().message}{details() ? ` ${details()}` : ""}</Note>}</Show>
      <Show when={cancelled() && !running()}>
        <Note kind="info">The clone was cancelled. Nothing was kept on disk.</Note>
      </Show>
    </Dialog>
  );
}
