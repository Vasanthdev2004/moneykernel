# Test evidence

Only runs that were actually executed are recorded here, with the command and the counts the runner printed. A green line without a command is not evidence (prd.md 20.5).

## 2026-09-08 — Gate 1 foundation (commit 324bfa5)

Environment: Windows 11, Node 24.19.0, pnpm 12.3.4, PostgreSQL 17.11 in Docker (compose service `db`, host port 5433 on this machine), TypeScript 7.0.2, Vitest 5.0.0, Biome 2.5.12.

| Command | Result | What it covers |
|---|---|---|
| `pnpm lint` | clean | Biome, whole workspace (spikes excluded) |
| `pnpm typecheck` | clean | root project and `apps/web` |
| `pnpm test:contracts` | 4 files, 71 tests passed | decimal canonicalization and rejection cases (T-05), strict intent schema with unknown-field and side/size rules (T-06, T-07), canonical JSON (float rejection, key order, path reporting), event hash chain tamper detection (T-54), receipt fingerprint stability (T-55), reason-code templates |
| `pnpm test:unit` | 4 files, 52 tests passed | configuration contract: forbidden options (T-48, INV-13), TESTNET credential rule, model-provider rule, redaction; HTTP surface without a database (liveness vs readiness, error envelopes, body limit); decimal math incl. Scenario A arithmetic (prd.md 27.1), step/tick normalization (T-04); migration file sequencing |
| `pnpm test:property` | 1 file, 7 properties x 400 runs passed | canonical round trip, floorToStep bounds and lot round trip, add/sub inverse, quantityForNotional never over-commits, tick rounding brackets the price, cmp consistency |
| `pnpm test:integration` | 2 files, 12 tests passed | migrations apply once and create every PRD 14.2 table; checksum drift detected and refused; account environment immutable; negative money rejected; one ACTIVE lease per agent; audit events append-only; writer advisory lock exclusive; row lock + rollback; kernel boot in REPLAY creates a PAUSED account at epoch 1 and is ready; second process cannot take the writer lock; restart increments the epoch and extends a verifiable audit chain; TESTNET refuses readiness |
| `pnpm db:migrate` then `pnpm db:status` | 1 applied, 0 pending, 0 drifted | local `moneykernel` database |
| `pnpm doctor` | all required checks passed | node, pnpm, docker engine, configuration, `.env` untracked, tracked-file secret scan, database, migrations |
| manual: `node --env-file-if-exists=.env apps/kernel/src/server.ts` + curl | `/health/live` 200, `/health/ready` 200, `/v1/status` 200 (REPLAY, PAUSED, epoch 1, provenance SYNTHETIC_FIXTURE/DISABLED/PAPER), unknown route 404 envelope | REPLAY boot against the migrated database |

Not yet exercised: `test:fault` (no fault tests until the dispatcher exists, G3/G4), `test:e2e` (Playwright arrives with the operator UI, G5).
