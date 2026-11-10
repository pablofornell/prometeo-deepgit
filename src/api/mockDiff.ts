/**
 * Fake file contents and a real line diff for the browser mock.
 * A "template" is a list of segments; a segment is either a plain block (kept by both versions)
 * or an `[old, new]` alternative. A seed picks which alternatives are active, so the same path
 * gets different (but valid, multi-hunk) diffs in different commits.
 */
import type { DiffLine, FileChange, FileDiff, Hunk } from "./types";

type Seg = string | [string, string];

const RUST: Seg[] = [
  `use axum::{extract::State, http::HeaderMap, Json};
use serde::{Deserialize, Serialize};

use crate::error::ApiError;
use crate::ledger::LedgerClient;
use crate::state::AppState;
`,
  [
    `use crate::refunds::policy::RefundPolicy;
`,
    `use crate::refunds::idempotency::IdempotencyKey;
use crate::refunds::policy::RefundPolicy;
`,
  ],
  `
#[derive(Debug, Deserialize)]
pub struct CreateRefundRequest {
    pub payment_id: String,
    pub amount: i64,
    pub reason: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RefundResponse {
    pub id: String,
    pub status: RefundStatus,
    pub amount: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RefundStatus {
    Pending,
    Succeeded,
    Failed,
}

pub struct RefundController;

impl RefundController {
`,
  [
    `    pub async fn create_refund(
        State(app): State<AppState>,
        Json(req): Json<CreateRefundRequest>,
    ) -> Result<Json<RefundResponse>, ApiError> {
`,
    `    pub async fn create_refund(
        State(app): State<AppState>,
        headers: HeaderMap,
        Json(req): Json<CreateRefundRequest>,
    ) -> Result<Json<RefundResponse>, ApiError> {
        let key = IdempotencyKey::from_headers(&headers)?;
        if let Some(cached) = app.idempotency.get(&key).await? {
            return Ok(Json(cached));
        }
`,
  ],
  `        let payment = app.payments.find(req.payment_id.as_str()).await?;
`,
  [
    `        if payment.captured < req.amount {
            return Err(ApiError::bad_request("amount exceeds capture"));
        }
`,
    `        if !payment.refundable() || payment.refundable_balance() < req.amount {
            return Err(ApiError::bad_request("amount exceeds refundable balance"));
        }
`,
  ],
  `
        let policy = RefundPolicy::for_merchant(&payment.merchant_id);
        policy.check(&payment, req.amount)?;

        let entry = LedgerClient::new(&app.config.ledger_url)
`,
  [
    `            .post_entry(&payment, req.amount)
            .await
            .map_err(ApiError::from)?;
`,
    `            .post_entry(&payment, req.amount, key.as_str())
            .await
            .map_err(|e| ApiError::upstream("ledger", e))?;
`,
  ],
  `
        let refund = app.refunds.insert(&payment, req.amount, entry.id).await?;
`,
  [
    `        Ok(Json(RefundResponse {
            id: refund.id,
            status: RefundStatus::Pending,
            amount: refund.amount,
        }))
`,
    `        let response = RefundResponse {
            id: refund.id,
            status: RefundStatus::Pending,
            amount: refund.amount,
        };
        app.idempotency.put(&key, &response, 24 * 3600).await?;
        Ok(Json(response))
`,
  ],
  `    }
`,
  [
    `
    pub async fn list_refunds(State(app): State<AppState>) -> Result<Json<Vec<RefundResponse>>, ApiError> {
        let rows = app.refunds.recent(50).await?;
        Ok(Json(rows.into_iter().map(Into::into).collect()))
    }
`,
    `
    pub async fn list_refunds(
        State(app): State<AppState>,
        Query(page): Query<Page>,
    ) -> Result<Json<Vec<RefundResponse>>, ApiError> {
        let rows = app.refunds.page(page.cursor.as_deref(), page.limit.min(100)).await?;
        Ok(Json(rows.into_iter().map(Into::into).collect()))
    }
`,
  ],
  `}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refund_status_serializes_as_snake_case() {
        let json = serde_json::to_string(&RefundStatus::Succeeded).unwrap();
        assert_eq!(json, "\\"succeeded\\"");
    }
`,
  [
    `}
`,
    `
    #[tokio::test]
    async fn replays_cached_response_for_same_key() {
        let app = AppState::for_tests().await;
        let first = create(&app, "k-1", 500).await.unwrap();
        let second = create(&app, "k-1", 500).await.unwrap();
        assert_eq!(first.0.id, second.0.id);
    }
}
`,
  ],
];

