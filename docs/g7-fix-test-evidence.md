# G7 independent release review — 2026-09-08

Reviewed G7 `afe3847` with the G6 fixes from `99cd93a`, subsequently merged in `f1b0062`. Work ran in an isolated checkout with a disposable PostgreSQL 17.11 database, five migrations, and separate browser ports. Claude's checkout and historical artifacts were preserved. The user selected MIT; `LICENSE` and package metadata now record that choice.

Final code revision: **`56a44fb5b07b9d9ef5dd1c41122753bc061cd0d8`**, parent `f1b0062`. The validation and final rehearsal below ran against this revision.

## Findings and corrections

The original `pnpm demo:rehearse` passed all 12 scene tests in three rounds. That success did not prove all of the release claims:

- Rehearsals saved screenshots but no export or verifier report from those accounts. Each scene now downloads the complete console export and verifies it before retaining the evidence.
- Scene D counted database commands/fills and matched a quantity by prefix. It now checks exact financial amounts, stable command/client order IDs and a venue submission count of one before and after restart.
- Stronger checks exposed a real recording race in two of three D runs: normal background reconciliation could resolve the order before its unknown-state screenshot or restart. Scene D now explicitly opts into a process-local REPLAY query outage until restart, in addition to the lost submission response. This is labelled synthetic; the accepted venue journal is preserved and ordinary dropped-response behavior is unchanged by default.
- A failed kernel startup could leave its child running. Startup now owns cleanup until it returns successfully; repeated cleanup only stops the owned child. Both frontend and kernel ports are isolated, occupied servers are refused, and missing rehearsal credentials fail instead of skipping the entire gate.
- The manual recording CLI could print approval instructions and exit successfully after an HTTP 422. It now validates HTTP responses, decision shapes, expected scene outcomes and the synthetic fault acknowledgement. Invalid input, response failure and EOF during an operator pause fail promptly without printing credentials or untrusted response bodies. Natural process completion also avoids a reproduced Windows/libuv crash after fetch.
- Recording instructions omitted required seed input and per-scene fixture settings. The PowerShell instructions now carry a fresh alias and matching fixture between terminals, save private seed output as UTF-8, and keep scene D's restart separate from seeding. Stale model/filter and settlement claims were corrected.

The demo fault API's operator authentication, account scoping and non-REPLAY rejection were reviewed. The added fault option has a regression proving repeated queries remain uncertain, then a fresh runtime recovers the same order with one submission. No exchange is contacted by these synthetic tests.

## Validation

- `pnpm test`: **534 passed, 3 opt-in online checks skipped**; 51 test files passed, one skipped.
- `pnpm lint`: **196 files checked, clean**. `pnpm build`: **passed**, including the kernel and web TypeScript checks.
- `pnpm demo:rehearse`: **12/12 passed in 55.8 seconds**, four scenes in each of three consecutive rounds. The final run stamp is `g7-verified-20260908T102850Z`, with `-run1`, `-run2` and `-run3` evidence directories. All twelve scene exports passed the offline verifier.
- Publication checks independently reverified all twelve exports, matched their saved reports and checked all 40 artifact hashes. The shared export scanner found no credential shapes or configured review secrets in the published JSON. After staging the evidence, `pnpm run doctor` passed with 314 tracked files scanned and five migrations applied, none pending.
- New manual-scene tests exercise valid scenes, bad statuses/shapes, unexpected decisions, secret-safe errors, invalid arguments, EOF, and the scene D outage acknowledgement using a local fake HTTP server. The process cleanup regression checks startup failure and repeat cleanup.

The [final rehearsal package](evidence/demo/g7-review.md) retains the complete first round's screenshots and JSON evidence, plus JSON evidence from rounds two and three. Its [manifest](evidence/demo/g7-review-manifest.json) indexes all twelve exports and their verification results. Scene D includes venue journal snapshots before and after restart, each recording one submission and the same client order ID. Earlier screenshots and replay exports remain unchanged.

## Fresh-clone startup proof (T-59)

A separate directory was cloned from **GitHub main**, then fetched the reviewed revision `56a44fb5b07b9d9ef5dd1c41122753bc061cd0d8` from the **local review checkout** and checked it out. The source of that review commit is recorded explicitly because it had not been published on GitHub at the time of this check.

`pnpm install --frozen-lockfile`, all five migrations against a new `moneykernel_fresh` database, `pnpm build`, and `pnpm run doctor` passed. Doctor inspected 271 tracked files. A real kernel and Vite proxy then started from this checkout; Scenario A was seeded into a fresh REPLAY account, returned the exact `0.27 SOL` counterproposal, received exact approval, and settled its paper fill. The exported run passed every verifier check: **17 events, one receipt replayed, one command and one fill**. The [startup result](evidence/demo/g7-fresh-start.json) records the tested revision and HTTP/verification outcomes.

This adds actual migration, startup and execution proof to the original G7 installation/build-only fresh-clone evidence. It requires local database and operator configuration, but no exchange or model credentials.

## Remaining release work

Recording/upload and entry submission/confirmation remain owner steps. A later supported Codex session captured a live read-only observation through the Binance plugin from Codex's recommended catalog at `docs/evidence/binance-codex-market-observation-20260908T125734Z.json`. Backend-owned Agent OS access, receipt-bound model provenance and the README's other integration qualifications remain incomplete. A synthetic REPLAY release candidate is not a claim that all P0 integration requirements or production readiness have been achieved. MIT selection is complete.
