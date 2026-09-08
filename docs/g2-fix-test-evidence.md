# G2 review and fix evidence

Date: 2026-09-08. Reviewed G2 at `e4c0845` in an isolated checkout while G3
development continued. Tests used a disposable PostgreSQL 17.11 database with
synthetic credentials and separate account aliases, never the development DB.

## Reproduced failures

- A quote debit committed during the preflight read still allowed a BUY using
  the old balance; a newly held unvalued asset was omitted in the same window.
- A request waiting for the account row lock could acquire a proposal after
  its lease expired. The regression uses an actual PostgreSQL lock wait.
- ARMED, OUTCOME_UNKNOWN, and accepted-but-unreconciled commands did not stop
  further admission when the account row remained READY.
- An unsuccessful current rule refresh still used cached rules to allow BUYs.
- A 100 USDT SELL bypassed the default 50 USDT order cap. Non-quote fee assets
  received unsupported quote-only or zero-fee reservation behavior.
- BUY 25 against equity 100, share cap .25, no buffer and .001 fees was admitted
  despite its fee-adjusted share exceeding .25. The valid .001-lot result is
  .249 units at price 100. Below-tick BUY prices threw instead of denying.
- `1.000000000000000001` passed a ratio upper bound of one through float rounding.
- Seeding Scenario B twice then submitting two SELLs allowed .0016 BTC of
  reservations against .001 BTC owned and .002 BTC assigned.
- A SCRIPTED decision changed to LIVE_PROVIDER on retry after provider
  configuration changed, without any model invocation.

## Validation

| Command | Result |
| --- | --- |
| `pnpm lint` | Clean |
| `pnpm build` | Passed, including root and web TypeScript checks |
| `pnpm exec vitest run --project unit --project property --project contracts` | 181 tests passed, 11 files |
| `pnpm test:integration` | 53 tests passed, 7 files |
| `pnpm run doctor` | All required checks passed, engine 0.1.1 and 3 migrations current |

Total: 234 tests passed. Added 40 regressions beyond the previous 194 tests.
The suites cover the failures above, exact Scenario A arithmetic, idempotent
read-back while admission is blocked, account and agent SELL envelopes,
concurrent/failed seed atomicity, baseline journals, and provenance across restart.

Independent review of the corrected fee mathematics and atomic baseline found
no further actionable issues. This verifies G2; G3 authority/dispatch and later
reconciliation, fault, and UI gates retain their own acceptance requirements.
See [the version and contract decision](decisions/0003-g2-verification-fixes.md).

## Integration with completed G3

Claude committed and pushed G3 as `547f145` while this review was finishing.
The G2 corrections were ported to its extracted evaluation assembler and
preserved its proposal reference marks, operator authentication, and quarantine
flow. The fixes are committed on top of G3; no G3 history is rewritten.

Final combined validation on that base plus these corrections:

- `pnpm lint`: clean.
- `pnpm build`: passed, including both TypeScript checks.
- Unit/property/contracts: 181 tests passed in 11 files.
- `pnpm test:integration`: 62 tests passed in 8 files on the disposable database.

Total: 243 tests passed. G3's available coordination tests passed as a
compatibility check; a full independent G3 acceptance review is separate.
