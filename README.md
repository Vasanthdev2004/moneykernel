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
| G4 execution and observations | Next: fill reconciliation and accounting, restart recovery of unknown outcomes, SHADOW market adapter, real model proposal. |

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

Every kernel restart pauses its account. Seeding cannot resume an existing run; use the operator API for explicit resume.

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
