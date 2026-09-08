# G1 verification fix evidence

Date: 2026-09-08. Base: `5607532`.

Validated in a detached checkout containing G1 plus only these fixes, while G2
development continued in the shared checkout. Dependencies used the unchanged
G1 lockfile. Database checks used a disposable PostgreSQL 17.11 instance with
synthetic credentials and data; the development database was not modified.

| Check | Result |
| --- | --- |
| `pnpm lint` | Pass |
| `pnpm build` (includes both TypeScript checks) | Pass |
| `pnpm exec vitest run --project unit --project property --project contracts` | 140 tests passed, 9 files |
| `pnpm test:integration` | 24 tests passed, 3 files |
| `pnpm run doctor` | All required checks passed; 3 migrations applied, none pending |
| `git diff --check` | Pass |

Total: 164 tests passed. `pnpm test:fault` was also attempted: G1 contains no
fault test files, so Vitest exited 1 with "No test files found". This is not
claimed as a passing fault gate; dispatcher and reconciliation fault coverage
belongs to later gates.

The regressions cover unknown applied migrations (including refusing pending
SQL), an actual 0001-to-current database upgrade preserving existing orders,
symbol-scoped exchange IDs, strict/canonical receipt inputs, required aligned
snapshot hashes, malformed receipt verification, and accepted command readiness
before and after restart. Reconciled terminal commands unblock readiness;
missing/open orders and outstanding holds still block it.

An independent read-only review found no further actionable issues in the
scoped changes. Reconciliation fixtures test readiness semantics; they do not
implement or validate the future fill-accounting reconciler.

Use `pnpm run doctor`: the shorter `pnpm doctor` runs pnpm 12's own diagnostic.
Apply the new migrations with `pnpm db:migrate` before starting the updated
kernel. See [the contract and upgrade decision](decisions/0002-g1-verification-fixes.md).

## Combined commit verification

Claude's G2 commit `bf91268` included and pushed the shared G1 corrections while
the isolated verification was finishing. The fixes were checked against that
commit; its additional boot and documentation changes were preserved.

- `pnpm exec vitest run --project unit --project property --project contracts`:
  160 tests passed in 10 files.
- `pnpm test:integration`: 34 tests passed in 4 files on the disposable database,
  including both admission and G1 readiness regressions.
- `pnpm build`: passed, including both TypeScript checks.
- `pnpm lint`: passed with one unused-import warning in the new policy evaluator;
  the unused import was removed and the lint check rerun cleanly.

Total on the combined code: 194 tests passed. This confirms compatibility of
the G1 corrections with the available G2 tests; it is not a full independent
review of G2 against every PRD acceptance condition.
