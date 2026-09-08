# Test evidence

Only runs that were actually executed are recorded here, with the command and the counts the runner printed. A green line without a command is not evidence (prd.md 20.5).

## 2026-09-08 — Gate 1 foundation

| Command | Result | Notes |
|---|---|---|
| `pnpm typecheck` | pass (contracts, web) | TypeScript 7.0.2; kernel typecheck pending persistence package |
| `pnpm test:contracts` | 4 files, 71 tests passed | decimal canonicalization (T-05), strict intent schema (T-06, T-07), canonical JSON, event hash chain (T-54), receipt fingerprint (T-55), reason-code templates |
| `pnpm exec vitest run --project unit tests/unit/kernel` | 1 file, 13 tests passed | configuration contract: forbidden options rejected (T-48, INV-13), TESTNET credential rule, model-provider rule, redaction |

Pending for G1 acceptance: persistence migrations (integration), domain decimal (unit + property), kernel boot (integration), `pnpm doctor`, `pnpm lint` clean.
