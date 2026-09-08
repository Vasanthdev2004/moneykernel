# Test evidence

Only runs that were actually executed are recorded here, with the command and the counts the runner printed. A green line without a command is not evidence (prd.md 20.5).

The independent [G4 review and corrections](g4-fix-test-evidence.md) records
subsequent regression coverage and qualification limits. Historical runs below
describe their original code state; their SHADOW approvals do not qualify the
exchange filters that the review now rejects as unsupported.

## 2026-09-08 — Independent G6 review, rebased onto G7

The [G6 review evidence](g6-fix-test-evidence.md) records the original false passes, export failures and their regressions. On base `afe3847`, `pnpm test` passed 515 tests with three online checks skipped, `pnpm test:e2e` passed seven browser tests using isolated ports, and lint/build/doctor passed. All four replay scenarios passed after the rebase; twelve repeated runs had passed before it. The six historical replay exports remain unchanged and verifiable. The separate G7 recording rehearsal was not rerun by this review.

## 2026-09-08 — Gate 7 release candidate

| Command | Result | What it covers |
|---|---|---|
| `pnpm demo:rehearse` (Playwright, `playwright.rehearsal.config.ts`, repeat-each 3) | 12 passed: three consecutive runs of the four scenes, 57 s total (kernel process start, seed, console actions, crash and restart included); a first attempt failed scene D once in its third run when a stale kernel process was still answering the port, so every scene now verifies the live kernel's alias before acting | the four demo scenes through the real console on fresh REPLAY accounts, each with its own kernel process: A counterproposal 0.27 SOL → exact approval → `ACCEPTED` and `FILL_RECONCILED`; B opposing BTC intents `CONFLICT_HELD` → operator selects the BUY → winner `AWAITING_APPROVAL`, loser released, no command; C eleven-request burst → request 11 `AGENT_QUARANTINED`, agent quarantined, reserved 0, later request denied; D synthetic dropped response → `OUTCOME_UNKNOWN` banner → kernel process killed and restarted on the same alias → same command `ACCEPTED`, order `EXPIRED` 0.12 SOL, no banner, `PAUSED` → operator resume → `READY`. Screenshots of run 1 under `docs/evidence/demo/` |
| fresh clone (T-59): `git clone` into `D:	mpmk-fresh`, `pnpm install --frozen-lockfile`, `pnpm exec tsc -p tsconfig.json --noEmit`, offline suites, console build | install ok; typecheck clean; 300 offline tests passed; console built | starts from a fresh clone without exchange or model keys (a first attempt under a very long temp path failed only on pnpm's task-state file path, not on the repository) |
| `pnpm test:integration` | 135 passed, 3 skipped (online, opt-in) | plus `demo-faults.test.ts`: the REPLAY-only fault endpoint targets the proposal's deterministic client order id before approval and is refused (403) in SHADOW |
| `pnpm lint` / `pnpm typecheck` / `pnpm test:unit` / `pnpm test:property` / `pnpm test:contracts` | clean; 203 / 7 × 400 / 90 | |
| `pnpm run doctor` | all required checks passed | |

Recording and submission (prd.md 23.5) remain owner steps; `docs/demo-script.md` carries the script, captions, and the claims checklist.

## 2026-09-08 — Gate 6 adversarial hardening and replay evidence

Environment: as Gate 5. Migration 0005 applied (`decision_receipts.evaluation_input`).

| Command | Result | What it covers |
|---|---|---|
| `pnpm lint` / `pnpm typecheck` / `pnpm build` | clean | |
| `pnpm test:unit` / `pnpm test:property` / `pnpm test:contracts` | 203 / 7 × 400 / 90 passed | plus the verifier suite (17 tests) and the review session's console unit tests: a consistent synthetic bundle passes; an edited event payload fails the chain at its sequence (T-54); an edited outcome fails fingerprint and replay; an edited archived context changes the replayed candidate (T-55); a null context counts as fingerprint-only; a changed fill quantity fails numerical agreement; a removed ledger entry fails conservation; an injected token hash or bearer token fails the secret scan without being echoed (T-58); CLI exit codes 0/2 |
| `pnpm test:integration` | 133 passed, 3 skipped (online, opt-in) | plus `export.test.ts` and the review session's console-safety suite: contract-valid bundle with archived evaluator context, verified chain, no token or hash strings, 404 for a foreign account id |
| `pnpm test:fault` | 5 passed | T-33 stop racing dispatch over six rounds (arm sequence always precedes the stop sequence or no arm happened; venue submissions equal arms); T-43 database refusal before the arm commit (trigger fault): no submission, holds stay HELD, same command arms once afterwards; T-44 writer lock lost: dispatch idle, readiness false; T-45 unsupported fee asset (BNB): hold ARMED, CRITICAL incident plus fill-detail warning, resume refused, fee retained at the venue; T-36/T-37/T-38 amnesiac venue across two restarts then settlement from real venue memory with one submission |
| `pnpm test:e2e` | 7 passed | plus the review session's operator-safety and session-revocation specs |
| `pnpm demo:replay -- scenario-a-constrained-acquisition` | 5 checks passed; `verify:receipt: passed` (9 events, 1 receipt replayed) | outcome COUNTERPROPOSE, limiting SYMBOL_EXPOSURE_LIMIT, exact candidate 0.27 SOL @ 100 / 27 / 0.027 / 27.027, original request unchanged, export verifies |
| `pnpm demo:replay -- scenario-b-opposing-intents` | 8 checks passed; `verify:receipt: passed` | candidates 0.0005 / 0.0002 BTC, both CONFLICT_HELD after the window, one conflict, SELECT re-validates the winner to AWAITING_APPROVAL and releases the loser's holds, no command, export verifies |
| `pnpm demo:replay -- scenario-c-burst-quarantine` | 6 checks passed; `verify:receipt: passed` | request 11 denied AGENT_QUARANTINED with none earlier, agent QUARANTINED, holds released, no command, a later request denied, export verifies |
| `pnpm demo:replay -- scenario-d-lost-response --runs 3` | 3 runs × 11 checks passed on three fresh aliases; every export verifies (21 events, 1 fill each) | dropped response, restart, recovery: one submission, stable client order id, EXPIRED 0.12 / 12, fee 0.012, lease consumed 12.012, hold 12.012 consumed / 8.008 released, no replacement order; three isolated runs (T-60), each export verifies |
| `pnpm run doctor` | all required checks passed | |

The six verified exports are committed under `docs/evidence/replays/` (one per replay above). Re-verify any of them with `pnpm verify:receipt -- docs/evidence/replays/<file>`.

## 2026-09-08 — Gate 5 operator experience

Subsequent independent corrections and the combined 415-test / 7-browser-test
run are recorded in [G5 review evidence](g5-fix-test-evidence.md). The following
table and screenshot describe the original G5 baseline.

Environment: as Gate 4, plus Playwright 1.63.0 with the locally installed Chromium.

| Command | Result | What it covers |
|---|---|---|
| `pnpm lint` / `pnpm typecheck` (kernel, agents, tests, console) | clean | |
| `pnpm test:unit` / `pnpm test:property` / `pnpm test:contracts` | 181 / 7 × 400 / 90 passed | unchanged; unit count includes the G4 review session's new suites |
| `pnpm test:integration` | 128 passed, 3 skipped (online, opt-in); run the integration and browser suites sequentially, they share the database | earlier suites (including the G4 review session's reconciliation-safety, recovery-safety, and quote-attribution suites) plus `console.test.ts`: overview sums (available versus reserved quote before, during, and after a settled fill), the decision document behind a proposal and its intent (receipt checks, fingerprint, reservations, approvals, command → order → fills → ledger), 404 for unknown ids, event pages from a durable cursor with no gap or duplicate and a verified hash chain, SSE catch-up from genesis and from the last seen sequence with no repeats (T-53) |
| `pnpm test:e2e` | 2 passed (Chromium, about 9 s after the kernel and Vite start) | real kernel (fresh REPLAY alias) and Vite console: login, Scenario A counterproposal (0.27 SOL) appears as `AWAITING_APPROVAL`, approve button disabled until the explicit confirmation, exact approval, command shown `ACCEPTED` with reconciled fill events on the timeline, receipt export download, reload without duplicated events; stop shows `PAUSED`, readiness-gated resume returns `READY` |
| `pnpm build` | clean; console bundle 281 kB JS (83 kB gzip), 12.8 kB CSS | typecheck plus the production console bundle |
| `pnpm run doctor` | all required checks passed | |
| found by the browser tests | two console-only bugs: Vite's string proxy shorthand rewrites the Host header (`changeOrigin`), so every browser mutation failed the kernel's same-origin CSRF check until the proxy kept the original Host; under React StrictMode the modal's queued `close` event fired after the effect re-opened the dialog and closed the stop dialog immediately (fixed by ignoring `close` while the dialog is open). A cookie session now survives a reload via `GET /v1/auth/session`, which re-issues the CSRF token. | |

The screenshot `docs/evidence/console-after-settlement.png` is taken by the browser test after the fill settles.

## 2026-09-08 — Gate 4 execution, reconciliation, recovery, observations

Environment: as Gate 3. Live network reads in this section went to `https://data-api.binance.vision` (public Spot REST, GET only, no credentials).

| Command | Result | What it covers |
|---|---|---|
| `pnpm lint` / `pnpm typecheck` | clean | |
| `pnpm test:unit` | 159 passed | previous suites plus the Binance public REST adapter (fake fetch: parsing, canonical decimals, filter mapping, T-49 GET-only/allowlisted-host/no-credential evidence, 429 without retry, cache, host refusal) and the strategy runner (context stripping, strict output validation incl. an override field and prompt-injection text as data, exactly one repair round, MODEL_TIMEOUT, deterministic idempotency key, NO_PROPOSAL on provider failure, stale context_hash refusal, dry-run never submits) |
| `pnpm test:property` | 7 × 400 runs passed | |
| `pnpm test:contracts` | 90 passed | |
| `pnpm test:integration` | 97 passed, 3 skipped (online adapter tests, opt-in) | all earlier suites plus the reconciliation suite below, rebased onto the review session's G3 authority fixes (durable operator requests, dispatch-safety, invalid-lease, operator-safety, proposal-safety, account-control-safety suites); their readiness, seed-safety, and account-control-safety suites adjusted for boot recovery, the SHADOW adapter, and in-transaction settlement (the last one now uses a paper fill-detail-lag fault to obtain an accepted-but-unsettled command) |
| `MK_ONLINE_TESTS=1 pnpm exec vitest run --project integration tests/integration/integrations` | 3 passed | live SOLUSDT depth and exchangeInfo through the read-only adapter |
| `pnpm run doctor` | all required checks passed | |
| manual REPLAY: `pnpm dev` (alias `g4-replay-002`), `pnpm demo:seed`, HTTP driver | intent → sweep → approve → dispatch → command `ACCEPTED` with `reconciled_at`; order FILLED 0.07 SOL @ 100; ledger FILL_BASE +0.07 SOL, FILL_QUOTE −7 USDT, FILL_FEE −0.007 USDT; balances USDT 110 → 102.993, SOL 2.2275 → 2.2975; Alpha attribution 0.07 SOL; lease consumed 7.007; status unresolved 0, ready; venue journal written to `.moneykernel/paper-venue-REPLAY-g4-replay-002.json` | the real process incl. the 1 s reconciliation loop |
| manual SHADOW: `MONEYKERNEL_MODE=SHADOW` (alias `g4-shadow-002`), `pnpm demo:seed scenario-d-lost-response`, HTTP driver | context observation `BINANCE_PUBLIC_REST` SOLUSDT bid 102.62 / ask 102.63 (live); 20 USDT BUY → `COUNTERPROPOSE` 0.194 SOL @ 102.94 (`SIZE_NORMALIZED`); approve → dispatch → paper fill on the live book 0.194 SOL for 19.91022 USDT, fee 0.01991022; lease consumed 19.93013022; USDT 1000 → 980.06986978; status market_data `CONNECTED` with `last_successful_read_at`, execution `CONNECTED` (paper), unresolved 0 | live market context with virtual funds; no order left the process |
| manual SHADOW with scenario A holdings (alias `g4-shadow-001`) | 20 USDT SOL BUY denied `SYMBOL_EXPOSURE_LIMIT`, `FILTER_LOT_RANGE`: at live prices (BTC ≈ 78k) the seeded 2.2275 SOL already exceeds the 25 % share, so the largest valid candidate falls under the lot minimum and nothing is rounded up | the evaluator against live marks |
| historical manual SHADOW submission through `--provider agent-session --proposal ... --context-in ...` | The saved proposal says it was authored from an 08:11:29Z context and rebound to the 08:16:08Z dump. Its quoted book differs from that dump. The runner accepted the supplied hash and the kernel returned 201 `COUNTERPROPOSE` 0.145 SOL @ 102.8 (`SIZE_NORMALIZED`, mark 102.68); the saved outcome records approval, dispatch, paper fill and reconciliation. All original JSON artifacts remain under `docs/evidence/model-runs/`; its README explains the evidence limitation. The fresh dump-to-submission interval does not prove when the model consumed the context. | submission and paper execution evidence; unverified as a model proposal generated from the claimed fresh context |
| found and fixed during the SHADOW smoke | the dispatcher's `COMMAND_ARMED` audit payload formatted the price-drift ratio with `toDecimalString`, which throws on a non-terminating ratio; every dispatch failed once the live mark moved off the proposal's reference mark. Now `toDisplayString` (18 dp). Also a doctor secret-scan false positive on a test placeholder key (shortened). | a bug only live prices could surface; fixture marks never drift |

Reconciliation suite (`tests/integration/kernel/reconciliation.test.ts`), real PostgreSQL, REPLAY adapters, virtual clock, in-memory paper venue journal shared across simulated restarts:

- Full fill in the dispatch transaction (FR-08, INV-08, T-39): balances, attribution, lease consumption 20.02, ATTEMPT and QUOTE holds CONSUMED, `reconciled_at` set, readiness true, `GET /v1/commands/:id` shows order, one fill, three ledger entries with continuous sequence; re-applying the same fill identity is a no-op (duplicate_fills 1, balances unchanged); operator reconcile of a settled command is NOT_APPLICABLE; submit count stays 1; the agent's context shows the consumed budget (T-16 hook); audit chain verifies.
- T-40 partial IOC fill then expiry (scenario D book): executed 0.12 SOL / 12 USDT, fee 0.012, hold split into CONSUMED 12.012 and RELEASED 8.008, USDT 987.988, lease consumed 12.012.
- Scenario D (prd.md 27.4; T-35, T-38): dropped response → OUTCOME_UNKNOWN, RECONCILING, CRITICAL incident, hold ARMED, one submission; crash and restart with the venue's memory → boot recovery reconciles the same client order id, order EXPIRED with the 0.12 fill, hold settled 12.012 / 8.008, incident resolved, account PAUSED, epoch 2, readiness true, submit count still 1, exactly one venue order; operator resume returns READY; audit chain verifies.
- T-37 / T-36 / T-42: a command ARMED before a crash that the venue never saw becomes OUTCOME_UNKNOWN with a CRITICAL incident, readiness blocked, hold ARMED; background re-queries are deferred by backoff and report STILL_UNKNOWN without any submission; the lease expiring during the unknown period leaves the armed hold and creates no new command; resume is refused (409); operator reconcile reports STILL_UNKNOWN; a later restart with the venue's real memory (T-38) settles it.
- SHADOW wiring (T-49): boot selects the read-only public REST adapter and a live-book paper executor and makes zero requests at boot.

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
