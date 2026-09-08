# G4 independent review and corrections

Reviewed G4 (`9a4e888`) on 2026-09-08 in an isolated checkout while G5 development
continued. The G3 fixes are present through merge `426a6fd`. Integration checks
use disposable PostgreSQL 17, unique account aliases, and paper execution.
Development balances and Claude's active checkout are untouched.

## Reproduced failures and corrections

- BUY and SELL settlement updated account balances without matching shared
  quote attribution. Both sides now conserve account and attributed inventory;
  quote cash remains shared rather than being assigned to an agent.
- Fees exceeding the approved model or available hold could mark a command
  reconciled and the account ready. Settlement now retains unresolved holds,
  records actual observed effects, and raises a critical incident. Modeled fee
  checks include the paper adapter's per-fill rounding.
- Partial fills charged the lease while leaving the full hold armed, counting
  the same cost twice. Incremental settlement now moves that part to consumed
  while retaining the outstanding hold until terminal confirmation.
- Mismatched venue identity and changed duplicate fills could alter financial
  evidence. Observations now bind to the command and immutable fill data before
  posting; a late weaker response cannot downgrade known acceptance or reopen
  a completed settlement. Reconciliation also rejects foreign-account IDs.
- Boot recovery failure remained cached after successful recovery. Readiness
  now uses current ownership, account status, and unsettled state. Admission
  cannot reserve new funds after losing the database writer lock.
- A REST cache hit renewed a book's apparent freshness. Cached snapshots now
  preserve their actual request and receive timestamps and original expiry.
- REST parsing discarded price bounds and incorrectly treated percentage and
  position filters as qualified. Enabled price bounds are enforced after tick
  normalization; unqualified applicable filters cause `FILTER_UNSUPPORTED`.
  Evaluation semantics are versioned as engine `0.1.2`.
- Failed provider runs lost known token usage, schema repair count, and invalid
  output status. The runner now retains that metadata in its failure trace.

The new paper journal tests also verify persistence across a dropped response
and adapter restart, retained book-liquidity consumption, and refusal of a
corrupt journal instead of an empty replacement venue.

Accounting and recovery choices are recorded in [decision 0007](decisions/0007-g4-settlement-and-shared-cash.md).
Market/filter and provider-evidence choices are recorded in [decision 0006](decisions/0006-g4-observation-and-model-evidence.md).

## Validation

Before corrections, the existing suite passed 353 tests, with 3 opt-in online
tests skipped. Lint, typecheck, and the web build passed. This baseline did not
detect the reproduced failures above.

Final combined validation on the corrected tree:

- `pnpm test`: **404 passed, 3 online tests skipped**, across 36 passing files
  and 1 skipped file. This adds 51 passing regressions to the baseline. The
  integration database was the disposable PostgreSQL instance, selected with
  `DATABASE_URL_TEST`.
- `MK_ONLINE_TESTS=1 pnpm exec vitest run --project integration tests/integration/integrations`:
  **3 passed**, using actual public REST depth and exchange metadata reads.
- `pnpm lint`, `pnpm typecheck`, `pnpm --filter @moneykernel/web build`, and
  `git diff --check`: passed.
- `pnpm run doctor`: all required checks passed against the disposable
  database; 4 migrations applied and 191 staged/tracked files passed its scan.

The fee-rounding, late terminal-observation, and foreign-account regressions
were each observed failing before their targeted correction, then passed in
the final combined run. Original historical model-run JSON files have no diff.

The independent [supported-session evidence](evidence/g4-review-model-run/README.md)
contains an actual proposal authored from its exact live public REST context.
The kernel returned a durable denial for stale data and unsupported filters,
with zero commands. The original four model-run JSON artifacts remain unchanged;
their [evidence status](evidence/model-runs/README.md) explains why the historical
rebound context is not proof of model generation from that fresh context.

## Remaining qualification boundaries

- SHADOW reads use Binance public REST. Symbols with unsupported percentage or
  position filters cannot produce an admissible proposal. The new session proof
  verifies safe refusal, not a successfully approved SHADOW trade.
- Binance MCP access and an external TESTNET write adapter remain unqualified.
- PRD T-26 still returns `DENY / OUTCOME_UNKNOWN` for a later opposing intent
  while an earlier command is unsettled. Durable deferral is not implemented;
  retry requires fresh evaluation and separate approval.
- Receipt-to-model-run provenance remains a G6 task. The seed's receipt source
  label and the runner's supported-session trace are documented separately.
- Existing corrupted attribution or unresolved incidents require explicit
  operator correction; this review does not silently repair historical data.