const TS: Seg[] = [
  `import { createSignal, onCleanup } from "solid-js";
import type { Cart, CartItem, Money } from "../types";
`,
  [
    `import { formatMoney } from "../lib/money";
`,
    `import { formatMoney, sumMoney } from "../lib/money";
import { track } from "../lib/analytics";
`,
  ],
  `
export interface CheckoutState {
  cart: Cart;
  status: "idle" | "submitting" | "paid" | "failed";
  error?: string;
}

export function createCheckout(cart: Cart) {
  const [state, setState] = createSignal<CheckoutState>({ cart, status: "idle" });
`,
  [
    `  const total = () => state().cart.items.reduce((sum, i) => sum + i.price * i.qty, 0);
`,
    `  const total = (): Money => sumMoney(state().cart.items.map((i) => ({ amount: i.price * i.qty, currency: i.currency })));
  const itemCount = () => state().cart.items.reduce((n, i) => n + i.qty, 0);
`,
  ],
  `
  async function submit(token: string) {
    setState((s) => ({ ...s, status: "submitting" }));
`,
  [
    `    try {
      const res = await fetch("/v1/payments", { method: "POST", body: JSON.stringify({ token }) });
      if (!res.ok) throw new Error("payment failed");
      setState((s) => ({ ...s, status: "paid" }));
    } catch (e) {
      setState((s) => ({ ...s, status: "failed", error: String(e) }));
    }
`,
    `    const controller = new AbortController();
    onCleanup(() => controller.abort());
    try {
      const res = await fetch("/v1/payments", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ token, amount: total() }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(\`payment failed (\${res.status})\`);
      track("checkout_paid", { items: itemCount() });
      setState((s) => ({ ...s, status: "paid" }));
    } catch (e) {
      if (controller.signal.aborted) return;
      setState((s) => ({ ...s, status: "failed", error: e instanceof Error ? e.message : String(e) }));
    }
`,
  ],
  `  }
`,
  `
  function removeItem(id: CartItem["id"]) {
`,
  [
    `    setState((s) => ({ ...s, cart: { ...s.cart, items: s.cart.items.filter((i) => i.id !== id) } }));
`,
    `    setState((s) => ({
      ...s,
      cart: { ...s.cart, items: s.cart.items.filter((i) => i.id !== id) },
      status: "idle",
      error: undefined,
    }));
`,
  ],
  `  }

  return { state, total, submit, removeItem };
}
`,
  [
    `
export const defaultCurrency = "EUR";
`,
    `
export const defaultCurrency = "EUR";
export const maxItemsPerOrder = 50;
`,
  ],
];

const SQL: Seg[] = [
  `-- Refunds and their idempotency keys.
CREATE TABLE refunds (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id  uuid NOT NULL REFERENCES payments (id),
    amount      bigint NOT NULL CHECK (amount > 0),
`,
  [
    `    created_at  timestamptz NOT NULL DEFAULT now()
);
`,
    `    status      text NOT NULL DEFAULT 'pending',
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX refunds_payment_key_idx ON refunds (payment_id, idempotency_key);
`,
  ],
  `
CREATE INDEX refunds_payment_id_idx ON refunds (payment_id);
`,
  [``, `CREATE INDEX refunds_created_at_idx ON refunds (created_at DESC);
`],
];

const TOML: Seg[] = [
  `[package]
name = "api-gateway"
version = "0.14.0"
edition = "2021"

[dependencies]
axum = "0.7"
`,
  [`tokio = { version = "1", features = ["full"] }
`, `tokio = { version = "1", features = ["rt-multi-thread", "macros", "signal"] }
tower-http = { version = "0.6", features = ["trace", "cors"] }
`],
  `serde = { version = "1", features = ["derive"] }
sqlx = { version = "0.8", features = ["postgres", "uuid", "time"] }
`,
  [`tracing = "0.1"
`, `tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter", "json"] }
`],
];

