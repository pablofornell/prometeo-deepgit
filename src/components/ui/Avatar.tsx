import type { JSX } from "solid-js";
import { fnv1a, initials } from "./util";

export interface AvatarProps {
  name: string;
  /** Colour source: FNV-1a(lowercase email) % 12 (DESIGN.md 4.1). Falls back to the name. */
  email?: string;
  /** 18 (log row, default) or 32 (details panel). Any px size works. */
  size?: number;
}

/**
 * Initials avatar; no network (DESIGN.md 5.5).
 *
 *   <Avatar name="Lucía Martín" email="lucia.martin@acme.dev" size={32} />
 */
export function Avatar(props: AvatarProps): JSX.Element {
  const size = () => props.size ?? 18;
  const color = () => `var(--dg-avatar-${fnv1a((props.email || props.name).toLowerCase()) % 12})`;
  return (
    <span
      class="dg-avatar"
      title={props.name}
      aria-hidden="true"
      style={{ width: size() + "px", height: size() + "px", background: color(), "font-size": Math.max(8, size() * 0.47) + "px" }}
    >
      {initials(props.name)}
    </span>
  );
}
