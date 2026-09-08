# MoneyKernel

**Give AI agents capital, not blind trust.**

MoneyKernel is a deterministic capital-control gateway for AI trading agents. Agents propose trades; the kernel checks lease authority, reserves resources atomically, holds opposing pending intents for human review, requires exact single-use human approval, dispatches once, reconciles what actually happened, and records a verifiable decision receipt.

Built for the Binance Agent OS Mini Hackathon (Track A) as a v0.1 prototype.

## Status

| Gate | State |
|---|---|
| G0 integration spike | Done. Custom-client Agent OS session blocked by Binance's agent allowlist; see below. |
| G1 foundation | Done: workspace, frozen contracts, decimal math, migrations, REPLAY boot, doctor. |
| G2 deterministic vertical slice | Done: agent context → intent → pure policy evaluation → atomic reservations → durable receipt, with idempotency and concurrency tests. |
| G3 authority and coordination | Done: operator sessions, exact single-use approval, command arming with dispatch-time rechecks, paper submission, opposing-intent conflicts, deterministic quarantine, stop/resume. See `docs/test-evidence.md`. |
| G4 execution and observations | Implemented: fill accounting, paper venue journal, restart recovery, operator reconciliation, SHADOW public REST reads, and strategy providers. Independent corrections and remaining qualification limits are in [G4 review evidence](docs/g4-fix-test-evidence.md). Unqualified exchange filters block proposals; MCP access, T-26 deferral, and successful fresh model-to-SHADOW execution remain unverified or incomplete. |
| G5 operator experience | Next: dashboard, approval drawer, conflict panel, incidents, timeline. |

- `prd.md` is the full product requirements document, technical design, and delivery plan.
- `docs/architecture.md` describes the layering, boot sequence, and modes.
- `docs/integration-manifest.json` records the Binance Agent OS integration evidence and its limits.
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

Tests: `pnpm test:unit`, `pnpm test:property`, `pnpm test:contracts` (no database); `pnpm test:integration`, `pnpm test:fault` (use `DATABASE_URL_TEST`). `pnpm lint`, `pnpm typecheck`, `pnpm build`.

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

### Strategy runner (prd.md section 16)

The runner in `apps/agents` reads an agent's bounded context, asks a provider for at most one proposal, validates it strictly (one repair attempt), submits it through the agent API, and writes a trace to `.moneykernel/model-runs`. It holds no operator session and no exchange access.

```bash
pnpm agent:run -- --token <mka_...> --provider scripted --role alpha --dry-run
pnpm agent:run -- --token <mka_...> --provider anthropic --role alpha      # needs MODEL_ID and MODEL_API_KEY
pnpm agent:run -- --token <mka_...> --context-out .moneykernel/context.json   # hand the context to a supported agent session
pnpm agent:run -- --token <mka_...> --provider agent-session --proposal proposal.json --role alpha
```

A recorded response is always labelled `RECORDED MODEL RESPONSE`; a provider timeout or invalid output records `NO_PROPOSAL` and never fabricates a decision. The historical submission under `docs/evidence/model-runs/` used a proposal rebound to newer context; it does not verify a model proposal based on that fresh context. See the evidence directory's README for the preserved artifacts and limitation. Receipts keep the provenance labels decided in `docs/decisions/0003-g2-verification-fixes.md` until G6 binds live-model labels to run evidence.

Commands the PRD requires but a later gate implements (`demo:replay`, `verify:receipt`, `test:e2e`) exit with code 2 and say so.

## Gate 0 outcome (2026-09-08)

- The Binance MCP endpoint (`https://agent.binance.com/mcp/agentic`) requires an OAuth bearer token to open a session, even for market data.
- Its authorization server accepts only allowlisted agent applications (Claude, Claude Code, Codex, ChatGPT, Cursor, VS Code). A custom client using a client ID metadata document was refused at the consent screen: "The AI Agent you are using is not currently supported."
- Therefore the MoneyKernel backend does **not** own an Agent OS session, and this repository does not claim one. Real Agent OS observations can still be obtained through a supported agent session and passed to the kernel with explicit provenance; the kernel treats such data as untrusted agent context and derives execution-critical numbers from its own separately labelled public REST reads.
- Spot Testnet public endpoints are reachable; Testnet execution stays P1 and untested until dedicated credentials exist.

## Non-negotiables (from the PRD)

- Safety authority is deterministic application code, never an LLM.
- Default mode is REPLAY: offline fixtures, virtual funds, no exchange credentials.
- SHADOW mode uses real market observations with virtual funds and simulated execution.
- Binance Spot Testnet execution is a P1 extension, only after qualification.
- Mainnet order execution is explicitly excluded from v0.1. `BINANCE_MAINNET_API_KEY`, `LIVE`, and `SKIP_SAFETY_CHECKS` abort startup if present.
- Only order primitive: Spot LIMIT with IOC time-in-force.
- All financial numbers are decimal strings; floats are rejected at the contract boundary.

## License

Not yet selected by the product owner. There is no LICENSE file in this repository yet.
