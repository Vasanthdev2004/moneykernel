# 0005 — G4 execution, reconciliation, recovery, observations

Date: 2026-09-08. Base: `fc00bc8`.

## Problem

Gate 3 dispatched an exact approved order once and recorded the venue's
response, but nothing settled it: balances, attribution, lease consumption,
and the armed hold stayed where the arm commit left them, and a kernel restart
had no way to learn what the venue did with an order whose response was lost.
Gate 4 adds accounting, reconciliation, recovery, a live market observation
adapter for SHADOW, and a strategy runner, without changing the wire contracts.

## Decisions

1. **Fills drive the ledger; order totals are cross-checks** (prd.md 28.3).
   Each fill is inserted by its external identity (`fills` unique on account,
   symbol, trade id); only a newly inserted fill produces ledger entries
   (`FILL_BASE`, `FILL_QUOTE`, `FILL_FEE`), balance deltas, agent attribution
   deltas, and lease consumption. The ledger's unique index on
   (source fill, category, asset) refuses a second application at the
   database. The paper venue can simulate fill detail lag for tests
   (`overstateExecutedFor`). If the venue's order totals disagree with the recorded fills, a
   `FILL_DETAIL_INCOMPLETE` incident opens and the armed hold stays as the
   conservative buffer.
2. **Accounting settles in the dispatch transaction** (prd.md 11.3 step 9).
   An accepted response is persisted and reconciled together; on a terminal
   order with matching totals the armed hold is settled (the executed part
   becomes `CONSUMED`, the remainder becomes a separate `RELEASED` row) and
   `commands.reconciled_at` is stamped. Only then does the command stop
   counting as outstanding.
3. **Fee assets.** Quote fees debit quote and add to consumed BUY budget
   (Scenario D: 12 + 0.012 = 12.012). Base fees reduce the net inventory
   credited to the agent (T-15). Any other fee asset leaves the fill at the
   venue, opens a CRITICAL `UNSUPPORTED_FEE_ASSET` incident, and keeps the
   command unsettled: the fee is never dropped and never guessed (T-45).
4. **SELL proceeds never replenish acquisition budget** (T-16): only BUY
   executions move quote from reserved to consumed lease budget.
5. **The paper venue keeps its own journal outside the database**
   (`.moneykernel/paper-venue-<mode>-<alias>.json`, written before any
   response leaves the venue). A real exchange remembers accepted orders
   whether or not the client heard the answer; the simulator must too,
   otherwise restart recovery could only ever say "not found". Tests share an
   in-memory store across simulated crashes. Simulator version is `paper-2`;
   liquidity consumption is keyed by book observation (fixture snapshot id, or
   the live book's content hash), so a new observed book starts a new pool.
6. **Recovery queries, never resends** (prd.md 11.7, 11.8). Boot reconciles
   every armed, unknown, or unsettled command by its stable client order id.
   A command found `ARMED` (crash between the arm commit and the response)
   becomes `OUTCOME_UNKNOWN` with a CRITICAL incident when the venue does not
   know it; `NOT_FOUND` is never a rejection (T-36). A background pass retries
   with exponential backoff up to six times; after that only an operator
   (`POST /v1/commands/:id/reconcile`) continues the investigation.
7. **Boot invalidates approvals, not every proposal.** All approvals were
   bound to the previous epoch and are invalidated; proposals that carried one
   (APPROVED, COMMAND_CREATED with a READY command) end with their never-armed
   holds released, as do proposals whose TTL elapsed during downtime.
   Proposals still collecting or awaiting approval keep their holds until
   their own TTL, so an identical idempotent retry after a restart returns the
   same recorded decision (T-18). Armed holds are never touched by any pre-arm
   path: a proposal whose command has armed is excluded from every pre-arm
   listing (T-42).
8. **Resume gate.** Resume now requires zero outstanding commands (armed,
   unknown, or accepted without the reconciliation marker), not just zero
   in-flight ones. Reconciliation that settles the last outstanding command
   moves a `RECONCILING` account to `PAUSED` and records `ACCOUNT_RECONCILED`;
   returning to `READY` stays an operator action (prd.md 11.1).
9. **SHADOW observations** come from a read-only Binance public REST adapter
   (`data-api.binance.vision`, GET only, no credentials, allowlisted hosts,
   labelled `BINANCE_PUBLIC_REST`). Depth carries no exchange timestamp, so
   `source_timestamp` is null and freshness is local observation age
   (prd.md 13.8). The paper venue in SHADOW walks the live book read at
   submission. Filter coverage: PRICE_FILTER, LOT_SIZE, NOTIONAL/MIN_NOTIONAL
   are enforced by the evaluator; MARKET_LOT_SIZE, ICEBERG_PARTS,
   TRAILING_DELTA and the MAX_NUM_* family do not apply to one LIMIT IOC
   order; PERCENT_PRICE(_BY_SIDE) is bounded in practice by
   `max_price_drift_bps` against a fresh mark; unknown filter types are
   reported and deny with `FILTER_UNSUPPORTED`. TESTNET mode gets the same
   adapter against `testnet.binance.vision` for reads only; execution stays
   unqualified (P1).
10. **Strategy runner** (`apps/agents`) implements prd.md 16: bounded context,
    the verbatim prompt contract, strict output validation with one repair
    attempt, 20 s timeout, `NO_PROPOSAL` on any provider failure, and a trace
    per run (provider, model, prompt version, context hash, latency, usage,
    validation result). Providers: scripted, recorded (visible
    `RECORDED MODEL RESPONSE` label), Anthropic Messages API (needs
    `MODEL_API_KEY`), and a supported agent session that consumes a proposal
    file bound to the context hash. Model provenance labels on receipts remain
    as decided in 0003 until G6 binds them to run evidence.

## Contract changes

Additive only: audit event type `ACCOUNT_RECONCILED`; configuration key
`MONEYKERNEL_STATE_DIR` (default `.moneykernel`, excluded from the
configuration hash). No wire schema version change.

## Revisit triggers

Base-asset fee models beyond the net-inventory rule; a venue that reports
fills without a stable trade id; TESTNET qualification (which will exercise
`NEW`/`PARTIALLY_FILLED` intermediate states the paper venue never emits).
