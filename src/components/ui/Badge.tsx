import type { JSX } from "solid-js";

export interface BadgeProps {
  children: JSX.Element;
  /** neutral (default), accent, success, warning, error. */
  tone?: "neutral" | "accent" | "success" | "warning" | "error";
  title?: string;
}

/**
 * Small counter capsule (16 px high, tabular numbers): file counts, "+3", tab counters.
 *
 *   <Badge>14</Badge>    <Badge tone="error">2 conflicts</Badge>
 */
export function Badge(props: BadgeProps): JSX.Element {
  return (
    <span class={`dg-badge dg-badge-${props.tone ?? "neutral"}`} title={props.title}>
      {props.children}
    </span>
  );
}

export interface PillProps {
  children: JSX.Element;
  /** Outlined label such as "gone" or "HEAD"; `head` is the filled blue HEAD pill. */
  tone?: "outline" | "head";
  title?: string;
}

/**
 * Small rectangular label (radius 4): "gone", "HEAD". For branch/tag labels of commits use `RefPill`.
 *
 *   <Pill>gone</Pill>
 */
export function Pill(props: PillProps): JSX.Element {
  return (
    <span class={`dg-pill dg-pill-${props.tone ?? "outline"}`} title={props.title}>
      {props.children}
    </span>
  );
}
