# Evidence package (prd.md 23.4)

Screenshots, run exports and verification reports below come from recorded backend runs. Model artifacts have
their own provenance notes, including preserved unmodified proposals and the limits of historical captures.
Timestamps are UTC; older artifacts remain unchanged.

| Path | What it is | How it was produced |
|---|---|---|
| `console-after-settlement.png` | The operator console after an exact approval settled as a paper fill | Captured by the Playwright test `tests/e2e/console.spec.ts` (`pnpm test:e2e`) |
| `model-runs/` | Strategy-runner traces for the supported-agent-session route, with the review session's classification of what they do and do not prove | `pnpm agent:run` (see `model-runs/README.md`) |
| `g4-review-model-run/` | The review session's qualifying model run with the exact context, unmodified output, trace, and receipt | Review session, see its README |
| `replays/` | Sanitized run exports produced by `pnpm demo:replay`, each verified offline by `pnpm verify:receipt` | `pnpm demo:replay -- <scenario-id>`; copy of `.moneykernel/replays/<alias>/export.json` |
| [G7 rehearsal package](demo/g7-review.md) | Final three-round console rehearsal at code revision `56a44fb5b07b9d9ef5dd1c41122753bc061cd0d8`: 12/12 scenes passed in 55.8 s, all twelve exports verified | `pnpm demo:rehearse`, stamp `g7-verified-20260908T102850Z`; round 1 retains screenshots and JSON, rounds 2–3 retain JSON |
| [G7 evidence manifest](demo/g7-review-manifest.json) | Index of the retained scene exports, verification results and supporting artifacts | Final rehearsal packaging; scene D includes venue snapshots with the same client order ID and one submission before and after restart |
| [G7 fresh-start result](demo/g7-fresh-start.json) | Real kernel and Vite proxy startup, seed, exact 0.27 SOL approval, settlement and verified export: 17 events, one receipt and one fill | Separate GitHub-main clone, then local fetch/checkout of review commit `56a44fb`; frozen install, five migrations on a new database, build and doctor passed |

The export query excludes token hashes. Export-time screening rejects known credential shapes and
configured secret values; the offline verifier checks credential shapes without access to configuration.
Neither scanner can identify every arbitrary secret in prose. Historical artifacts remain unchanged;
the independent review is recorded in `docs/g6-fix-test-evidence.md`.
[Test evidence](../test-evidence.md) records the commands and counts behind every gate; the
[G7 review](../g7-fix-test-evidence.md) records the final code revision and fresh-clone source precisely.
The [MIT license](../../LICENSE) is included. Recording/upload and submission/confirmation remain owner steps;
the synthetic rehearsal does not establish the outstanding Agent OS or other integration qualifications.
