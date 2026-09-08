# Demo script (prd.md 23.1, 23.2)

> AI agents can propose trades. MoneyKernel decides whether they have the authority and resources to act, and records the result.

Four scenes, each on its own fresh REPLAY account so nothing leaks between them (prd.md 27.5). Every number on
screen comes from the kernel's database; the console holds no authority. Captions to overlay: `SYNTHETIC FIXTURE`
for REPLAY market data, `PAPER EXECUTION` for fills, `SYNTHETIC FAULT SCENARIO` for scene D. No caption may say
"live MCP data": this build reads Binance public REST in SHADOW mode and has no Agent OS session (Gate 0).

## Rehearsal (automated, three consecutive runs)

Configure `.env` as described in the README, including `OPERATOR_BOOTSTRAP_SECRET`. Run the rehearsal with no
other kernel or browser suite using its ports:

```powershell
docker compose up -d db
pnpm db:migrate
pnpm demo:rehearse
```

The rehearsal starts a kernel per scene, seeds the scene's fixture, submits the agents' intents through the agent
API, and performs the trading decisions through the console. It checks each scene's expected backend outcome and
verifies an export from that same account. Screenshots, sanitized exports and verifier results are saved together
under `docs/evidence/demo/<run>/`. Scene D also checks the original command/client order ID and the venue's single
submission across restart. See [test evidence](test-evidence.md) for completed runs.

## Manual recording (about 90 seconds)

Prepare the scenes off camera. Run `pnpm dev:web` in one PowerShell terminal and open http://127.0.0.1:5173.
For each scene, stop the previous kernel, then run this block in a second terminal from the repository root.
Change `$scene` to `a`, `b`, `c` or `d`; it generates a fresh alias and selects the matching fixture.

```powershell
$scene = 'a'
$fixtures = @{
  a = 'scenario-a-constrained-acquisition'
  b = 'scenario-b-opposing-intents'
  c = 'scenario-c-burst-quarantine'
  d = 'scenario-d-lost-response'
}
$env:MONEYKERNEL_MODE = 'REPLAY'
$env:REPLAY_FIXTURE = $fixtures[$scene]
$env:MONEYKERNEL_ACCOUNT_ALIAS = "record-$scene-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
New-Item -ItemType Directory -Path .moneykernel -Force | Out-Null
@{ scene = $scene; alias = $env:MONEYKERNEL_ACCOUNT_ALIAS; fixture = $env:REPLAY_FIXTURE } |
  ConvertTo-Json | Set-Content .moneykernel/recording.json
pnpm dev
```

In a third PowerShell terminal, load those same settings and seed once. The redirected seed output contains agent
credentials: keep it private in the gitignored `.moneykernel/` directory and out of the recording. Log into the
console with `OPERATOR_BOOTSTRAP_SECRET`; the scene command prints decisions and pauses for the console actions.

```powershell
$recording = Get-Content .moneykernel/recording.json -Raw | ConvertFrom-Json
$env:MONEYKERNEL_MODE = 'REPLAY'
$env:MONEYKERNEL_ACCOUNT_ALIAS = $recording.alias
$env:REPLAY_FIXTURE = $recording.fixture
$seedPath = ".moneykernel/$($recording.alias).seed.json"
$seedOutput = pnpm demo:seed $recording.fixture
if ($LASTEXITCODE -ne 0) { throw 'Seed failed; inspect the error before continuing.' }
[System.IO.File]::WriteAllText(
  (Join-Path (Get-Location) $seedPath),
  ($seedOutput -join [Environment]::NewLine),
  [System.Text.UTF8Encoding]::new($false)
)
pnpm demo:scene -- $recording.scene --seed $seedPath
```

The explicit UTF-8 encoding works in Windows PowerShell 5 and PowerShell 7. Scene D opts into
`hold_queries_until_restart: true`: it simulates both a lost submit response and unavailable order queries, so
the unknown banner remains visible until restart. This flag exists only in the REPLAY process, clears on restart,
and leaves the venue journal intact. Without this optional query outage, normal reconciliation may recover before
a restart.

For scene D's restart, press Ctrl+C in the kernel terminal and run **only `pnpm dev` again there**. Keep the same
alias, fixture and state directory; do not rerun setup or seed. The restarted account stays paused until you log
in and explicitly Resume after reconciliation.

| Time | Scene | Do | Evidence on screen |
|---|---|---|---|
| 0–10 s | Mode and connection | Show the top bar | `REPLAY · SYNTHETIC FIXTURE`, `MCP · BLOCKED` (honest Gate 0 outcome), `EXEC · CONNECTED` (paper), status strip `READY`, epoch |
| 10–30 s | Constrained acquisition (scenario A) | Prepare `a` with the commands above; open the proposal, tick the confirmation, approve | Request 80 USDT vs exact candidate `0.27 SOL @ 100`, limiting rule `SYMBOL_EXPOSURE_LIMIT`, fee reserve 0.027, receipt checks; command `ACCEPTED`, order `FILLED`, one `FILL_RECONCILED` event; quote balance falls by exactly 27.027 |
| 30–45 s | Opposing pending agents (scenario B) | Prepare `b`; open Conflict review, select Alpha's BUY | Both proposals `CONFLICT_HELD`; after SELECT the winner is a new revision `AWAITING_APPROVAL`, the loser's holds are released, nothing armed |
| 45–60 s | Scripted chaos burst (scenario C) | Prepare `c`; follow the script's prompt to submit the later request | Eleven distinct requests; the 11th is denied `AGENT_QUARANTINED`; agent shows `QUARANTINED`; a CRITICAL incident; reserved quote back to 0; a later request stays denied |
| 60–78 s | Response loss and restart (scenario D) | Prepare `d` (the script arms the synthetic fault), approve in the console, then restart the kernel as described above, log in, resume | Command `OUTCOME UNKNOWN` with the amber banner and a CRITICAL incident; after restart the same command/client order ID is `ACCEPTED`, order `EXPIRED` with 0.12 SOL filled, hold split 12.012 consumed / 8.008 released, incident resolved, account `PAUSED` until Resume; the venue journal shows one submission |
| 78–90 s | Evidence and close | Export run, run `pnpm verify:receipt -- <file>` in the terminal | `verify:receipt: passed` with the nine checks; test summary; repository; "Give AI agents capital, not blind trust" |

## Claims to make and not make (prd.md 23.3)

Say: limits new spending authority, coordinates pending intents, requires exact human approval, quarantines an
agent, reconciles a dropped response in this test, records verifiable decisions.

Do not say: guaranteed maximum loss, impossible to hack, production-ready, exactly-once execution under every
failure, risk-free autonomous trading, saved real money.

## Before recording (prd.md 23.5, 26)

- `pnpm run doctor` passes; `.env` is not tracked; no secret in any terminal you show.
- Confirm the current fresh-clone REPLAY startup and rehearsal results in [test evidence](test-evidence.md).
- Keep screenshots with the verified export and verification result from the same rehearsal account.
- The [MIT license](../LICENSE) is included. Recording, upload and submission remain owner steps.
- Describe this as a partial prototype: actual Agent OS observation evidence and the README's integration gaps remain open.
- Verify the entry survey fields and eligibility, submit the actual video/repository links, check public access, and retain the completion confirmation.
