# 0002 — Gate 1 verification corrections

Date: 2026-09-08

The independent G1 review reproduced migration compatibility, readiness,
receipt validation, exchange identity, and setup-command defects. This decision
records the approved corrections while the G2 evaluator is being built.

## Schema and contract decisions

- Keep receipt `schema_version: "1"` for this pre-release correction. G1 has no
  runtime receipt producer or supported stored receipt exports to migrate.
  Test fixtures are updated together with the verifier and schemas. Future
  changes affecting persisted receipts require an explicit version decision.
- `normalized_request` is a strict object matching the G2 evaluator's existing
  derived request: `account_id`, `agent_id`, `lease_id`, `symbol`, `side`,
  `order_type`, `size`, `limit_price`, `observation_ids`, and nullable
  `strategy_run_id`. Identity fields come from authenticated kernel context.
  Financial fields reuse the intent schemas and canonicalize decimal strings;
  unknown fields and BUY/SELL size mismatches fail validation.
- Snapshot IDs and content hashes are both required, with equal lengths.
  Fingerprinting validates and canonicalizes its material. Invalid external
  receipts fail verification rather than crashing it.
- Applied migration versions missing from the checkout are incompatible,
  including rollback to older code. Status reports drift and migration stops
  before applying pending SQL.

## Upgrade and reconciliation

Migration `0001` is unchanged. `0002` scopes exchange order identity to account,
symbol, and exchange order ID, following Binance's symbol-scoped IDs.
`0003` adds nullable `commands.reconciled_at`. Run `pnpm db:migrate` before
starting the updated kernel. No migration is applied automatically by boot.

An `ACCEPTED` command is outstanding until a terminal reconciliation transaction
has applied and deduplicated all fills and fees, reconciled balances and order
totals, settled reservations, appended the audit evidence, and set
`reconciled_at` under the account lock. A terminal order status alone does not
establish this. Existing accepted rows keep a null marker and remain blocked.
Missing/open orders or outstanding holds also block readiness even if a marker
exists. The future G4 reconciler must implement this transaction; no endpoint
or operator shortcut to set the marker is added here.

Boot, readiness, and status share the outstanding-command query. The account
still requires explicit operator Resume after reconciliation. Synthetic tests
exercise the marker's readiness semantics; they do not claim to implement the
future fill-accounting lifecycle.

Affected requirements: INV-02/08/09/12/14/16, FR-08/10, PRD sections 11.6,
11.8, 14.5, 14.6, 15.6, and 19.5.

## Operator command

Use `pnpm run doctor`. With the pinned pnpm 12, `pnpm doctor` invokes the
package manager's own diagnostic and does not run MoneyKernel's checks.
