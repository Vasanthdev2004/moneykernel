# Architecture

MoneyKernel is a modular monolith with a separate strategy process (prd.md section 12). Policy, reservations, approvals, dispatch state, and accounting share one PostgreSQL consistency boundary.

## Packages and layering

```
apps/web        React + Vite operator console. Renders state and provenance. No financial authority.
apps/kernel     Fastify backend: config, boot, readiness, routes, services, dispatcher, reconciliation, events.
apps/agents     Strategy runner: bounded model calls, proposal generation. No operator tokens, no exchange access.
packages/contracts     Zod schemas, reason codes, canonical JSON + hashing, adapter interfaces. Frozen after Gate 1.
packages/domain        Pure decisions and decimal math (decimal.js). No IO.
packages/persistence   pg pool, transactions, advisory/row locks, sequential SQL migrations, repositories.
packages/integrations  Paper executor, Binance public REST reads, Testnet adapter (P1). Normalization only.
```

Dependency direction: `contracts <- domain <- persistence <- kernel`; `integrations` depends only on `contracts`. The browser and the strategy runner talk to the kernel over HTTP.

## Runtime conventions

- TypeScript strict with `erasableSyntaxOnly`. Node 24 executes `.ts` files directly (type stripping), so there is no build step for the backend; `pnpm build` typechecks and builds the web bundle.
- Every financial number is a canonical decimal string at API boundaries (`canonicalizeDecimal`) and a decimal.js value inside `domain`. `canonicalJson` rejects floats outright.
- Workspace packages export their `src/index.ts` directly; imports of local files carry the `.ts` extension.

## Boot (prd.md 11.8, Gate 1 subset)

1. Load and validate configuration; forbidden options (`BINANCE_MAINNET_API_KEY`, `LIVE`, `SKIP_SAFETY_CHECKS`) abort startup.
2. Reach the database and verify migrations are current; the app never migrates itself (`pnpm db:migrate`).
3. Take the single-writer advisory session lock `moneykernel:writer:<mode>:<alias>` on a dedicated connection. A second process cannot take it; there is no automatic hot failover.
4. Ensure the account row for `(mode, alias)` exists, set it `PAUSED`, and increment its control epoch. Append `ACCOUNT_CREATED` or `ACCOUNT_BOOTED` to the hash-chained audit log.
5. Count armed, unknown, and accepted-but-unreconciled commands; any of them blocks readiness. Accepted commands need a terminal order, no outstanding holds, and `commands.reconciled_at` set by the reconciliation transaction. A terminal response alone does not prove settled accounting.
6. Serve `/health/live`, `/health/ready`, `/v1/status`. The account stays `PAUSED` until an operator resumes it.

## Intent admission (prd.md 28.2, Gate 2)

1. `GET /v1/agent/context` authenticates the agent by token hash, reads fresh observations for the lease's symbols through the mode's market adapter, records each as an immutable snapshot row, and returns their ids.
2. `POST /v1/agent/intents` (with `Idempotency-Key`) parses the intent against the strict contract (422 for bad money, 400 for unknown fields), then refreshes marks for every held asset and the symbol rules outside any transaction.
3. Inside one transaction: lock the account row, then the agent and lease rows; re-check idempotency; assemble the evaluator input (policy version, lease, balances, attribution, outstanding reservations excluding nothing yet, pending BUY exposure, fresh marks); run the pure evaluator; insert the intent, receipt, proposal (`COLLECTING`), reservations (QUOTE + ATTEMPT for BUY, BASE + ATTEMPT for SELL), and audit events; commit.
4. The response is the decision receipt view; the same key and payload replay it with 200, a different payload gets 409.

The account row lock serializes every resource claim, which is what keeps two concurrent 80 USDT requests from both reserving a 100 USDT pool.

## Coordination and authority (Gate 3)

