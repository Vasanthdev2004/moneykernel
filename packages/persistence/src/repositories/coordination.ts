import type { ProposalState } from "@moneykernel/contracts";
import type { PoolClient } from "pg";
import type { ProposalRow, ReservationKind, ReservationState } from "./admission.ts";
import { type CommandState, listOutstandingCommands } from "./commands.ts";
import type { LeaseRow } from "./registry.ts";

/** Candidate states; COMMAND_CREATED also requires checking that its command never armed. */
export const PRE_ARM_STATES: ProposalState[] = [
  "COLLECTING",
  "CONFLICT_HELD",
  "AWAITING_APPROVAL",
  "APPROVED",
  "COMMAND_CREATED",
];

export type ApprovalStatus = "ACTIVE" | "CONSUMED" | "INVALIDATED" | "EXPIRED";
export type ApprovalRow = {
  id: string;
  account_id: string;
  proposal_id: string;
  proposal_revision: number;
  proposal_hash: string;
  operator_id: string;
  account_epoch: number;
  expires_at: Date;
  status: ApprovalStatus;
  consumed_at: Date | null;
  created_at: Date;
};

export type CommandRow = {
  id: string;
  account_id: string;
  proposal_id: string;
  approval_id: string;
  client_order_id: string;
  state: CommandState;
  exact_payload: Record<string, unknown>;
  armed_at: Date | null;
  outcome_ref: string | null;
  reconciled_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type OrderStatus = "NEW" | "PARTIALLY_FILLED" | "FILLED" | "CANCELED" | "EXPIRED";
export type OrderRow = {
  id: string;
  account_id: string;
  command_id: string;
  exchange_order_id: string | null;
  client_order_id: string;
  symbol: string;
  status: OrderStatus;
  executed_base: string;
  executed_quote: string;
  last_observed_at: Date;
};

export type FillRow = {
  id: string;
  account_id: string;
  order_id: string;
  exchange_trade_id: string;
  symbol: string;
  base_qty: string;
  price: string;
  quote_qty: string;
  commission_asset: string;
  commission_qty: string;
  event_time: Date;
};

export type ConflictStatus = "OPEN" | "RESOLVED_SELECTED" | "RESOLVED_REJECTED_BOTH" | "EXPIRED";
export type ConflictRow = {
  id: string;
  account_id: string;
  symbol: string;
  status: ConflictStatus;
  resolution: Record<string, unknown> | null;
  operator_id: string | null;
  created_at: Date;
  resolved_at: Date | null;
};

export type IncidentSeverity = "INFO" | "WARNING" | "CRITICAL";
export type IncidentRow = {
  id: string;
  account_id: string;
  agent_id: string | null;
  type: string;
  severity: IncidentSeverity;
  status: "OPEN" | "RESOLVED";
  evidence_refs: Record<string, unknown>;
  resolved_by: string | null;
  created_at: Date;
  resolved_at: Date | null;
};

// --- proposals ----------------------------------------------------------------

const NEVER_ARMED = `NOT EXISTS (
  SELECT 1 FROM commands c WHERE c.proposal_id = p.id
    AND (c.armed_at IS NOT NULL OR c.state IN ('ARMED', 'ACCEPTED', 'OUTCOME_UNKNOWN', 'REJECTED_CONFIRMED'))
)`;

export async function listPreArmProposals(client: PoolClient, accountId: string): Promise<ProposalRow[]> {
  const result = await client.query<ProposalRow>(
    `SELECT p.* FROM proposals p WHERE p.account_id = $1 AND p.state = ANY($2::text[])
      AND ${NEVER_ARMED} ORDER BY p.created_at, p.id`,
    [accountId, PRE_ARM_STATES],
  );
  return result.rows;
}

export async function listPreArmProposalsForAgent(
  client: PoolClient,
  accountId: string,
  agentId: string,
): Promise<ProposalRow[]> {
  const result = await client.query<ProposalRow>(
    `SELECT p.* FROM proposals p JOIN intents i ON i.id = p.intent_id
      WHERE p.account_id = $1 AND i.agent_id = $2 AND p.state = ANY($3::text[])
        AND ${NEVER_ARMED} ORDER BY p.created_at, p.id`,
    [accountId, agentId, PRE_ARM_STATES],
  );
  return result.rows;
}

// --- reservations -------------------------------------------------------------

/** Moves a proposal's reservations between states; ARMED/CONSUMED holds are never released by this path unless listed in `from`. */
export async function transitionReservations(
  client: PoolClient,
  proposalId: string,
  from: ReservationState[],
  to: ReservationState,
  now: Date,
  kinds?: ReservationKind[],
): Promise<number> {
  const result = await client.query(
    `UPDATE reservations
        SET state = $3,
            armed_at = CASE WHEN $3 = 'ARMED' THEN $4 ELSE armed_at END,
            released_at = CASE WHEN $3 = 'RELEASED' THEN $4 ELSE released_at END
      WHERE proposal_id = $1 AND state = ANY($2::text[]) AND ($5::text[] IS NULL OR kind = ANY($5::text[]))`,
    [proposalId, from, to, now, kinds ?? null],
  );
  return result.rowCount ?? 0;
}

// --- approvals ----------------------------------------------------------------

export async function insertApproval(
  client: PoolClient,
  input: {
    id: string;
    accountId: string;
    proposalId: string;
    proposalRevision: number;
    proposalHash: string;
    operatorId: string;
    accountEpoch: number;
    expiresAt: Date;
    now: Date;
  },
): Promise<ApprovalRow> {
  const result = await client.query<ApprovalRow>(
    `INSERT INTO approvals (id, account_id, proposal_id, proposal_revision, proposal_hash, operator_id, account_epoch, expires_at, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ACTIVE', $9) RETURNING *`,
    [
      input.id,
      input.accountId,
      input.proposalId,
      input.proposalRevision,
      input.proposalHash,
      input.operatorId,
      input.accountEpoch,
      input.expiresAt,
      input.now,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("approval insert returned no row");
  return row;
}

export async function getActiveApproval(client: PoolClient, proposalId: string): Promise<ApprovalRow | null> {
  const result = await client.query<ApprovalRow>(
    "SELECT * FROM approvals WHERE proposal_id = $1 AND status = 'ACTIVE' FOR UPDATE",
    [proposalId],
  );
  return result.rows[0] ?? null;
}

export async function getApprovalById(client: PoolClient, id: string): Promise<ApprovalRow | null> {
  const result = await client.query<ApprovalRow>("SELECT * FROM approvals WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}

/** Single-use consumption (INV-05, T-20): succeeds at most once per approval. */
export async function consumeApproval(client: PoolClient, approvalId: string, now: Date): Promise<ApprovalRow | null> {
  const result = await client.query<ApprovalRow>(
    "UPDATE approvals SET status = 'CONSUMED', consumed_at = $2 WHERE id = $1 AND status = 'ACTIVE' RETURNING *",
    [approvalId, now],
  );
  return result.rows[0] ?? null;
}

export async function invalidateApprovalsForProposal(
  client: PoolClient,
  proposalId: string,
  status: "INVALIDATED" | "EXPIRED",
): Promise<number> {
  const result = await client.query("UPDATE approvals SET status = $2 WHERE proposal_id = $1 AND status = 'ACTIVE'", [
    proposalId,
    status,
  ]);
  return result.rowCount ?? 0;
}

export async function invalidateAllActiveApprovals(client: PoolClient, accountId: string): Promise<number> {
  const result = await client.query(
    "UPDATE approvals SET status = 'INVALIDATED' WHERE account_id = $1 AND status = 'ACTIVE'",
    [accountId],
  );
  return result.rowCount ?? 0;
}

// --- commands -----------------------------------------------------------------

export async function insertCommand(
  client: PoolClient,
  input: {
    id: string;
    accountId: string;
    proposalId: string;
    approvalId: string;
    clientOrderId: string;
    exactPayload: Record<string, unknown>;
    now: Date;
  },
): Promise<CommandRow> {
  const result = await client.query<CommandRow>(
    `INSERT INTO commands (id, account_id, proposal_id, approval_id, client_order_id, state, exact_payload, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'READY', $6::jsonb, $7, $7) RETURNING *`,
    [
      input.id,
      input.accountId,
      input.proposalId,
      input.approvalId,
      input.clientOrderId,
      JSON.stringify(input.exactPayload),
      input.now,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("command insert returned no row");
  return row;
}

export async function getCommandById(
  client: PoolClient,
  id: string,
  options: { lock?: boolean } = {},
): Promise<CommandRow | null> {
  const result = await client.query<CommandRow>(
    `SELECT * FROM commands WHERE id = $1${options.lock ? " FOR UPDATE" : ""}`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function getCommandForProposal(client: PoolClient, proposalId: string): Promise<CommandRow | null> {
  const result = await client.query<CommandRow>("SELECT * FROM commands WHERE proposal_id = $1", [proposalId]);
  return result.rows[0] ?? null;
}

export async function selectReadyCommand(
  client: PoolClient,
  accountId: string,
  options: { lock?: boolean } = {},
): Promise<CommandRow | null> {
  const result = await client.query<CommandRow>(
    `SELECT * FROM commands WHERE account_id = $1 AND state = 'READY' ORDER BY created_at, id LIMIT 1${options.lock ? " FOR UPDATE" : ""}`,
    [accountId],
  );
  return result.rows[0] ?? null;
}

export async function listCommands(
  client: PoolClient,
  accountId: string,
  states?: CommandState[],
): Promise<CommandRow[]> {
  const result = await client.query<CommandRow>(
    "SELECT * FROM commands WHERE account_id = $1 AND ($2::text[] IS NULL OR state = ANY($2::text[])) ORDER BY created_at, id",
    [accountId, states ?? null],
  );
  return result.rows;
}

export async function updateCommandState(
  client: PoolClient,
  id: string,
  state: CommandState,
  now: Date,
  extra: { armedAt?: Date; outcomeRef?: string; reconciledAt?: Date } = {},
): Promise<CommandRow> {
  const result = await client.query<CommandRow>(
    `UPDATE commands
        SET state = $2, updated_at = $3,
            armed_at = COALESCE($4, armed_at),
            outcome_ref = COALESCE($5, outcome_ref),
            reconciled_at = COALESCE($6, reconciled_at)
      WHERE id = $1 RETURNING *`,
    [id, state, now, extra.armedAt ?? null, extra.outcomeRef ?? null, extra.reconciledAt ?? null],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`command ${id} not found`);
  return row;
}

export async function abortReadyCommandForProposal(client: PoolClient, proposalId: string, now: Date): Promise<number> {
  const result = await client.query(
    "UPDATE commands SET state = 'ABORTED_PRE_ARM', updated_at = $2 WHERE proposal_id = $1 AND state = 'READY'",
    [proposalId, now],
  );
  return result.rowCount ?? 0;
}

export async function countInFlightCommands(client: PoolClient, accountId: string): Promise<number> {
  const result = await client.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM commands WHERE account_id = $1 AND state IN ('ARMED', 'OUTCOME_UNKNOWN')",
    [accountId],
  );
  return result.rows[0]?.n ?? 0;
}

/** An opposite-side order already in flight for the symbol; a later intent must wait for reconciliation (prd.md 10.1). */
export async function hasInFlightOppositeCommand(
  client: PoolClient,
  accountId: string,
  symbol: string,
  side: "BUY" | "SELL",
): Promise<boolean> {
  const outstanding = await listOutstandingCommands(client, accountId);
  return outstanding.some((c) => c.exact_payload.symbol === symbol && c.exact_payload.side !== side);
}

// --- orders and fills ----------------------------------------------------------

export async function insertOrder(
  client: PoolClient,
  input: {
    id: string;
    accountId: string;
    commandId: string;
    exchangeOrderId: string | null;
    clientOrderId: string;
    symbol: string;
    status: OrderStatus;
    executedBase: string;
    executedQuote: string;
    observedAt: Date;
  },
): Promise<OrderRow> {
  const result = await client.query<OrderRow>(
    `INSERT INTO orders (id, account_id, command_id, exchange_order_id, client_order_id, symbol, status, executed_base, executed_quote, last_observed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (account_id, client_order_id) DO UPDATE
        SET status = EXCLUDED.status, executed_base = EXCLUDED.executed_base, executed_quote = EXCLUDED.executed_quote,
            exchange_order_id = COALESCE(EXCLUDED.exchange_order_id, orders.exchange_order_id), last_observed_at = EXCLUDED.last_observed_at
     RETURNING *`,
    [
      input.id,
      input.accountId,
      input.commandId,
      input.exchangeOrderId,
      input.clientOrderId,
      input.symbol,
      input.status,
      input.executedBase,
      input.executedQuote,
      input.observedAt,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("order upsert returned no row");
  return row;
}

export async function getOrderForCommand(client: PoolClient, commandId: string): Promise<OrderRow | null> {
  const result = await client.query<OrderRow>("SELECT * FROM orders WHERE command_id = $1", [commandId]);
  return result.rows[0] ?? null;
}

/** Inserts a fill by its exchange identity; returns null when it was already recorded (INV-08). */
export async function insertFillOnce(
  client: PoolClient,
  input: {
    id: string;
    accountId: string;
    orderId: string;
    exchangeTradeId: string;
    symbol: string;
    baseQty: string;
    price: string;
    quoteQty: string;
    commissionAsset: string;
    commissionQty: string;
    eventTime: Date;
  },
): Promise<FillRow | null> {
  const result = await client.query<FillRow>(
    `INSERT INTO fills (id, account_id, order_id, exchange_trade_id, symbol, base_qty, price, quote_qty, commission_asset, commission_qty, event_time)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (account_id, symbol, exchange_trade_id) DO NOTHING RETURNING *`,
    [
      input.id,
      input.accountId,
      input.orderId,
      input.exchangeTradeId,
      input.symbol,
      input.baseQty,
      input.price,
      input.quoteQty,
      input.commissionAsset,
      input.commissionQty,
      input.eventTime,
    ],
  );
  return result.rows[0] ?? null;
}

export async function listFillsForOrder(client: PoolClient, orderId: string): Promise<FillRow[]> {
  const result = await client.query<FillRow>("SELECT * FROM fills WHERE order_id = $1 ORDER BY event_time, id", [
    orderId,
  ]);
  return result.rows;
}

// --- conflicts ------------------------------------------------------------------

export async function insertConflict(
  client: PoolClient,
  input: { id: string; accountId: string; symbol: string; now: Date },
): Promise<ConflictRow> {
  const result = await client.query<ConflictRow>(
    "INSERT INTO conflicts (id, account_id, symbol, status, created_at) VALUES ($1, $2, $3, 'OPEN', $4) RETURNING *",
    [input.id, input.accountId, input.symbol, input.now],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("conflict insert returned no row");
  return row;
}

export async function addConflictMember(client: PoolClient, conflictId: string, proposalId: string): Promise<void> {
  await client.query("INSERT INTO conflict_members (conflict_id, proposal_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
    conflictId,
    proposalId,
  ]);
}

export async function findOpenConflictForSymbol(
  client: PoolClient,
  accountId: string,
  symbol: string,
): Promise<ConflictRow | null> {
  const result = await client.query<ConflictRow>(
    "SELECT * FROM conflicts WHERE account_id = $1 AND symbol = $2 AND status = 'OPEN' ORDER BY created_at LIMIT 1 FOR UPDATE",
    [accountId, symbol],
  );
  return result.rows[0] ?? null;
}

export async function getConflictById(
  client: PoolClient,
  id: string,
  options: { lock?: boolean } = {},
): Promise<ConflictRow | null> {
  const result = await client.query<ConflictRow>(
    `SELECT * FROM conflicts WHERE id = $1${options.lock ? " FOR UPDATE" : ""}`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function listConflictMembers(client: PoolClient, conflictId: string): Promise<string[]> {
  const result = await client.query<{ proposal_id: string }>(
    "SELECT proposal_id FROM conflict_members WHERE conflict_id = $1",
    [conflictId],
  );
  return result.rows.map((r) => r.proposal_id);
}

export async function findOpenConflictForProposal(client: PoolClient, proposalId: string): Promise<ConflictRow | null> {
  const result = await client.query<ConflictRow>(
    `SELECT c.* FROM conflicts c JOIN conflict_members m ON m.conflict_id = c.id
      WHERE m.proposal_id = $1 AND c.status = 'OPEN' LIMIT 1`,
    [proposalId],
  );
  return result.rows[0] ?? null;
}

export async function listConflicts(
  client: PoolClient,
  accountId: string,
  status?: ConflictStatus,
): Promise<ConflictRow[]> {
  const result = await client.query<ConflictRow>(
    "SELECT * FROM conflicts WHERE account_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at DESC",
    [accountId, status ?? null],
  );
  return result.rows;
}

export async function resolveConflict(
  client: PoolClient,
  id: string,
  status: Exclude<ConflictStatus, "OPEN">,
  resolution: Record<string, unknown>,
  operatorId: string | null,
  now: Date,
): Promise<ConflictRow> {
  const result = await client.query<ConflictRow>(
    "UPDATE conflicts SET status = $2, resolution = $3::jsonb, operator_id = $4, resolved_at = $5 WHERE id = $1 RETURNING *",
    [id, status, JSON.stringify(resolution), operatorId, now],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`conflict ${id} not found`);
  return row;
}

// --- incidents ------------------------------------------------------------------

export async function insertIncident(
  client: PoolClient,
  input: {
    id: string;
    accountId: string;
    agentId: string | null;
    type: string;
    severity: IncidentSeverity;
    status: "OPEN" | "RESOLVED";
    evidence: Record<string, unknown>;
    resolvedBy?: string;
    now: Date;
  },
): Promise<IncidentRow> {
  const result = await client.query<IncidentRow>(
    `INSERT INTO incidents (id, account_id, agent_id, type, severity, status, evidence_refs, resolved_by, created_at, resolved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10) RETURNING *`,
    [
      input.id,
      input.accountId,
      input.agentId,
      input.type,
      input.severity,
      input.status,
      JSON.stringify(input.evidence),
      input.resolvedBy ?? null,
      input.now,
      input.status === "RESOLVED" ? input.now : null,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("incident insert returned no row");
  return row;
}

export async function listIncidents(
  client: PoolClient,
  accountId: string,
  status?: "OPEN" | "RESOLVED",
): Promise<IncidentRow[]> {
  const result = await client.query<IncidentRow>(
    "SELECT * FROM incidents WHERE account_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at DESC",
    [accountId, status ?? null],
  );
  return result.rows;
}

export async function resolveIncident(
  client: PoolClient,
  id: string,
  resolvedBy: string,
  now: Date,
): Promise<IncidentRow | null> {
  const result = await client.query<IncidentRow>(
    "UPDATE incidents SET status = 'RESOLVED', resolved_by = $2, resolved_at = $3 WHERE id = $1 AND status = 'OPEN' RETURNING *",
    [id, resolvedBy, now],
  );
  return result.rows[0] ?? null;
}

// --- quarantine counters (durable, event-derived; prd.md 10.4, 10.5) --------------

export async function countAgentIntentsSince(client: PoolClient, agentId: string, since: Date): Promise<number> {
  const result = await client.query<{ n: number }>(
    `SELECT (
       (SELECT count(*) FROM intents WHERE agent_id = $1 AND created_at >= $2)
       + (SELECT count(*) FROM incidents WHERE agent_id = $1 AND created_at >= $2
            AND type = 'HARD_AUTHORITY_VIOLATION' AND evidence_refs->>'record_kind' = 'DENIED_INTENT')
     )::int AS n`,
    [agentId, since],
  );
  return result.rows[0]?.n ?? 0;
}

export async function countHardViolationsSince(
  client: PoolClient,
  agentId: string,
  since: Date,
  hardCodes: string[],
): Promise<number> {
  const result = await client.query<{ n: number }>(
    `SELECT (
       (SELECT count(*) FROM decision_receipts r JOIN intents i ON i.id = r.intent_id
         WHERE i.agent_id = $1 AND r.evaluated_at >= $2 AND r.reasons ?| $3::text[])
       + (SELECT count(*) FROM incidents WHERE agent_id = $1 AND type = 'HARD_AUTHORITY_VIOLATION' AND created_at >= $2)
     )::int AS n`,
    [agentId, since, hardCodes],
  );
  return result.rows[0]?.n ?? 0;
}

// --- lease attempts ---------------------------------------------------------------

export async function consumeLeaseAttempt(client: PoolClient, leaseId: string, now: Date): Promise<LeaseRow> {
  const result = await client.query<LeaseRow>(
    "UPDATE leases SET attempts_consumed = attempts_consumed + 1, updated_at = $2 WHERE id = $1 RETURNING *",
    [leaseId, now],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`lease ${leaseId} not found`);
  return row;
}
