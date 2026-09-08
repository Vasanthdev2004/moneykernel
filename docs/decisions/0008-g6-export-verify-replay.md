# 0008 — G6 sanitized export, standalone verification, offline replay, fault layer

Date: 2026-09-08. Base: `57cf4fa` plus the review session's `ec49f31`.

## Problem

Gate 6 must prove the claims the demo makes (prd.md 23.3) with evidence a
third party can check without our database: that decisions were recorded as
stated (T-54, T-55), that the export carries no secrets (T-58), that the
three scenes replay in isolation (T-60, 27.5), and that the named crash points
behave conservatively (11.7, 20.5).

## Decisions

1. **Archive the evaluator context with every receipt** (migration
   `0005_decision_context.sql`, `decision_receipts.evaluation_input`). prd.md
   14.5 says verification replay runs the pure evaluator with the original
   archived logical context; the fingerprint material alone (versions, hashes,
   normalized request, checks) proves integrity, not re-derivability. The input
   is plain JSON (decimal strings, snapshot ids and hashes) and contains no
   secrets. Receipts written before the migration keep `null` and verify by
   fingerprint only; the verifier reports them as "context not archived",
   never guesses.
2. **`GET /v1/runs/:id/export`** serves the loaded account only (`current`
   or its id), validated against the frozen `RunExportSchema` before it
   leaves. Token hashes are excluded at the SQL level; the bundle carries the
   full hash-chained event log and a genesis checkpoint (`previous_hash:
   null`). An out-of-band trusted checkpoint can be passed to the verifier.
3. **`pnpm verify:receipt -- <file>`** is standalone (contracts and domain
   packages only): schema, event chain (T-54), receipt fingerprints,
   decision replay through the pure evaluator (T-55), linkage, numerical
   agreement between candidate, command payload, order, fills, reservations,
   and ledger (prd.md 23.4), ledger conservation (14.3), a secret scan (T-58),
   and sanitization. Exit 0/1/2. It verifies records; it does not prove that
   Binance or a model was honest (14.5).
4. **`pnpm demo:replay -- <scenario-id> [--runs N]`** boots an in-process
   REPLAY kernel on a fresh alias with a virtual clock per run, drives the
   fixture's steps through the same HTTP handlers the console uses, checks
   the fixture's `expected` block, exports the run, and verifies the export.
   Every run is a new virtual account and event chain (27.5); scenario C's
   burst block replaces steps. Fixture observation ids are placeholders that
   the replay resolves to the kernel's real snapshot ids by symbol.
5. **Fault layer** (`tests/fault`, `pnpm test:fault`): stop racing dispatch
   over six rounds with audit-sequence ordering as the oracle (T-33),
   database refusal before the arm commit via an injected trigger (T-43),
   writer lock loss (T-44), unsupported fee asset on a settled fill (T-45,
   new paper fault `commissionAssetFor`), and an amnesiac venue across two
   restarts before its memory returns (T-36/T-37/T-38). Each test names its
   crash point; the paper venue journal is the reproduction seed.
6. **Scenario C semantics**: earlier burst requests may already be denied for
   budget reasons; the quarantine claim is that request 11 is denied with
   `AGENT_QUARANTINED` and no earlier request was. Two incidents can coexist
   on one command (unsupported fee asset and fill-detail mismatch); neither is
   dropped to make the account look clean.

## Contract changes

Additive: `packages/contracts/src/export.ts` (`RunExportSchema`,
`ExportedReceiptSchema`). Wire schemas stay at version `1`.

## Revisit triggers

External anchoring or signing of checkpoints (P2); replay against archived
contexts from an older engine version (the verifier runs the current
evaluator; a version mismatch is reported, not hidden).
