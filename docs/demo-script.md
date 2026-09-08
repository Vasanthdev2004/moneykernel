# Demo script (prd.md 23.1, 23.2)

The completed **1:45 SHADOW submission video** and its public download links are in the [submission package](submission/README.md). Its [matching run export](evidence/submission/README.md) passed all nine verifier checks. The instructions below document how to reproduce the product flow and the separate four-scene REPLAY rehearsal.

> AI agents can propose trades. MoneyKernel decides whether they have the authority and resources to act, and records the result.

## Recommended recording: live Binance data, virtual execution

Record the primary product flow in `SHADOW`. The market book is read live from Binance's public Spot endpoints,
the funds are virtual, and the approved order is executed only by the local paper venue. The header and System
page show these boundaries throughout the recording.

Start a fresh SHADOW kernel with the same alias in both terminals, seed the roomy scenario D account, and keep the
one-time virtual agent token in the gitignored `.moneykernel` directory:

```powershell
$env:MONEYKERNEL_MODE = 'SHADOW'
$env:MONEYKERNEL_ACCOUNT_ALIAS = "record-shadow-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
$env:MONEYKERNEL_STATE_DIR = ".moneykernel/$($env:MONEYKERNEL_ACCOUNT_ALIAS)"
pnpm dev
```

```powershell
$env:MONEYKERNEL_MODE = 'SHADOW'
$env:MONEYKERNEL_ACCOUNT_ALIAS = '<copy the alias from terminal 1>'
$env:MONEYKERNEL_STATE_DIR = ".moneykernel/$($env:MONEYKERNEL_ACCOUNT_ALIAS)"
$seedPath = ".moneykernel/$($env:MONEYKERNEL_ACCOUNT_ALIAS).seed.json"
pnpm demo:seed scenario-d-lost-response *> $seedPath
pnpm demo:shadow -- --seed $seedPath
```

Open **System** first: show `SHADOW · VIRTUAL FUNDS`, `BINANCE_PUBLIC_REST` and paper execution. Then open
**Approvals**, explain how MoneyKernel reduced the agent's 50 USDT request to its remaining lease budget, approve
the exact order, and show the live-book paper fill and readable receipt in **Activity**. Finish with the run export
and offline receipt verification. Never describe the virtual fill as an order placed on Binance.

The deterministic REPLAY scenes below remain engineering and fallback evidence for conflicts, quarantine and
restart recovery; they do not need to appear in the primary submission video.

Four scenes, each on its own fresh REPLAY account so nothing leaks between them (prd.md 27.5). Every number on
screen comes from the kernel's database; the console holds no authority. Captions to overlay: `SYNTHETIC FIXTURE`
for REPLAY market data, `PAPER EXECUTION` for fills, `SYNTHETIC FAULT SCENARIO` for scene D. A separate
read-only BTCUSDT observation was captured through the Binance plugin in a supported Codex session;
show its sanitized evidence file before the four deterministic scenes. The backend itself still has no Agent OS session.

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

Use the five console tabs during recording: **Overview** for funds and pending work, **Approvals** for the queue,
conflicts and exact approval drawer, **Agents** for agent and lease controls, **Activity** for commands, incidents,
the full timeline and receipts, and **System** for integration truth, readiness and policy. Advanced controls under
**Manage agent**, **Register agent** and **Issue lease** start closed; expand them only when needed. The header keeps
the mode, account state, **Stop new orders** and **Resume** visible. Open **Workspace menu** for **Export run**,
**Refresh** or **Log out**. The console defaults to light mode; the theme toggle on login and in the header saves
your light/dark preference in this browser. Tabs and the menu use Radix UI, with Lucide icons and self-hosted DM Sans.

| Time | Scene | Do | Evidence on screen |
|---|---|---|---|
| 0–10 s | Mode and connection | Briefly show `docs/evidence/binance-codex-market-observation-20260908T125734Z.json`, then the header and System | The evidence records the exact Binance plugin tool, timestamp, BTCUSDT bid/ask and zero side effects; the app remains honestly labelled `REPLAY · SYNTHETIC FIXTURE`, while System says the backend-owned MCP route is blocked |
| 10–30 s | Constrained acquisition (scenario A) | Prepare `a` with the commands above; in Approvals, open the proposal, tick the confirmation and approve; inspect settlement in Activity | Request 80 USDT vs exact candidate `0.27 SOL @ 100`, limiting rule `SYMBOL_EXPOSURE_LIMIT`, fee reserve 0.027, receipt checks; command `ACCEPTED`, order `FILLED`, one `FILL_RECONCILED` event; quote balance falls by exactly 27.027 |
| 30–45 s | Opposing pending agents (scenario B) | Prepare `b`; in Approvals, open Conflict review and select Alpha's BUY | Both proposals `CONFLICT_HELD`; after SELECT the winner is a new revision `AWAITING_APPROVAL`, the loser's holds are released, nothing armed |
| 45–60 s | Scripted chaos burst (scenario C) | Prepare `c`; follow the script's prompt to submit the later request; show Agents, then the incident in Activity and funds in Overview | Eleven distinct requests; the 11th is denied `AGENT_QUARANTINED`; agent shows `QUARANTINED`; a CRITICAL incident; reserved quote back to 0; a later request stays denied |
| 60–78 s | Response loss and restart (scenario D) | Prepare `d` (the script arms the synthetic fault), approve in Approvals and inspect Activity; restart the kernel as described above, log in, resume | Command `OUTCOME UNKNOWN` with the amber banner and a CRITICAL incident; after restart the same command/client order ID is `ACCEPTED`, order `EXPIRED` with 0.12 SOL filled, hold split 12.012 consumed / 8.008 released, incident resolved, account `PAUSED` until Resume; the venue journal shows one submission |
| 78–90 s | Evidence and close | Open Workspace menu → Export run; run `pnpm verify:receipt -- <file>` in the terminal | `verify:receipt: passed` with the nine checks; test summary; repository; "Give AI agents capital, not blind trust" |

## Claims to make and not make (prd.md 23.3)

Say: limits new spending authority, coordinates pending intents, requires exact human approval, quarantines an
agent, reconciles a dropped response in this test, records verifiable decisions.

Do not say: guaranteed maximum loss, impossible to hack, production-ready, exactly-once execution under every
failure, risk-free autonomous trading, saved real money.

## Before recording (prd.md 23.5, 26)

- `pnpm run doctor` passes; `.env` is not tracked; no secret in any terminal you show.
- Confirm the current fresh-clone REPLAY startup and rehearsal results in [test evidence](test-evidence.md).
- Keep screenshots with the verified export and verification result from the same rehearsal account.
- The [MIT license](../LICENSE) is included. The primary SHADOW recording is complete; the public package links above identify it. Posting and survey submission remain owner steps.
- Describe this as a partial prototype: a supported Codex session produced verified, read-only Binance plugin evidence; backend-owned Agent OS access and the README's other integration gaps remain open.
- Verify the entry survey fields and eligibility, submit the actual video/repository links, check public access, and retain the completion confirmation.
