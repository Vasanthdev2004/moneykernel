# Test evidence

Only runs that were actually executed are recorded here, with the command and the counts the runner printed. A green line without a command is not evidence (prd.md 20.5).

## 2026-09-08 — Gate 2 deterministic vertical slice

Environment: Windows 11, Node 24.19.0, pnpm 12.3.4, PostgreSQL 17.11 in Docker (compose service `db`, host port 5433 on this machine), TypeScript 7.0.2, Vitest 5.0.0, Biome 2.5.12.

| Command | Result | What it covers |
|---|---|---|
| `pnpm lint` | clean | Biome, whole workspace (spikes excluded) |
| `pnpm typecheck` | clean | root project and `apps/web` |
| `pnpm test:contracts` | 81 tests passed | as in G1 plus strict normalized-request and fingerprint material validation |
| `pnpm test:unit` | 72 tests passed | as in G1 plus the pure policy evaluator: Scenario A exact counterproposal (T-02), in-budget allow (T-01), below-minimum denial without upward rounding (T-03), step/tick normalization (T-04), two-request cash arithmetic (T-11), SELL proceeds never refill a lease (T-16), own-hold exclusion (T-17), stale/future/unknown observations, valuation blocked without a fresh mark, attempt limits, unsupported filters, lease window/status/identity denials, SELL inventory authority (T-13, T-14), determinism and fingerprint stability (FR-03, T-55) |
| `pnpm test:property` | 7 properties × 400 runs passed | decimal properties |
| `pnpm test:integration` | 34 tests passed | migrations and constraints (incl. 0002 order identity, 0003 reconciliation marker), kernel boot; admission over HTTP: agent bearer auth (401), Scenario A through `GET /v1/agent/context` and `POST /v1/agent/intents` with exact reservations (QUOTE 27.027 + ATTEMPT 1), receipt fingerprint recomputed from the stored receipt, audit chain verified; idempotent replay (T-18) and key reuse refused (T-19); exponent amount 422 and unknown field 400 with no state change (T-05, T-06); cross-agent intent read 404 (T-52); second request denied by consumed SOL headroom; two concurrent 80 USDT requests against 100 USDT reserve 80.08 + 19.9199 (T-11); fifty concurrent requests admit exactly 5 by attempt limit and reserve 150.15 (T-12); SELL beyond inventory denied and concurrent SELLs reserve base at most once (T-13, T-14) |
| `pnpm run doctor` | all required checks passed | node, pnpm, docker engine, configuration, `.env` untracked, tracked-file secret scan, database, migrations (3 applied) |
| manual: `pnpm dev`, `pnpm demo:seed`, curl | see below | REPLAY seed + real HTTP flow against the local database |

Manual smoke (REPLAY, local database): kernel booted and paused the account; `demo:seed` loaded Scenario A (policy v1, balances, symbol rules, agent tokens, leases) and resumed it; `GET /v1/agent/context` returned fresh SYNTHETIC_FIXTURE observations; the 80 USDT SOL intent returned `COUNTERPROPOSE` with the exact 0.270 SOL candidate; the same key replayed with HTTP 200.

## 2026-09-08 — Gate 1 foundation (commit 324bfa5)

| Command | Result | What it covers |
|---|---|---|
| `pnpm lint` / `pnpm typecheck` | clean | |
| `pnpm test:contracts` | 4 files, 71 tests passed | decimal canonicalization (T-05), strict intent schema (T-06, T-07), canonical JSON, event hash chain (T-54), receipt fingerprint (T-55), reason-code templates |
| `pnpm test:unit` | 4 files, 52 tests passed | configuration contract (T-48, INV-13), HTTP surface without a database, decimal math incl. Scenario A arithmetic, migration file sequencing |
| `pnpm test:property` | 7 properties × 400 runs passed | canonical round trip, floorToStep bounds, add/sub inverse, notional never over-committed, tick rounding brackets the price, cmp consistency |
| `pnpm test:integration` | 2 files, 12 tests passed | migrations, constraints, writer lock, boot protocol, restart epoch increment |
| `pnpm db:migrate` / `pnpm db:status` | 1 applied | |
| `pnpm run doctor` | all required checks passed | |
| manual boot + curl | live 200, ready 200, status 200, 404 envelope | REPLAY boot |

Not yet exercised: `test:fault` (no fault tests until the dispatcher exists, G3/G4), `test:e2e` (Playwright arrives with the operator UI, G5).
