# MoneyKernel

**Give AI agents capital, not blind trust.**

MoneyKernel is a deterministic capital-control gateway for AI trading agents. Agents propose trades; the kernel checks lease authority, reserves resources atomically, holds opposing pending intents for human review, requires exact single-use human approval, dispatches once, reconciles what actually happened, and records a verifiable decision receipt.

Built for the Binance Agent OS Mini Hackathon (Track A). The complete virtual execution lifecycle and a production-hardened private SHADOW deployment are implemented. SHADOW reads live public Binance market data and executes only against virtual funds. The backend-owned Agent OS route and other documented integration gaps remain unresolved. Recording and submission are still owner steps.

## Status

| Gate | State |
|---|---|
| G0 integration spike | Done. Custom-client Agent OS session blocked by Binance's agent allowlist; supported-agent market read verified through the Binance plugin in Codex. |
| G1 foundation | Done: workspace, frozen contracts, decimal math, migrations, REPLAY boot, doctor. |
| G2 deterministic vertical slice | Done: agent context → intent → pure policy evaluation → atomic reservations → durable receipt, with idempotency and concurrency tests. |
| G3 authority and coordination | Done: operator sessions, exact single-use approval, command arming with dispatch-time rechecks, paper submission, opposing-intent conflicts, deterministic quarantine, stop/resume. See `docs/test-evidence.md`. |
| G4 execution and observations | Implemented: fill accounting, paper venue journal, restart recovery, operator reconciliation, SHADOW public REST reads, and strategy providers. Independent corrections and remaining qualification limits are in [G4 review evidence](docs/g4-fix-test-evidence.md). A supported Codex agent produced a verified read-only Binance plugin observation; backend-owned MCP access, T-26 deferral, and successful fresh model-to-SHADOW execution remain incomplete. |
| G5 operator experience | Implemented and independently reviewed: operations console, exact approvals, agent/lease controls, conflicts, receipts, incidents, commands, integration status, and SSE timeline. Session, cash-buffer, state-label, and responsive fixes have [G5 review evidence](docs/g5-fix-test-evidence.md), including 7 passing browser tests. |
| G6 adversarial hardening | Implemented and independently reviewed: fault layer, consistent complete run exports with credential screening, standalone verification of audit linkage, evaluator replay and financial authority, and offline replays for all four scenarios. See [G6 review evidence](docs/g6-fix-test-evidence.md) for validation and verification limits. |
| G7 release candidate | Rehearsal and recording tooling implemented: four console scenes, screenshots with matching sanitized exports and verifier reports, and a REPLAY-only synthetic fault endpoint. Current rehearsal and fresh-clone results are in [test evidence](docs/test-evidence.md). The [recording script](docs/demo-script.md) and MIT license are included; recording, upload and submission remain owner steps. |

- `prd.md` is the full product requirements document, technical design, and delivery plan.
- `docs/architecture.md` describes the layering, boot sequence, and modes.
- `docs/integration-manifest.json` records the Binance Agent OS integration evidence and its limits.
- `docs/production-shadow.md` is the deployment, monitoring, backup, restore, upgrade, and rollback runbook.
- `docs/production-readiness-evidence.md` records the clean test, container smoke, and image-scan results for that topology.
- `docs/decisions/` is the decision log. `docs/test-evidence.md` records test runs.
- `fixtures/scenarios/` holds the synthetic scenarios from prd.md section 27.
- `spikes/gate0/` is throwaway read-only probe tooling, not product runtime code.

## Quick start (REPLAY, no exchange or model keys)

Prerequisites: Node 24 (see `.nvmrc`), pnpm 12, Docker with Compose.

```bash
pnpm install --frozen-lockfile
cp .env.example .env          # set OPERATOR_BOOTSTRAP_SECRET; change MK_DB_HOST_PORT if 5432 is taken
docker compose up -d db
pnpm db:migrate
pnpm run doctor
pnpm dev                      # kernel on http://127.0.0.1:8080 (account starts PAUSED)
pnpm dev:web                  # console on http://127.0.0.1:5173
```

Tests: `pnpm test:unit`, `pnpm test:property`, `pnpm test:contracts` (no database); `pnpm test:integration`, `pnpm test:fault` (use `DATABASE_URL_TEST`; run them one at a time, they share the database); `pnpm test:e2e` (Playwright, real kernel and console). `pnpm lint`, `pnpm typecheck`, `pnpm build`.