- Operator sessions (`POST /v1/auth/session`) exchange the bootstrap secret for an in-memory session: bearer token for API clients, HttpOnly cookie plus `X-CSRF-Token` and same-origin check for browsers. Every operator route sits behind it, including `/v1/status`.
- A background sweep runs every 250 ms: it expires pre-arm proposals past their TTL and promotes `COLLECTING` proposals whose 750 ms window elapsed to `AWAITING_APPROVAL`, or into a conflict when an opposite-side candidate on the same symbol is still pre-arm. Conflict members are `CONFLICT_HELD`; unused approvals are invalidated and READY commands aborted.
- Approval binds to proposal revision, hash, account epoch, policy version, lease revision; it is single-use and creates the READY command with a deterministic `mk_…` client order id. Mismatches are refused, never reinterpreted.
- The dispatcher arms one READY command per pass: refresh inputs outside the transaction, recheck every authority and freshness condition inside it (including price drift against the proposal's mark and a re-evaluation of the exact approved order), consume the approval and attempt slot, commit, then send the exact persisted payload once. Observed outcomes are persisted as ACCEPTED (order + fills), REJECTED_CONFIRMED (holds released), or OUTCOME_UNKNOWN (reservations retained, account RECONCILING, incident opened).
- Quarantine triggers on more than 10 unique intents or 3 hard authority violations in a trailing 60 s window, or by operator action; it invalidates the agent's pre-arm proposals, releases only never-armed holds, and opens a CRITICAL incident. Stop pauses the account, bumps the epoch, ends pre-arm candidates, and lists in-flight commands whose outcomes may still change. Resume is readiness-gated.

## Execution, reconciliation, recovery (Gate 4)

- The venue response is persisted and reconciled in one transaction (prd.md 11.3 step 9, 28.3). Each fill is inserted by its external identity; only a newly inserted fill appends ledger entries (`FILL_BASE`, `FILL_QUOTE`, `FILL_FEE`), moves controlled balances and the agent's attribution, and adds executed BUY cost plus quote fee to the lease's consumed budget. The ledger's unique index on (fill, category, asset) makes a second application impossible (T-39). SELL proceeds credit the account's quote balance and never replenish acquisition budget (T-16).
- On a terminal order whose fill detail matches the venue's totals, the armed hold is settled: the executed part stays as `CONSUMED`, the unfilled remainder becomes a separate `RELEASED` row (T-40), and `commands.reconciled_at` is stamped. Mismatched totals or an unsupported fee asset open an incident and keep the hold as a conservative buffer (T-45).
- The paper venue (`paper-2`) walks the observed book within the limit, applies the configured fee model, expires the IOC remainder, and keeps its own journal under `MONEYKERNEL_STATE_DIR` (`.moneykernel/paper-venue-<mode>-<alias>.json`), written before any response leaves. Liquidity consumption is keyed by book observation.
- Boot recovery (prd.md 11.8): after pausing the account and advancing the epoch, every armed, unknown, or unsettled command is queried at the venue by its stable client order id and reconciled; nothing is ever resent. A command still `ARMED` that the venue does not know becomes `OUTCOME_UNKNOWN` with a CRITICAL incident (T-37); `NOT_FOUND` never means rejected (T-36). Stale approvals are invalidated; proposals they covered and proposals whose TTL elapsed end with their never-armed holds released; other pre-arm proposals keep their holds until their own TTL. Armed holds are never touched by pre-arm paths (T-42).
- A background pass re-queries unsettled commands with exponential backoff, at most six times; `POST /v1/commands/:id/reconcile` lets an operator continue. Settling the last outstanding command moves a `RECONCILING` account to `PAUSED` (`ACCOUNT_RECONCILED`); `POST /v1/account/resume` requires zero outstanding commands and no unacknowledged CRITICAL incident.
- `GET /v1/commands/:id` returns the command, its observed order, recorded fills, and the ledger entries they produced; `GET /v1/ledger` returns balances, attribution, and the journal.
- SHADOW reads the live book through a read-only Binance public REST adapter (`BINANCE_PUBLIC_REST`, GET only, allowlisted hosts, no credentials); the paper venue then walks that live book. TESTNET uses the same adapter against Spot Testnet for reads only.
- The strategy runner (`apps/agents`, prd.md 16) turns an agent's bounded context into at most one intent per run through a provider (scripted, recorded, Anthropic Messages API, or a supported agent session bound to the context hash), validates strictly with one repair attempt, records a trace, and submits through the agent API only.

## Operator console (Gate 5, prd.md 17)

- `apps/web` is a React console served by Vite in development (proxying `/v1` and `/health` to the kernel) and from the kernel's origin in deployment. It renders state and provenance and holds no financial authority: every decision is an operator API call with the session cookie, `X-CSRF-Token`, and an `Idempotency-Key` per click.
- Console reads live in `apps/kernel/src/routes/console.ts`: `GET /v1/overview` (status strip: balances, summed outstanding holds, available versus reserved quote, pending approvals, open conflicts and incidents, command counts, readiness), `GET /v1/events?after=<seq>` (a page of the hash-chained log from a durable cursor, or `?tail=1` for a first paint), `GET /v1/events/stream` (SSE: `id` is the account sequence, `event` the audit type, catch-up from `after` or `Last-Event-ID`, 500 ms polling of committed events, heartbeats), and `GET /v1/intents/:id` / `GET /v1/proposals/:id` (the decision document: intent, every receipt with ordered rule checks and input versions, proposals with reservations and approvals, command, order, fills, ledger entries).
- The stream explains state; it is never a command channel. Deliveries may repeat, so the browser deduplicates by event id and resumes from the last sequence after a disconnect (T-53).
- Mandatory state distinctions (prd.md 17.4) are carried by the data, not the UI: `COUNTERPROPOSE` is an outcome, `AWAITING_APPROVAL` a proposal state, `APPROVED`/`COMMAND_CREATED` precede arming, `ACCEPTED` is a command state distinct from the order's `FILLED`/`EXPIRED`, and an `OUTCOME_UNKNOWN` banner stays until the command reconciles.
- Browser tests (`pnpm test:e2e`, Playwright) start a kernel on a fresh REPLAY alias and the Vite server, seed Scenario A, and drive login, exact approval, settlement, receipt export, stop, readiness-gated resume, and reload catch-up.

## Modes (prd.md 13.1)

| Mode | Market context | Funds and orders | Adapter selected at construction time |
|---|---|---|---|
| REPLAY | Synthetic or archived fixtures (`SYNTHETIC_FIXTURE`) | Virtual, deterministic | Fixture market adapter + paper executor over the fixture book |
| SHADOW | Binance public REST reads (`BINANCE_PUBLIC_REST`, read-only) | Virtual ledger, paper fills on the live book | Public REST market adapter + paper executor over the live book |
| TESTNET | Spot Testnet public reads (`BINANCE_TESTNET_REST`) | External Testnet orders (P1, unqualified) | Read adapter only; execution refuses to start until qualified |

There is no LIVE mode and no configuration option that creates one. Agent OS MCP observations cannot be obtained by the backend itself (Gate 0 finding); if relayed through a supported agent session they are labelled `BINANCE_MCP_VIA_SUPPORTED_AGENT` and treated as untrusted agent context.

## Local operation

```
pnpm install --frozen-lockfile
docker compose up -d db        # host port from MK_DB_HOST_PORT in .env (default 5432)
pnpm db:migrate
pnpm run doctor
pnpm dev                       # kernel on http://127.0.0.1:8080
pnpm dev:web                   # console on http://127.0.0.1:5173, proxied to the kernel
```

Tests: `pnpm test:unit`, `pnpm test:property`, `pnpm test:contracts` need no database; `pnpm test:integration` and `pnpm test:fault` use `DATABASE_URL_TEST`.
