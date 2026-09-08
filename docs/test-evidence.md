# Test evidence

Only runs that were actually executed are recorded here, with the command and the counts the runner printed. A green line without a command is not evidence (prd.md 20.5).

## 2026-09-08 — Gate 3 authority and coordination

Environment: Windows 11, Node 24.19.0, pnpm 12.3.4, PostgreSQL 17.11 in Docker (compose service `db`, host port 5433 on this machine), TypeScript 7.0.2, Vitest 5.0.0, Biome 2.5.12.

| Command | Result | What it covers |
|---|---|---|
| `pnpm lint` / `pnpm typecheck` | clean | |
| `pnpm test:unit` | 72 passed | unchanged from G2 plus candidate `reference_mark` |
| `pnpm test:property` | 7 × 400 runs passed | |
| `pnpm test:contracts` | 81 passed | |
| `pnpm test:integration` | 43 passed | G2 suites plus the coordination suite below and the reconciliation-readiness suite from the review session (now behind operator auth) |
| `pnpm run doctor` | all required checks passed | |
| manual: `pnpm dev`, `pnpm demo:seed`, curl | intent `ALLOW_PROPOSAL`/`COLLECTING` → background sweep → `AWAITING_APPROVAL` → operator login and exact approval `ACTIVE` → background dispatch → command `ACCEPTED`; status shows 1 unreconciled command (accounting arrives in G4) | the real process with its 250 ms loops, not the test harness |

Coordination suite (`tests/integration/kernel/coordination.test.ts`), all against a real PostgreSQL database and the REPLAY fixture adapters with a virtual clock:

- Operator sessions: wrong secret 401, bearer session accepted, cookie session without `X-CSRF-Token` refused on a mutation (403), five failures rate-limit the next login (429).
- Exact approval and arming (FR-07, FR-08, INV-05, INV-06, T-20, T-21): approval refused before the 750 ms collection window elapses; tampered hash and wrong epoch refused with `STALE_APPROVAL`; exact approval stores one approval and creates one READY command with a stable `mk_…` client order id; the same idempotency key replays, a new key returns the same approval; `dispatchOnce` arms once, submits once to the paper executor (submit count 1), records the FILLED order and its fill, marks the attempt CONSUMED and the quote hold ARMED, increments the lease's attempts; a second dispatch is idle; the audit chain verifies.
- Authority changes after approval: lease revocation invalidates the approved command before arming and releases holds (T-10); a lease expiring during operator delay aborts at dispatch with `LEASE_EXPIRED` (T-09); `PUT /v1/policy` needs `If-Match` and invalidates pending authority (T-22); stop bumps the epoch, ends pre-arm candidates, reports no in-flight command, blocks arming and new intents (`ACCOUNT_PAUSED`), is idempotent, and resume is readiness-gated (T-33).
- Opposing intents (FR-06, T-24, T-25, T-28): BUY and SELL on the same symbol both `CONFLICT_HELD`, approval refused with `OPPOSING_INTENT`, dispatch idle; `SELECT` re-validates the winner into revision 2 awaiting approval and rejects the loser with holds released; an opposing intent arriving after approval invalidates the unused approval and aborts the READY command; `REJECT_BOTH` releases every hold.
- Quarantine (FR-09, T-29, T-30, T-31, T-34): the 11th unique intent in 60 s is denied `AGENT_QUARANTINED` and releases the agent's holds; exact retries replay the recorded outcome; later intents stay denied; the open CRITICAL incident blocks resume until acknowledged; three hard authority violations quarantine; quarantine survives a kernel restart.

## 2026-09-08 — Gate 2 deterministic vertical slice (commit bf91268)

| Command | Result |
|---|---|
| `pnpm test:contracts` | 81 tests passed |
| `pnpm test:unit` | 72 tests passed (pure policy evaluator incl. Scenario A exact) |
| `pnpm test:property` | 7 × 400 runs |
| `pnpm test:integration` | 34 tests passed (admission over HTTP, idempotency T-18/T-19, T-11/T-12 concurrency, T-13/T-14 SELL races) |
| manual `pnpm dev` + `pnpm demo:seed` + curl | 80 USDT SOL BUY → `COUNTERPROPOSE` 0.27 SOL, 27.027 reserved; replay 200 |

## 2026-09-08 — Gate 1 foundation (commit 324bfa5)

| Command | Result |
|---|---|
| `pnpm test:contracts` | 71 tests passed |
| `pnpm test:unit` | 52 tests passed |
| `pnpm test:property` | 7 × 400 runs |
| `pnpm test:integration` | 12 tests passed (migrations, constraints, writer lock, boot, restart epoch) |
| `pnpm run doctor` | all required checks passed |

Not yet exercised: `test:fault` (fault injection arrives with reconciliation, G4/G6), `test:e2e` (Playwright arrives with the operator UI, G5).