### Try the vertical slice (REPLAY)

Set `MONEYKERNEL_ACCOUNT_ALIAS` in `.env` to a fresh run name, such as `replay-run-001`, before starting `pnpm dev`. With that kernel running, seed Scenario A once and submit the oversized request from prd.md section 27.1:

```bash
pnpm demo:seed
```

The seed prints agent tokens once. Then, as the Alpha agent:

```bash
curl -s http://127.0.0.1:8080/v1/agent/context -H "Authorization: Bearer <token>"
```

Reference a returned `snapshot_id` and the printed `lease_id` in a `POST /v1/agent/intents` with an `Idempotency-Key` header. An 80 USDT SOL BUY comes back `COUNTERPROPOSE` with the exact 0.270 SOL candidate, its fee reserve, the limiting rule, and a receipt id.

Seeding initializes a pristine paused account atomically, records its baseline ledger, and assigns remaining inventory to `UNASSIGNED`. It refuses repeated or concurrent initialization of the same account. For another demo run, stop the kernel, choose a new `MONEYKERNEL_ACCOUNT_ALIAS` in `.env`, start the kernel, and seed that new account. Existing runs, tokens, reservations, and receipts stay in their original namespace. For a different fixture, set `REPLAY_FIXTURE` before starting the kernel and pass the same scenario id to `pnpm demo:seed`.

Approve the exact candidate through the operator API (`POST /v1/auth/session`, then `POST /v1/proposals/:id/approve` with the proposal revision, hash, and account epoch). The dispatcher arms once, the paper venue fills against the fixture book, and the same transaction settles the fill: `GET /v1/commands/:id` shows the order, its fills, and the ledger entries; `GET /v1/ledger` shows balances, attribution, and the journal; `GET /v1/status` reports zero unresolved commands.

Every kernel restart pauses its account and reconciles anything it armed before the restart by asking the venue about the stable client order id; it never resends. The paper venue's own memory lives in `MONEYKERNEL_STATE_DIR` (default `.moneykernel/`, gitignored). Seeding cannot resume an existing run; use the operator API for explicit resume, which requires zero outstanding commands.

### SHADOW mode (live market context, virtual funds, paper fills)

Set `MONEYKERNEL_MODE=SHADOW` and a fresh alias, start the kernel, and seed a scenario as above. Observations come from Binance's public Spot REST endpoints (`data-api.binance.vision`, GET only, no credentials, labelled `BINANCE_PUBLIC_REST`); the paper venue walks the live book at submission. No order ever leaves the process in this mode. Scenario D balances (1000 USDT, no holdings) make a comfortable first run:

```bash
MONEYKERNEL_MODE=SHADOW MONEYKERNEL_ACCOUNT_ALIAS=shadow-run-001 pnpm dev
pnpm demo:seed scenario-d-lost-response
```

### Private SHADOW deployment

The production image serves the built console and API from one HTTPS origin. The supplied Compose topology adds Caddy-managed TLS, a persistent PostgreSQL database, a migration gate, persistent paper-venue state, non-root/read-only application containment, health checks, authenticated metrics, restart handling, and a one-time virtual-account bootstrap. Follow [the production runbook](docs/production-shadow.md). This deployment is for monitored virtual execution; it does not add a Binance account login or mainnet order path.

### Operator console (prd.md section 17)

`pnpm dev:web` serves the console on http://127.0.0.1:5173 and proxies the API to the kernel. Log in with `OPERATOR_BOOTSTRAP_SECRET`; the browser session is an HttpOnly cookie plus a CSRF token held in memory, and every mutation carries an idempotency key. The console uses Radix UI tabs and a workspace menu, Lucide icons, and self-hosted DM Sans. It defaults to light mode; the theme toggle on login and in the header switches to dark mode and saves the preference in this browser.

