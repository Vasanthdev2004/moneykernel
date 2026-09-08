# Development and qualification

Run commands in this document from the repository root. For the recorded submission, use the [current README](../README.md) and [submission package](submission/README.md). The four-scene rehearsal below is separate REPLAY evidence, not the primary live-market video.

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

The [demo script](demo-script.md) covers four scenes in about 90 seconds: constrained counterproposal, opposing intents, chaos burst quarantine, and dropped response with crash and restart. `pnpm demo:rehearse` runs the real console three times with fresh accounts, saving each scene's screenshots, sanitized export and verification result under `docs/evidence/demo/<run>/`. Scene D deliberately simulates a lost submit response and unavailable order queries until restart, then checks the original command/client order ID and one venue submission. This optional REPLAY-only query outage makes the unknown state visible for recording; normal reconciliation can recover without a restart.

For manual recording, follow the script's PowerShell setup so the kernel and seed process share the same fresh alias and matching `REPLAY_FIXTURE`. Seed output contains agent credentials and is redirected to the private, gitignored `.moneykernel/` directory. `pnpm demo:scene -- <a|b|c|d> --seed <seed-output.json>` drives the agent side while you operate the console. Scene D's dropped response uses `POST /v1/demo/faults`, which exists only in REPLAY.

### Replay and verification (prd.md 22.2)

```bash
pnpm demo:replay -- scenario-d-lost-response --runs 3   # isolated virtual runs, expectations checked, export verified
pnpm verify:receipt -- .moneykernel/replays/<alias>/export.json
```

`demo:replay` needs the database and `.env` (REPLAY mode) but no exchange or model access. `--runs` must be a positive integer; `--keep-alias` is for a single fresh account. `verify:receipt` needs only the export file and the installed repository dependencies: it verifies the event hash chain, receipt fingerprints and audit linkage, replays available contexts through the matching evaluator, checks financial authority and accounting, and screens for credential patterns. The operator console exports one consistent database snapshot from `GET /v1/runs/current/export`; unsafe content makes the download fail rather than rewriting signed evidence.

For verification against an independently retained final event hash, add `--head-checkpoint <sha256>`. The older `--checkpoint` option identifies the preceding event of a chain slice; it does not authenticate the final event, and a slice cannot establish complete account-row coverage. Without an independent final hash, a successful report establishes internal consistency only. Legacy receipts with no archived context are explicitly counted as fingerprint-only.

## Known limitations (prd.md 23.4, 26)

Implemented P0 behaviour is what the tests above exercise. The following is not claimed:

- **Agent OS MCP.** The backend owns no Agent OS session (Gate 0: Binance's authorization server admits only allowlisted agents). Market context comes from Binance's public Spot REST endpoints and is labelled `BINANCE_PUBLIC_REST`. The Binance plugin from Codex's recommended catalog was exercised for a live read-only observation, captured with exact tool provenance; that observation is submission evidence rather than a backend execution input.
- **Model route.** No provider key was available, so the Anthropic provider is tested only against a fake endpoint. The [independent supported-session run](evidence/g4-review-model-run/README.md) preserves a real model proposal and its exact context; the kernel denied it for stale data and unsupported filters. The older `model-runs/` artifacts do not prove generation from their claimed fresh context. Receipt-to-run model provenance remains incomplete; the runner trace documents what the supported session actually did.
- **Testnet.** P1. The Spot Testnet read adapter exists; execution is unqualified and refuses to start. Nothing here proves any exchange's behaviour; the paper venue is a demonstration model, not a market-impact or profitability backtest.
- **Fees and filters.** Admission uses the qualified quote-fee envelope. Reconciliation accounts for observed quote/base commissions and reports fee-model mismatches; another fee asset opens a CRITICAL incident and keeps the hold. `PRICE_FILTER`, `LOT_SIZE`, and `NOTIONAL` are enforced. `PERCENT_PRICE`, `PERCENT_PRICE_BY_SIDE`, and `MAX_POSITION` remain unqualified and block Testnet/external execution. SHADOW records and skips those venue-only filters because its construction-time adapter has no exchange write path; its virtual orders still enforce the qualified price, lot and notional fields.
- **Freshness.** Referenced observations must be under 5 s old at admission (policy default), so a slow model path earns `STALE_MARKET_DATA` rather than an exemption.
- **Operations.** One kernel instance, no hot failover; operator sessions live in memory (a restart logs everyone out and pauses the account); the event stream polls committed events every 500 ms; the integration, fault, and browser suites share one database and must run one at a time.
- **Evidence.** A successful `verify:receipt` report establishes the checks described above, with complete settlement proof only for reconciled commands. Legacy receipts without context cannot be replayed. A complete history rewrite cannot be detected without an independently retained checkpoint; automated external anchoring remains P2. Credential screening detects known formats and configured values at export time, but cannot recognize every arbitrary secret in prose. No check proves that Binance or a model was honest.
- **Real-money deployment.** No claim of guaranteed maximum loss, exactly-once execution under every failure, or risk-free trading is made. The hardened deployment remains SHADOW-only and cannot place a Binance order (prd.md 23.3).