const MD: Seg[] = [
  `# Refunds API

Create and inspect refunds for captured payments.
`,
  [`
## Create a refund

\`POST /v1/refunds\` with the payment id and the amount.
`, `
## Create a refund

\`POST /v1/refunds\` with the payment id and the amount in minor units.
Send an \`Idempotency-Key\` header: retries with the same key return the first response for 24 hours.
`],
  `
## Errors

Errors use the problem+json format.
`,
  [``, `
| Status | Meaning |
|---|---|
| 400 | amount exceeds the refundable balance |
| 409 | a request with this idempotency key is still running |
`],
];

const JSON_T: Seg[] = [
  `{
  "name": "web-checkout",
  "version": "2.8.0",
  "scripts": {
    "dev": "vite",
`,
  [`    "build": "tsc && vite build"
`, `    "build": "tsc && vite build",
    "test": "vitest run",
    "lint": "eslint src"
`],
  `  },
  "dependencies": {
`,
  [`    "solid-js": "^1.8.0"
`, `    "solid-js": "^1.9.0",
    "zod": "^3.23.0"
`],
  `  }
}
`,
];

const YAML: Seg[] = [
  `name: ci
on:
  push:
    branches: [main]
  pull_request:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`,
  [`      - run: cargo test
`, `      - uses: Swatinem/rust-cache@v2
      - run: cargo test --workspace
      - run: cargo clippy --workspace -- -D warnings
`],
];

const PROTO: Seg[] = [
  `syntax = "proto3";

package acme.ledger.v1;

message PostEntryRequest {
  string payment_id = 1;
  int64 amount = 2;
`,
  [`}
`, `  string idempotency_key = 3;
  map<string, string> metadata = 4;
}
`],
  `
message PostEntryResponse {
  string entry_id = 1;
}
`,
];

const TEXT: Seg[] = [
  `Notes
=====

- keep the retry budget small
`,
  [`- log the request id
`, `- log the request id and the merchant id
- never log card data
`],
];

/** A long lock file (~4 000 lines) so the viewer's virtualization can be exercised in the browser (`*.lock` paths). */
const LOCK: Seg[] = Array.from({ length: 600 }, (_, i): Seg => {
  const name = `crate-${i}`;
  const block = (v: string) => `[[package]]\nname = "${name}"\nversion = "${v}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${(i * 2654435761 >>> 0).toString(16).padStart(8, "0").repeat(8)}"\ndependencies = [\n "serde",\n]\n\n`;
  return i % 9 === 4 ? [block(`1.${i % 7}.0`), block(`1.${i % 7}.${1 + (i % 3)}`)] : block(`1.${i % 7}.0`);
});

function templateFor(path: string): Seg[] {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "rs":
      return RUST;
    case "ts":
    case "tsx":
    case "js":
      return TS;
    case "sql":
      return SQL;
    case "toml":
      return TOML;
    case "md":
      return MD;
    case "json":
      return JSON_T;
    case "yml":
    case "yaml":
      return YAML;
    case "proto":
      return PROTO;
    case "lock":
      return LOCK;
    default:
      return TEXT;
  }
}

/** Small deterministic hash used to choose which alternatives are active. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export interface FileVersions {
  oldLines: string[];
  newLines: string[];
}

/**
 * Old and new content of `path`. `modified` activates a seed-chosen subset (at least one) of the
 * alternatives; `added` has no old side; `deleted` has no new side.
 */
export function fileVersions(path: string, seed: string, status: "added" | "modified" | "deleted"): FileVersions {
  const tpl = templateFor(path);
  const alts: number[] = [];
  tpl.forEach((s, i) => {
    if (typeof s !== "string") alts.push(i);
  });
  const h = hash(seed + "|" + path);
  const active = new Set<number>();
  alts.forEach((idx, n) => {
    if (((h >>> n) & 1) === 1 || ((h >>> (n + 7)) & 3) === 0) active.add(idx);
  });
  if (active.size === 0 && alts.length > 0) active.add(alts[h % alts.length]);
  const oldText = tpl.map((s) => (typeof s === "string" ? s : s[0])).join("");
  const fullNew = tpl.map((s) => (typeof s === "string" ? s : s[1])).join("");
  const partNew = tpl.map((s, i) => (typeof s === "string" ? s : active.has(i) ? s[1] : s[0])).join("");
  if (status === "added") return { oldLines: [], newLines: splitLines(fullNew) };
  if (status === "deleted") return { oldLines: splitLines(oldText), newLines: [] };
  return { oldLines: splitLines(oldText), newLines: splitLines(partNew) };
}