Five tabs organize the console: **Overview** summarizes funds and pending work; **Approvals** contains the decision queue, conflict review, and exact approval drawer; **Agents** shows agents and leases; **Activity** contains commands, incidents, the full event timeline, and selected receipts; **System** contains integration state, provenance, readiness, policy, and account metadata. The approval drawer compares the original request with the exact candidate, limiting rule and observation age. Receipts retain ordered rule checks, input versions, command → order → fill → ledger linkage, and JSON export. Advanced agent controls stay folded under **Manage agent**, **Register agent**, and **Issue lease** until opened. The header keeps the mode badge, account state, **Stop new orders**, and **Resume** visible; resume still requires readiness and acknowledged incidents. **Workspace menu** contains **Export run**, **Refresh**, and **Log out**. Event reconnection remains visible, and an `OUTCOME_UNKNOWN` banner stays until the command is reconciled. Browser tests: `pnpm test:e2e` (starts a kernel on a fresh REPLAY alias and the Vite server; needs the database and `.env`).

### Strategy runner (prd.md section 16)

The runner in `apps/agents` reads an agent's bounded context, asks a provider for at most one proposal, validates it strictly (one repair attempt), submits it through the agent API, and writes a trace to `.moneykernel/model-runs`. It holds no operator session and no exchange access.

```bash
pnpm agent:run -- --token <mka_...> --provider scripted --role alpha --dry-run
pnpm agent:run -- --token <mka_...> --provider anthropic --role alpha      # needs MODEL_ID and MODEL_API_KEY
pnpm agent:run -- --token <mka_...> --context-out .moneykernel/context.json   # hand the context to a supported agent session
pnpm agent:run -- --token <mka_...> --provider agent-session --proposal proposal.json --role alpha
```

A recorded response is always labelled `RECORDED MODEL RESPONSE`; a provider timeout or invalid output records `NO_PROPOSAL` and never fabricates a decision. The historical submission under `docs/evidence/model-runs/` used a proposal rebound to newer context; it does not verify a model proposal based on that fresh context. See the evidence directory's README for the preserved artifacts and limitation. Binding live-model provenance to archived receipt evidence remains incomplete after G6. An export labels the run `SCRIPTED` only when every registered agent is scripted; otherwise its model source is conservatively `DISABLED`, with individual strategy kinds retained.

### Demo rehearsal and recording (prd.md 23)

The [demo script](docs/demo-script.md) covers four scenes in about 90 seconds: constrained counterproposal, opposing intents, chaos burst quarantine, and dropped response with crash and restart. `pnpm demo:rehearse` runs the real console three times with fresh accounts, saving each scene's screenshots, sanitized export and verification result under `docs/evidence/demo/<run>/`. Scene D deliberately simulates a lost submit response and unavailable order queries until restart, then checks the original command/client order ID and one venue submission. This optional REPLAY-only query outage makes the unknown state visible for recording; normal reconciliation can recover without a restart.

For manual recording, follow the script's PowerShell setup so the kernel and seed process share the same fresh alias and matching `REPLAY_FIXTURE`. Seed output contains agent credentials and is redirected to the private, gitignored `.moneykernel/` directory. `pnpm demo:scene -- <a|b|c|d> --seed <seed-output.json>` drives the agent side while you operate the console. Scene D's dropped response uses `POST /v1/demo/faults`, which exists only in REPLAY.

### Replay and verification (prd.md 22.2)

```bash
pnpm demo:replay -- scenario-d-lost-response --runs 3   # isolated virtual runs, expectations checked, export verified
pnpm verify:receipt -- .moneykernel/replays/<alias>/export.json
```

`demo:replay` needs the database and `.env` (REPLAY mode) but no exchange or model access. `--runs` must be a positive integer; `--keep-alias` is for a single fresh account. `verify:receipt` needs only the export file and the installed repository dependencies: it verifies the event hash chain, receipt fingerprints and audit linkage, replays available contexts through the matching evaluator, checks financial authority and accounting, and screens for credential patterns. The operator console exports one consistent database snapshot from `GET /v1/runs/current/export`; unsafe content makes the download fail rather than rewriting signed evidence.

For verification against an independently retained final event hash, add `--head-checkpoint <sha256>`. The older `--checkpoint` option identifies the preceding event of a chain slice; it does not authenticate the final event, and a slice cannot establish complete account-row coverage. Without an independent final hash, a successful report establishes internal consistency only. Legacy receipts with no archived context are explicitly counted as fingerprint-only.

## Gate 0 outcome (2026-09-08)

