/**
 * Content hash of a hunk, sent with the hunk commands so the backend can refuse when the hunk changed under the user.
 * Contract with the Rust side: FNV-1a 32-bit over the UTF-8 bytes of, for each line in order,
 * kind char (`' '` context, `'+'` add, `'-'` del) + text + "\n"; 8 lowercase hex chars, zero padded.
 */
import type { DiffLine } from "../../api/types";

const KIND_CHAR: Record<DiffLine["kind"], string> = { context: " ", add: "+", del: "-" };
const encoder = new TextEncoder();

export function hunkHash(lines: readonly Pick<DiffLine, "kind" | "text">[]): string {
  let h = 0x811c9dc5;
  for (const line of lines) {
    for (const b of encoder.encode(KIND_CHAR[line.kind] + line.text + "\n")) {
      h ^= b;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
