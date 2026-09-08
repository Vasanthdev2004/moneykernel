# Demo script (prd.md 23.1, 23.2)

> AI agents can propose trades. MoneyKernel decides whether they have the authority and resources to act, and records the result.

Four scenes, each on its own fresh REPLAY account so nothing leaks between them (prd.md 27.5). Every number on
screen comes from the kernel's database; the console holds no authority. Captions to overlay: `SYNTHETIC FIXTURE`
for REPLAY market data, `PAPER EXECUTION` for fills, `SYNTHETIC FAULT SCENARIO` for scene D. No caption may say
"live MCP data": this build reads Binance public REST in SHADOW mode and has no Agent OS session (Gate 0).

## Rehearsal (automated, three consecutive runs)

```bash
docker compose up -d db && pnpm db:migrate
pnpm demo:rehearse            # playwright.rehearsal.config.ts, repeat-each 3, screenshots under docs/evidence/demo/
```

The rehearsal starts a kernel per scene, seeds the scene's fixture, submits the agents' intents through the agent
API, and performs every operator action through the console. It fails if any scene's backend state differs from
the fixture's `expected` block.

## Manual recording (about 90 seconds)

Prepare: `pnpm dev:web` in one terminal; the console at http://127.0.0.1:5173. For each scene start the kernel in a
second terminal with a fresh alias, seed, and log in with `OPERATOR_BOOTSTRAP_SECRET`. The agent side is driven by
`pnpm demo:scene -- <scene>`, which prints the intents it submits and pauses where the operator must act.

| Time | Scene | Do | Evidence on screen |
|---|---|---|---|
| 0–10 s | Mode and connection | Show the top bar | `REPLAY · SYNTHETIC FIXTURE`, `MCP · BLOCKED` (honest Gate 0 outcome), `EXEC · CONNECTED` (paper), status strip `READY`, epoch |
| 10–30 s | Constrained acquisition (scenario A) | `MONEYKERNEL_ACCOUNT_ALIAS=demo-a pnpm dev`, `pnpm demo:seed scenario-a-constrained-acquisition`, `pnpm demo:scene -- a`; open the proposal, tick the confirmation, approve | Request 80 USDT vs exact candidate `0.27 SOL @ 100`, limiting rule `SYMBOL_EXPOSURE_LIMIT`, fee reserve 0.027, receipt checks; command `ACCEPTED · NOT FILLED` then `FILL_RECONCILED` on the timeline; balances move by exactly 27.027 |
| 30–45 s | Opposing pending agents (scenario B) | `demo-b` kernel, seed B, `pnpm demo:scene -- b`; open Conflict review, select Alpha's BUY | Both proposals `CONFLICT_HELD`; after SELECT the winner is a new revision `AWAITING_APPROVAL`, the loser's holds are released, nothing armed |
| 45–60 s | Scripted chaos burst (scenario C) | `demo-c` kernel, seed C, `pnpm demo:scene -- c` | Eleven distinct requests; the 11th is denied `AGENT_QUARANTINED`; agent shows `QUARANTINED`; a CRITICAL incident; reserved quote back to 0; a later request stays denied |
| 60–78 s | Response loss and restart (scenario D) | `demo-d` kernel, seed D, `pnpm demo:scene -- d` (arms the synthetic dropped-response fault), approve in the console, then stop the kernel with Ctrl+C and start it again with the same alias, log in, resume | Command `OUTCOME UNKNOWN` with the amber banner and a CRITICAL incident; after the restart the same client order id is `ACCEPTED`, order `EXPIRED` with 0.12 SOL filled, hold split 12.012 consumed / 8.008 released, incident resolved, account `PAUSED` until Resume; the venue journal shows one submission |
| 78–90 s | Evidence and close | Export run, run `pnpm verify:receipt -- <file>` in the terminal | `verify:receipt: passed` with the nine checks; test summary; repository; "Give AI agents capital, not blind trust" |

## Claims to make and not make (prd.md 23.3)

Say: limits new spending authority, coordinates pending intents, requires exact human approval, quarantines an
agent, reconciles a dropped response in this test, records verifiable decisions.

Do not say: guaranteed maximum loss, impossible to hack, production-ready, exactly-once execution under every
failure, risk-free autonomous trading, saved real money.

## Before recording (prd.md 23.5, 26)

- `pnpm run doctor` passes; `.env` is not tracked; no secret in any terminal you show.
- Fresh clone starts (`docs/test-evidence.md`, Gate 7 row).
- Screenshots in `docs/evidence/demo/` match the backend events of the same rehearsal run.
- Verify the entry survey fields on the official announcement page before the final window.