- The Binance MCP endpoint (`https://agent.binance.com/mcp/agentic`) requires an OAuth bearer token to open a session, even for market data.
- Its authorization server accepts only allowlisted agent applications (Claude, Claude Code, Codex, ChatGPT, Cursor, VS Code). A custom client using a client ID metadata document was refused at the consent screen: "The AI Agent you are using is not currently supported."
- Therefore the MoneyKernel backend does **not** own an Agent OS session, and this repository does not claim one. A supported Codex session successfully read live BTCUSDT book data through the Binance plugin from Codex's recommended catalog with no account or order permission; the sanitized observation and exact tool provenance are committed under `docs/evidence/`. The kernel still derives execution-critical numbers from its separately labelled public REST reads.
- Spot Testnet public endpoints are reachable; Testnet execution stays P1 and untested until dedicated credentials exist.

## Non-negotiables (from the PRD)

- Safety authority is deterministic application code, never an LLM.
- Default mode is REPLAY: offline fixtures, virtual funds, no exchange credentials.
- SHADOW mode uses real market observations with virtual funds and simulated execution.
- Binance Spot Testnet execution is a P1 extension, only after qualification.
- Mainnet order execution is explicitly excluded from v0.1. `BINANCE_MAINNET_API_KEY`, `LIVE`, and `SKIP_SAFETY_CHECKS` abort startup if present.
- Only order primitive: Spot LIMIT with IOC time-in-force.
- All financial numbers are decimal strings; floats are rejected at the contract boundary.

## Known limitations (prd.md 23.4, 26)

Implemented P0 behaviour is what the tests above exercise. The following is not claimed:

- **Agent OS MCP.** The backend owns no Agent OS session (Gate 0: Binance's authorization server admits only allowlisted agents). Market context comes from Binance's public Spot REST endpoints and is labelled `BINANCE_PUBLIC_REST`. The Binance plugin from Codex's recommended catalog was exercised for a live read-only observation, captured with exact tool provenance; that observation is submission evidence rather than a backend execution input.
- **Model route.** No provider key was available, so the Anthropic provider is tested only against a fake endpoint. The [independent supported-session run](docs/evidence/g4-review-model-run/README.md) preserves a real model proposal and its exact context; the kernel denied it for stale data and unsupported filters. The older `model-runs/` artifacts do not prove generation from their claimed fresh context. Receipt-to-run model provenance remains incomplete; the runner trace documents what the supported session actually did.
- **Testnet.** P1. The Spot Testnet read adapter exists; execution is unqualified and refuses to start. Nothing here proves any exchange's behaviour; the paper venue is a demonstration model, not a market-impact or profitability backtest.
- **Fees and filters.** Admission uses the qualified quote-fee envelope. Reconciliation accounts for observed quote/base commissions and reports fee-model mismatches; another fee asset opens a CRITICAL incident and keeps the hold. `PRICE_FILTER`, `LOT_SIZE`, and `NOTIONAL` are enforced. `PERCENT_PRICE`, `PERCENT_PRICE_BY_SIDE`, and `MAX_POSITION` remain unqualified and block Testnet/external execution. SHADOW records and skips those venue-only filters because its construction-time adapter has no exchange write path; its virtual orders still enforce the qualified price, lot and notional fields.
- **Freshness.** Referenced observations must be under 5 s old at admission (policy default), so a slow model path earns `STALE_MARKET_DATA` rather than an exemption.
- **Operations.** One kernel instance, no hot failover; operator sessions live in memory (a restart logs everyone out and pauses the account); the event stream polls committed events every 500 ms; the integration, fault, and browser suites share one database and must run one at a time.
- **Evidence.** A successful `verify:receipt` report establishes the checks described above, with complete settlement proof only for reconciled commands. Legacy receipts without context cannot be replayed. A complete history rewrite cannot be detected without an independently retained checkpoint; automated external anchoring remains P2. Credential screening detects known formats and configured values at export time, but cannot recognize every arbitrary secret in prose. No check proves that Binance or a model was honest.
- **Real-money deployment.** No claim of guaranteed maximum loss, exactly-once execution under every failure, or risk-free trading is made. The hardened deployment remains SHADOW-only and cannot place a Binance order (prd.md 23.3).

## License

[MIT](LICENSE), copyright 2026 Vasanth.
