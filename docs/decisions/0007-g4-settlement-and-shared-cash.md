# 0007 — G4 settlement and shared quote cash

Date: 2026-09-08. Review base: `9a4e888`.

## Accounting decisions

Quote cash belongs to the account's shared `UNASSIGNED` pool. An agent's lease
limits spending authority; it does not transfer cash into that agent's inventory.
BUY settlement debits shared quote attribution and credits the submitting
agent's base inventory. SELL settlement does the reverse, including observed
fees, and does not replenish a lease's spending budget. Seed and inventory APIs
reject positive quote attribution to an agent. A zero assignment remains valid
so an operator can explicitly repair a legacy assignment while the account is
paused. Existing database rows are not silently rewritten.

Nonterminal fills consume only their incremental cost from an armed hold. The
unused part remains armed until a terminal venue observation; already consumed
amounts must not be counted twice on a retry or against the remaining budget.
An observation outside the proposal's approved fee model or available hold
records the observed ledger effects but raises a critical incident and retains
the unresolved reservation. It must not mark the command reconciled or make
the account ready. The approved policy, including its per-fill fee rounding,
is authoritative even if a newer policy is active.

Venue observations must match the command's account, environment, client ID,
symbol, side, quantity, limit, and exchange order binding before they can
create financial entries. Repeated fill IDs must retain identical financial
and identity data. Refused observations create an incident and preserve holds;
they cannot replace already settled financial evidence. A late response cannot
downgrade a terminal settlement or erase a known acceptance.

## Recovery decisions

Readiness reflects current writer ownership, account status, and outstanding
commands. A failed historical boot recovery report does not permanently block
an account after successful reconciliation. Conversely, a live database socket
alone does not establish the writer lease, and `RECONCILING` or `ERROR` account
status still blocks readiness when there are no outstanding commands.

Admission verifies live writer ownership before creating new authority. Exact
historical retries remain readable without creating reservations or charging
misconduct. Reconciliation rejects foreign-account command IDs before accessing
the venue or mutating rows. Recovery and dispatch recheck the persisted command
after acquiring the account lock, preserving decisions made while a venue call
was in flight.

## Compatibility

No migration is required. The internal reconciliation result can omit an order
ID when an untrusted observation is refused before any order row exists; public
wire contracts are unchanged. Legacy quote attribution or accounting corruption
requires explicit operator inspection and correction. These guards do not
qualify external testnet writes or introduce a LIVE mode.
