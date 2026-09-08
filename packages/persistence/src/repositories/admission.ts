import type { CandidateOrder, ProposalState } from "@moneykernel/contracts";
import type { PoolClient } from "pg";

export type IntentRow = {
  id: string;
  account_id: string;
  agent_id: string;
  lease_id: string;
  idempotency_key: string;
  canonical_payload: Record<string, unknown>;
  payload_hash: string;
  account_seq: string;
  created_at: Date;
};

export type ProposalRow = {
  id: string;
  intent_id: string;
  account_id: string;
  revision: number;
  normalized_order: CandidateOrder;
  proposal_hash: string;
  state: ProposalState;
  expires_at: Date;
  policy_id: string;
  lease_revision: number;
  account_epoch: number;
  created_at: Date;
  updated_at: Date;
};

export type ReceiptRow = {
  id: string;
  account_id: string;
  intent_id: string;
  proposal_id: string | null;
  outcome: "ALLOW_PROPOSAL" | "COUNTERPROPOSE" | "DENY" | "HOLD";
  reasons: string[];
  input_refs: Record<string, unknown>;
  checks: Array<Record<string, unknown>>;
  normalized_request: Record<string, unknown>;
  decision_fingerprint: string;
  evaluated_at: Date;
  engine_version: string;
};

export type ReservationKind = "QUOTE" | "BASE" | "ATTEMPT";
export type ReservationState = "HELD" | "ARMED" | "CONSUMED" | "RELEASED";
export type ReservationRow = {
  id: string;
  account_id: string;
  proposal_id: string;
  agent_id: string;
  asset: string;
  amount: string;
  kind: ReservationKind;
  state: ReservationState;
  created_at: Date;
  armed_at: Date | null;
  released_at: Date | null;
};

const OUTSTANDING: ReservationState[] = ["HELD", "ARMED"];

// --- intents ------------------------------------------------------------------

