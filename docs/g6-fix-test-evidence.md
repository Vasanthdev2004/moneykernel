# G6 independent review — 2026-09-08

Reviewed Claude's `32a2604` in a separate Git worktree, then rebased the fixes onto his G7 commit `afe3847`. The G5 fixes were already merged. Claude's main checkout, G7 edits and running servers were preserved. The rebase retained G7's assertion fixes and README/demo additions. PostgreSQL 17.11 ran in a disposable review container with five migrations; all money and venue behavior below are synthetic REPLAY data.

## Baseline and confirmed failures

The original G6 build and 438 tests passed (three online tests skipped), as did the seven existing browser tests. Lint failed on two unsafe optional-chain dereferences in assertions. Passing tests did not establish the following claims:

- Exporting an account with 5,007 audit events returned only 5,000. Concurrent settlement could place old lease usage and new fills in the same bundle.
- An authenticated intent with an agent bearer token or configured bootstrap secret in its rationale could be downloaded in plaintext. Unknown credential-shaped schema keys could also appear in verifier diagnostics.
- With the original audit events unchanged, altered approval hashes/states, exact payloads, ledger signs, missing fees, hold assets/owners, lease usage and allocation ownership could still pass verification.
- Altered archived policy/snapshot references, removed receipts, empty or foreign-account event logs, and unsupported engine claims were insufficiently checked. A floating-point event payload could produce an uncaught CLI exception instead of a JSON report.
- `--runs 0` exited successfully after actually seeding and running one account. Reusing a seeded alias threw an error but left the CLI alive until a five-second child-process timeout.
- Scenario B labelled a SELECT loser-hold check as REJECT_BOTH, and scenario C never executed its post-burst exact retry. Scenario D's intermediate unknown/paused states were not asserted. The original-intent check inspected only the amount.

## Changes verified

Exports now read every table family and event page from one consistent read-only snapshot, declare the snapshot's final event, and refuse credential-bearing content without altering signed data. The shared scanner also protects verifier diagnostics. Mixed/empty agent runs no longer claim SCRIPTED provenance.

The standalone verifier binds receipts and row identities to audit evidence, checks the actual evaluator version, replays fingerprinted references and material, validates pending and settled authority, and verifies signed financial journals and inventory attribution. Pending/unknown execution remains verifiable without being presented as completed settlement. New tests retain the original event hashes when tampering with rows; valid incomplete lifecycles are also covered.

The replay driver now checks complete stored intents, performs both conflict actions with separate pairs, executes the exact retry with unchanged outcome and durable counts, requires a real quarantined denial, and checks the unknown state entering recovery plus paused state after boot. Invalid arguments fail before configuration, and failed runs close the app and database resources.

The console test downloads a full run after a real paper settlement, parses and verifies it, checks the receipt/command/fill counts, and checks that operator and agent credentials are absent. Optional `E2E_KERNEL_PORT`/`E2E_WEB_PORT` isolate browser validation from another checkout's servers; both test servers refuse reuse.

## Final validation

| Check | Result |
|---|---|
| `pnpm test`, rebased onto `afe3847` | 515 passed, 3 opt-in online checks skipped; 49 files passed, one skipped |
| Verifier regression subset | 72 passed, including row tampering with unchanged audit hashes and valid incomplete execution |
| `pnpm test:e2e` with ports 58880/58881 | 7 passed in 17.0 seconds, including complete run download and standalone verification |
| `pnpm lint` and `pnpm build` | Clean; build includes both TypeScript checks |
| `pnpm run doctor` | All required checks passed; 266 tracked files screened, five migrations applied |
| `demo:replay` for A/B/C/D with `--runs 3` | 12 isolated runs passed before the G7 rebase; A/B/C/D perform 5/8/7/13 checks respectively, including export verification |
| `demo:replay` for A/B/C/D after the G7 rebase | Four fresh compatibility runs passed with the same checks |
| Original archived replay exports | All six still verify without file changes |

The first consolidated run during the attribution work exposed two assertions that still expected conservation to pass after financial tampering. They were updated to expect the newly detected inconsistency, and the final suite above passed. These are local checks; this review did not rerun G7's separate three-round recording rehearsal.

## Verification limits

- `--head-checkpoint` accepts an independently retained final event hash. Without one, success means internal consistency; a self-declared hash cannot prove the absence of a complete privileged rewrite. Automatic external anchoring remains P2.
- Legacy null contexts are explicitly fingerprint-only. The export has evaluator context plus snapshot references/hashes, not separate raw source snapshot rows; it does not independently reproduce an upstream response.
- Credential screening cannot identify every arbitrary unknown secret in prose. Configured values are checked by the exporter; the offline verifier has only format/key detection. Publication still requires artifact review.
- No historical replay JSON or screenshot was rewritten. Live-model receipt provenance, MCP/SHADOW qualification, Testnet execution and the G7 recording/submission package retain their previously documented limitations.

See [decision 0010](decisions/0010-g6-verification-boundaries.md) for the contract and trust decisions.
