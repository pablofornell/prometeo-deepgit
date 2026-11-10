import { type JSX, Show } from "solid-js";
import { Icon } from "./Icon";
import type { IconName } from "./icons";

export interface EmptyStateProps {
  icon?: IconName;
  /** Heading, 16/600. */
  title: string;
  /** Body: 1 or 2 lines of muted text. */
  children?: JSX.Element;
  /** Buttons / links under the text. */
  actions?: JSX.Element;
}

/**
 * Centered empty state (DESIGN.md 9.1), max width 360.
 *
 *   <EmptyState icon="log" title="Select a commit" actions={<Button variant="primary">Fetch</Button>}>
 *     Its message, files and diff appear here.
 *   </EmptyState>
 */
export function EmptyState(props: EmptyStateProps): JSX.Element {
  return (
    <div class="dg-empty">
      <div class="dg-empty-inner">
        <Show when={props.icon}>{(i) => <Icon name={i()} size={48} class="dg-empty-icon" />}</Show>
        <h3 class="dg-empty-title">{props.title}</h3>
        <Show when={props.children}>
          <p class="dg-empty-body">{props.children}</p>
        </Show>
        <Show when={props.actions}>
          <div class="dg-empty-actions">{props.actions}</div>
        </Show>
      </div>
    </div>
  );
}