export async function findIntentByIdempotencyKey(
  client: PoolClient,
  accountId: string,
  agentId: string,
  idempotencyKey: string,
): Promise<IntentRow | null> {
  const result = await client.query<IntentRow>(
    "SELECT * FROM intents WHERE account_id = $1 AND agent_id = $2 AND idempotency_key = $3",
    [accountId, agentId, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

export async function getIntentById(client: PoolClient, id: string): Promise<IntentRow | null> {
  const result = await client.query<IntentRow>("SELECT * FROM intents WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}

export async function nextIntentSeq(client: PoolClient, accountId: string): Promise<number> {
  const result = await client.query<{ v: string }>(
    "SELECT COALESCE(MAX(account_seq), 0)::text AS v FROM intents WHERE account_id = $1",
    [accountId],
  );
  return Number(result.rows[0]?.v ?? "0") + 1;
}

export async function insertIntent(
  client: PoolClient,
  input: {
    id: string;
    accountId: string;
    agentId: string;
    leaseId: string;
    idempotencyKey: string;
    canonicalPayload: Record<string, unknown>;
    payloadHash: string;
    accountSeq: number;
    now: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO intents (id, account_id, agent_id, lease_id, idempotency_key, canonical_payload, payload_hash, account_seq, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
    [
      input.id,
      input.accountId,
      input.agentId,
      input.leaseId,
      input.idempotencyKey,
      JSON.stringify(input.canonicalPayload),
      input.payloadHash,
      input.accountSeq,
      input.now,
    ],
  );
}

// --- proposals ----------------------------------------------------------------

export async function insertProposal(
  client: PoolClient,
  input: {
    id: string;
    intentId: string;
    accountId: string;
    revision: number;
    normalizedOrder: CandidateOrder;
    proposalHash: string;
    state: ProposalState;
    expiresAt: Date;
    policyId: string;
    leaseRevision: number;
    accountEpoch: number;
    now: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO proposals (id, intent_id, account_id, revision, normalized_order, proposal_hash, state, expires_at,
                            policy_id, lease_revision, account_epoch, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $12)`,
    [
      input.id,
      input.intentId,
      input.accountId,
      input.revision,
      JSON.stringify(input.normalizedOrder),
      input.proposalHash,
      input.state,
      input.expiresAt,
      input.policyId,
      input.leaseRevision,
      input.accountEpoch,
      input.now,
    ],
  );
}

export async function getProposalById(
  client: PoolClient,
  id: string,
  options: { lock?: boolean } = {},
): Promise<ProposalRow | null> {
  const result = await client.query<ProposalRow>(
    `SELECT * FROM proposals WHERE id = $1${options.lock ? " FOR UPDATE" : ""}`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function getLatestProposalForIntent(client: PoolClient, intentId: string): Promise<ProposalRow | null> {
  const result = await client.query<ProposalRow>(
    "SELECT * FROM proposals WHERE intent_id = $1 ORDER BY revision DESC LIMIT 1",
    [intentId],
  );
  return result.rows[0] ?? null;
}

export async function listProposalsByState(
  client: PoolClient,
  accountId: string,
  states: ProposalState[],
): Promise<ProposalRow[]> {
  const result = await client.query<ProposalRow>(
    "SELECT * FROM proposals WHERE account_id = $1 AND state = ANY($2::text[]) ORDER BY created_at",
    [accountId, states],
  );
  return result.rows;
}

export async function updateProposalState(
  client: PoolClient,
  id: string,
  state: ProposalState,
  now: Date,
): Promise<ProposalRow> {
  const result = await client.query<ProposalRow>(
    "UPDATE proposals SET state = $2, updated_at = $3 WHERE id = $1 RETURNING *",
    [id, state, now],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`proposal ${id} not found`);
  return row;
}

// --- receipts (immutable) -----------------------------------------------------

export async function insertReceipt(
  client: PoolClient,
  input: {
    id: string;
    accountId: string;
    intentId: string;
    proposalId: string | null;
    outcome: ReceiptRow["outcome"];
    reasons: string[];
    inputRefs: Record<string, unknown>;
    checks: Array<Record<string, unknown>>;
    normalizedRequest: Record<string, unknown>;
    decisionFingerprint: string;
    evaluatedAt: Date;
    engineVersion: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO decision_receipts (id, account_id, intent_id, proposal_id, outcome, reasons, input_refs, checks,
                                    normalized_request, decision_fingerprint, evaluated_at, engine_version)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12)`,
    [
      input.id,
      input.accountId,
      input.intentId,
      input.proposalId,
      input.outcome,
      JSON.stringify(input.reasons),
      JSON.stringify(input.inputRefs),
      JSON.stringify(input.checks),
      JSON.stringify(input.normalizedRequest),
      input.decisionFingerprint,
      input.evaluatedAt,
      input.engineVersion,
    ],
  );
}

export async function getLatestReceiptForIntent(client: PoolClient, intentId: string): Promise<ReceiptRow | null> {
  const result = await client.query<ReceiptRow>(
    "SELECT * FROM decision_receipts WHERE intent_id = $1 ORDER BY evaluated_at DESC, id DESC LIMIT 1",
    [intentId],
  );
  return result.rows[0] ?? null;
}

// --- reservations -------------------------------------------------------------

export async function insertReservation(
  client: PoolClient,
  input: {
    id: string;
    accountId: string;
    proposalId: string;
    agentId: string;
    asset: string;
    amount: string;
    kind: ReservationKind;
    now: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO reservations (id, account_id, proposal_id, agent_id, asset, amount, kind, state, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'HELD', $8)`,
    [input.id, input.accountId, input.proposalId, input.agentId, input.asset, input.amount, input.kind, input.now],
  );
}

export async function listReservationsForProposal(client: PoolClient, proposalId: string): Promise<ReservationRow[]> {
  const result = await client.query<ReservationRow>(
    "SELECT * FROM reservations WHERE proposal_id = $1 ORDER BY kind, created_at",
    [proposalId],
  );
  return result.rows;
}

export async function listOutstandingReservations(client: PoolClient, accountId: string): Promise<ReservationRow[]> {
  const result = await client.query<ReservationRow>(
    "SELECT * FROM reservations WHERE account_id = $1 AND state = ANY($2::text[]) ORDER BY created_at",
    [accountId, OUTSTANDING],
  );
  return result.rows;
}

/** Outstanding (HELD or ARMED) quote reservations for the account, optionally excluding one proposal's own hold. */
export async function sumOutstandingQuote(
  client: PoolClient,
  accountId: string,
  excludeProposalId?: string,
): Promise<string> {
  const result = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS total FROM reservations
      WHERE account_id = $1 AND kind = 'QUOTE' AND state = ANY($2::text[]) AND ($3::text IS NULL OR proposal_id <> $3)`,
    [accountId, OUTSTANDING, excludeProposalId ?? null],
  );
  return result.rows[0]?.total ?? "0";
}

/** Outstanding quote reservations attributable to one lease's proposals (BUY acquisition budget, prd.md 9.2). */
export async function sumOutstandingQuoteForLease(
  client: PoolClient,
  leaseId: string,
  excludeProposalId?: string,
): Promise<string> {
  const result = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(r.amount), 0)::text AS total
       FROM reservations r
       JOIN proposals p ON p.id = r.proposal_id
       JOIN intents i ON i.id = p.intent_id
      WHERE i.lease_id = $1 AND r.kind = 'QUOTE' AND r.state = ANY($2::text[]) AND ($3::text IS NULL OR r.proposal_id <> $3)`,
    [leaseId, OUTSTANDING, excludeProposalId ?? null],
  );
  return result.rows[0]?.total ?? "0";
}

export async function countReservedAttemptsForLease(
  client: PoolClient,
  leaseId: string,
  excludeProposalId?: string,
): Promise<number> {
  const result = await client.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n
       FROM reservations r
       JOIN proposals p ON p.id = r.proposal_id
       JOIN intents i ON i.id = p.intent_id
      WHERE i.lease_id = $1 AND r.kind = 'ATTEMPT' AND r.state = ANY($2::text[]) AND ($3::text IS NULL OR r.proposal_id <> $3)`,
    [leaseId, OUTSTANDING, excludeProposalId ?? null],
  );
  return result.rows[0]?.n ?? 0;
}

export async function sumReservedBase(
  client: PoolClient,
  accountId: string,
  agentId: string | null,
  asset: string,
  excludeProposalId?: string,
): Promise<string> {
  const result = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS total FROM reservations
      WHERE account_id = $1 AND ($2::text IS NULL OR agent_id = $2) AND asset = $3 AND kind = 'BASE' AND state = ANY($4::text[])
        AND ($5::text IS NULL OR proposal_id <> $5)`,
    [accountId, agentId, asset, OUTSTANDING, excludeProposalId ?? null],
  );
  return result.rows[0]?.total ?? "0";
}

/** Proposals that still hold an outstanding QUOTE reservation, i.e. pending BUY commitments (prd.md 9.9). */
export async function listPendingBuyProposals(
  client: PoolClient,
  accountId: string,
  excludeProposalId?: string,
): Promise<ProposalRow[]> {
  const result = await client.query<ProposalRow>(
    `SELECT DISTINCT p.*
       FROM proposals p
       JOIN reservations r ON r.proposal_id = p.id
      WHERE p.account_id = $1 AND r.kind = 'QUOTE' AND r.state = ANY($2::text[]) AND ($3::text IS NULL OR p.id <> $3)`,
    [accountId, OUTSTANDING, excludeProposalId ?? null],
  );
  return result.rows;
}
