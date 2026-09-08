# 0011 — G7 rehearsal evidence and recording failures

Date: 2026-09-08. Reviewed G7 `afe3847` with the G6 corrections from `99cd93a` (merged in `f1b0062`).

## Problem

The original three-round browser rehearsal passed, but screenshots were not paired with exports from those accounts. Scene D asserted one command and one fill rather than one venue submission, and accepted a filled quantity by string prefix. Stronger checks exposed a recording race: the normal reconciliation loop could resolve the unknown order before its screenshot or restart. The recording helper could print approval instructions and exit successfully after a rejected HTTP request. Startup failure could leave its owned kernel process running, and the rehearsal could reuse another checkout's frontend.

## Decisions

- Download each scene's complete export through the console, verify it offline, and retain its report beside that scene's screenshots. Keep historical evidence unchanged.
- Check scene D's venue submission count and command/client order identity before and after restart, plus exact quantities, fees, reservations and balances. The paper journal establishes synthetic adapter behavior only.
- Let the REPLAY demo explicitly request `hold_queries_until_restart` alongside its dropped response. This process-local synthetic fault makes queries inconclusive until restart while preserving the venue's accepted order and fills. Ordinary dropped-response semantics are unchanged when the option is absent; SHADOW/TESTNET cannot enable it through the demo API. This models a query outage, rather than racing normal recovery or hiding a completed reconciliation.
- Use the existing optional E2E port variables for rehearsals, refuse occupied servers, and close owned subprocesses after failed startup or repeated cleanup.
- Stop the recording helper on failed HTTP responses, unexpected scene decisions, invalid seed/configuration, or end-of-input before an operator pause is completed. Keep credential-bearing input and response bodies out of terminal error messages.
- Document a reproducible PowerShell setup with a matching fixture, fresh account alias and private UTF-8 seed file. A scene D restart keeps the alias and paper journal and does not seed again.
- Add the MIT license selected by the user. Keep recording/upload/submission and unresolved integration qualifications explicit; successful synthetic rehearsals do not establish complete P0 qualification or production readiness.

Fresh-clone and rehearsal results are recorded separately in `docs/g7-fix-test-evidence.md`.
