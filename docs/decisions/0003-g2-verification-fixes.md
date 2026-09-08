# 0003 — G2 verification corrections

Date: 2026-09-08. Reviewed base: `e4c0845`.

The G2 review reproduced unsafe admissions despite passing existing tests:
stale preflight balances, a lease expiring during lock contention, unavailable
current symbol rules falling back to cached rules, and outstanding commands
not blocking new authority. Admission now reads its financial state and clock
after authority locks, requires the current rule refresh, and gives durable
denials while external effects remain unresolved. Exact idempotent retries
still return the previous result.

## Policy and internal input contract

- Engine version advances to `0.1.1` because the deterministic financial rules
  changed. Historical receipts retain their recorded engine version and remain
  verifiable; no stored receipts, policies, or applied migrations are rewritten.
- `AccountView.outstanding_commands` and
  `ResourceView.account_base_reserved` are required internal evaluator inputs.
  Assemble them under the account lock. The latter includes every agent's
  outstanding base holds and excludes a proposal's own hold during revalidation.
  G3's extracted evaluator assembler now supplies these inputs and the current
  rule-refresh result to admission, conflict selection, and dispatch checks.
  Missing capability data must not acquire new authority.
- SELLs respect both the per-order policy cap and the smaller of agent-attributed
  available inventory and account-owned inventory after all base holds.
- G2 supports quote-asset fee models only. Other fee assets produce
  `FEE_MODEL_MISMATCH` until their accounting and reservation models are qualified.
- BUY concentration subtracts pending fees, the valuation buffer, and the
  candidate's rounded fee. Sizing uses an analytical upper bound, reduces integer
  lots if fee rounding requires it, and checks the exact final candidate.
- Scenario A's existing total concentration reserve stays 1 USDT, as required
  by PRD 27.1: configure valuation buffer `0.973` plus candidate fee `0.027`.
  The result remains `0.270 SOL @ 100`. General policy defaults retain a 1 USDT
  valuation buffer, with candidate fees additional to it.
- Ratio bounds use exact canonical decimals; a value one decimal unit above
  one cannot pass through floating-point rounding. A positive BUY price below
  the exchange tick receives a price-filter denial and a receipt instead of 500.

Wire schemas stay at version `1`; these are pre-release behavioral corrections
and required internal producer/consumer changes. The existing inventory race
test now explicitly permits its 80 USDT SELL with a 100 USDT policy cap, while
separate tests enforce the default 50 USDT cap.

## Scenario initialization and evidence

Repeated seeding previously allocated the same BTC to multiple fresh agents
without increasing owned BTC. A scenario now initializes one pristine PAUSED
virtual account in one transaction. Concurrent or repeated seeds cannot reset
the existing run. Baseline quantities and owners are validated before mutation;
allocations cannot exceed ownership, residual amounts go to `UNASSIGNED`, and
baseline ledger entries and audit evidence commit with the seed. Another run
requires a fresh account alias. TESTNET baselines remain forbidden.

G2 model provenance follows the stored agent's strategy kind. `SCRIPTED` stays
`SCRIPTED` across retries and provider configuration changes. Other kinds and
global status use `DISABLED` until actual recorded model-run evidence exists;
configuration and an agent-supplied run ID cannot prove a provider call. G6 must
bind any live/recorded label to that evidence before exposing those labels.

Affected requirements: INV-02/04/09/10/12/14/16, FR-03/04/05/10/11,
PRD 9.4–9.10, 13.8, 27.1, 27.5, and 28.1–28.2.
