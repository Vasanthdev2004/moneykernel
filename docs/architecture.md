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
- Accounting of fills (balances, attribution, lease consumption, hold settlement) is not yet applied; accepted commands stay unreconciled until Gate 4.

## Modes (prd.md 13.1)

| Mode | Market context | Funds and orders | Adapter selected at construction time |
|---|---|---|---|
| REPLAY | Synthetic or archived fixtures | Virtual, deterministic | Paper executor |
| SHADOW | Binance public REST reads, labelled as such | Virtual ledger, paper fills | Paper executor |
| TESTNET | Testnet reads | External Testnet orders (P1, unqualified) | Refuses to start until qualified |

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