interface Op {
  kind: "context" | "add" | "del";
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

/** Line diff by longest common subsequence (inputs are small). */
function diffOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "context", text: a[i], oldNo: i + 1, newNo: j + 1 });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      ops.push({ kind: "del", text: a[i], oldNo: i + 1, newNo: null });
      i++;
    } else {
      ops.push({ kind: "add", text: b[j], oldNo: null, newNo: j + 1 });
      j++;
    }
  }
  while (i < n) {
    ops.push({ kind: "del", text: a[i], oldNo: i + 1, newNo: null });
    i++;
  }
  while (j < m) {
    ops.push({ kind: "add", text: b[j], oldNo: null, newNo: j + 1 });
    j++;
  }
  return ops;
}

const HEADER_RE = /^\s*(pub\s+)?(async\s+)?(fn|impl|struct|enum|mod|export|function|class|const|message|CREATE)\b/;

/** Groups the diff into hunks with `context` unchanged lines around each change (like `git diff -U<context>`). */
export function buildHunks(a: string[], b: string[], context: number): Hunk[] {
  const ops = diffOps(a, b);
  const changes: number[] = [];
  ops.forEach((o, i) => {
    if (o.kind !== "context") changes.push(i);
  });
  const groups: { first: number; last: number }[] = [];
  for (const ci of changes) {
    const g = groups[groups.length - 1];
    if (g && ci - g.last - 1 <= 2 * context) g.last = ci;
    else groups.push({ first: ci, last: ci });
  }
  const hunks: Hunk[] = [];
  for (const g of groups) {
    const from = Math.max(0, g.first - context);
    const to = Math.min(ops.length, g.last + context + 1);
    const slice = ops.slice(from, to);
    const oldBefore = ops.slice(0, from).filter((o) => o.oldNo !== null).length;
    const newBefore = ops.slice(0, from).filter((o) => o.newNo !== null).length;
    const oldLines = slice.filter((o) => o.kind !== "add").length;
    const newLines = slice.filter((o) => o.kind !== "del").length;
    // header: nearest declaration line above the hunk in the new file
    let header = "";
    for (let k = Math.min(newBefore - 1, b.length - 1); k >= 0; k--) {
      if (HEADER_RE.test(b[k])) {
        header = b[k].trim().replace(/\s*\{$/, "").slice(0, 60);
        break;
      }
    }
    hunks.push({
      oldStart: oldLines > 0 ? oldBefore + 1 : oldBefore,
      oldLines,
      newStart: newLines > 0 ? newBefore + 1 : newBefore,
      newLines,
      header,
      lines: slice.map((o): DiffLine => ({ kind: o.kind, oldNo: o.oldNo, newNo: o.newNo, text: o.text })),
    });
  }
  return hunks;
}

/** Builds a complete `FileDiff` for the mock. */
export function buildFileDiff(
  path: string,
  oldPath: string | null,
  seed: string,
  status: "added" | "modified" | "deleted",
  context: number,
): FileDiff {
  const { oldLines, newLines } = fileVersions(path, seed, status);
  return { path, oldPath, binary: false, hunks: buildHunks(oldLines, newLines, context), tooLarge: false };
}

/** `+N -M` counts of a file change, computed from the same fake diff the viewer shows. */
export function countChanges(path: string, seed: string, status: "added" | "modified" | "deleted"): { additions: number; deletions: number } {
  const { oldLines, newLines } = fileVersions(path, seed, status);
  let additions = 0;
  let deletions = 0;
  for (const o of diffOps(oldLines, newLines)) {
    if (o.kind === "add") additions++;
    else if (o.kind === "del") deletions++;
  }
  return { additions, deletions };
}

/** Whole content of the new side (used by `file_content`). */
export function fileText(path: string, seed: string): string {
  return fileVersions(path, seed, "added").newLines.join("\n") + "\n";
}

export function toFileChange(path: string, oldPath: string | null, status: FileChange["status"], seed: string): FileChange {
  const kind = status === "added" || status === "untracked" ? "added" : status === "deleted" ? "deleted" : "modified";
  const c = countChanges(path, seed, kind);
  return { path, oldPath, status, additions: c.additions, deletions: c.deletions, binary: false };
}
