# Evidence package (prd.md 23.4)

Everything here was produced by the code in this repository against real backend state; nothing is
hand-written except these README files. Timestamps are UTC.

| Path | What it is | How it was produced |
|---|---|---|
| `console-after-settlement.png` | The operator console after an exact approval settled as a paper fill | Captured by the Playwright test `tests/e2e/console.spec.ts` (`pnpm test:e2e`) |
| `model-runs/` | Strategy-runner traces for the supported-agent-session route, with the review session's classification of what they do and do not prove | `pnpm agent:run` (see `model-runs/README.md`) |
| `g4-review-model-run/` | The review session's qualifying model run with the exact context, unmodified output, trace, and receipt | Review session, see its README |
| `replays/` | Sanitized run exports produced by `pnpm demo:replay`, each verified offline by `pnpm verify:receipt` | `pnpm demo:replay -- <scenario-id>`; copy of `.moneykernel/replays/<alias>/export.json` |

The export query excludes token hashes. Export-time screening rejects known credential shapes and
configured secret values; the offline verifier checks credential shapes without access to configuration.
Neither scanner can identify every arbitrary secret in prose. Historical artifacts remain unchanged;
the independent review is recorded in `docs/g6-fix-test-evidence.md`.
`docs/test-evidence.md` records the commands and counts behind every gate.
