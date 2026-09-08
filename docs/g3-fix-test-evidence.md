# G3 independent review and corrections

Reviewed G3 (`547f145`) with the prior G2 corrections (`fc00bc8`) on 2026-09-08,
in an isolated checkout while G4 development continued. Integration checks use
a disposable PostgreSQL 17 database, unique account aliases, a virtual clock,
and paper execution. No development balances or credentials are changed.

## Reproduced authority failures

- A dispatcher waiting for the account lock used its earlier timestamp and
  armed after proposal and lease expiry. Approval had the same stale-clock
  boundary. Authority time now follows the relevant locks.
- Stale approval refusal threw inside the transaction, rolling back the
  invalidation, released holds, and audit event. Business refusal now follows
  the commit of those changes.
- Altered proposal contents or command payloads could escape the stored
  approval hash; released reservation rows could still result in arming.
  Arming now verifies the material hash, persisted payload, exact owned holds,
  and the original writer session's live advisory lock.
- Valid fractional price drift could throw during audit formatting. The
  decision keeps exact rational arithmetic; the audit uses display formatting.
- An opposite intent admitted after approval left the old command READY until
  the background sweep. Opposition now commits with admission and is checked
  again under the approval/dispatch account lock. The 750 ms minimum collection
  delay still applies when promoting an unopposed proposal.
- COMMAND_CREATED alone incorrectly classified already armed proposals as
  pre-arm. Stop, quarantine, expiry, and operator rejection now preserve orders
  that have crossed the arming boundary and their accounting reservations.
- Stop omitted ACCEPTED orders awaiting reconciliation and resume allowed them.
  Both now use the same outstanding-command predicate as readiness, including
  open/missing orders and unsettled reservations.
- Missing or foreign-account leases returned 404 while rolling back their
  violation evidence, preventing quarantine. Durable denied-request evidence
  now binds the agent, idempotency key, and canonical payload. Exact retries do
  not count again; distinct denials count for both hard violations and bursts.
- The in-memory operator request cache let an old resume retry undo a newer
  stop after restart. Durable payload-bound claims/results prevent rerunning
  old requests. An unresolved claim fails closed; see decision 0004.
- Concurrent policy updates with the same If-Match both succeeded. The
  version comparison, new policy, and invalidation now share one account lock
  and transaction. Lease and inventory writes validate account ownership, and
  inventory edits respect existing reservations and unsettled commands.
- The public mutation configuration did not gate authenticated remote writes.
  Operator and agent mutation guards now enforce it.

## Regression coverage

New focused suites cover proposal opposition and post-arm state preservation,
approval/dispatch timing and integrity, account stop/resume readiness, invalid
lease retries/quarantine, and operator request durability and mutation controls.
The existing G3 coordination tests now assert that opposition is visible before
the next background sweep.

Final combined validation:

- `pnpm test`: **273 tests passed** across 24 files (181 unit/property/contracts
  and 92 integration tests, including 30 new regressions).
- `pnpm lint`, `pnpm typecheck`, and the web production build passed.
- After the final conflict revalidation clock adjustment, all 11 proposal and
  existing coordination integration tests passed again; formatting and diff
  checks passed.

## Integration boundary

Apply migration `0004_operator_requests.sql` before starting this kernel version.
Unresolved operator request claims are deliberately not rerun automatically;
inspect current account state before submitting a new control action.

G4 owns fill settlement, exchange recovery, and fault reconciliation. These G3
checks do not qualify a live exchange adapter or prove completion of G4.

One PRD behavior remains for coordination with G4: T-26 asks to hold a later
opposing intent until the earlier order is reconciled. The existing conservative
admission rule instead returns `DENY / OUTCOME_UNKNOWN` while any command is
unsettled. The earlier order is now preserved correctly, but there is no durable
deferred-intent queue. Do not bypass the unsettled-account guard or turn that
denial into an executable proposal; any eventual retry needs fresh evaluation
and separate approval.
