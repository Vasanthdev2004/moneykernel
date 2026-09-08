import {
  type CandidateOrder,
  type DecisionResponse,
  decisionFingerprint,
  type ErrorCode,
  hashCanonical,
  PolicySchema,
  type TradeIntent,
  TradeIntentSchema,
} from "@moneykernel/contracts";
import { type EvaluationInput, type EvaluationResult, evaluate } from "@moneykernel/domain";
import type { PoolClient } from "@moneykernel/persistence";
import {
  type AgentRow,
  appendAuditEvent,
  findIntentByIdempotencyKey,
  getCurrentPolicy,
  getLatestProposalForIntent,
  getLatestReceiptForIntent,
  getLeaseById,
  insertIntent,
  insertProposal,
  insertReceipt,
  insertReservation,
  lockAccountRow,
  lockAgentRow,
  nextIntentSeq,
  type ProposalRow,
  type ReceiptRow,
  withClient,
  withTransaction,
} from "@moneykernel/persistence";
import type { KernelRuntime } from "../boot.ts";
import { newId } from "../ids.ts";
import { assembleEvaluationInput, refreshInputsForSymbol } from "./evaluation.ts";
import { sweepProposalsInTx } from "./proposals.ts";
import { provenanceFor } from "./provenance.ts";
import {
  enforceBurstThreshold,
  enforceHardViolationThreshold,
  isHardViolation,
  recordHardViolation,
} from "./quarantine.ts";
import { hasLiveWriterLease } from "./writer.ts";

export class AdmissionError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;
  constructor(code: ErrorCode, status: number, message: string, details?: unknown) {
    super(message);
    this.name = "AdmissionError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export type AdmissionOutcome = { status: 200 | 201; response: DecisionResponse };

type StoredAdmissionError = { code: ErrorCode; status: number; message: string };

/** Missing leases cannot be referenced by an intent FK, so the resolved incident holds the denied request. */
async function recordedAdmissionError(
  tx: PoolClient,
  accountId: string,
  agentId: string,
  idempotencyKey: string,
  payloadHash: string,
): Promise<AdmissionError | null> {
  const result = await tx.query<{ payload_hash: string; response: StoredAdmissionError }>(
    `SELECT evidence_refs->>'payload_hash' AS payload_hash, evidence_refs->'response' AS response
       FROM incidents
      WHERE account_id = $1 AND agent_id = $2 AND type = 'HARD_AUTHORITY_VIOLATION'
        AND evidence_refs->>'record_kind' = 'DENIED_INTENT'
        AND evidence_refs->>'idempotency_key' = $3
      ORDER BY created_at, id LIMIT 1`,
    [accountId, agentId, idempotencyKey],
  );
  const recorded = result.rows[0];
  if (recorded === undefined) return null;
  if (recorded.payload_hash !== payloadHash) {
    throw new AdmissionError("IDEMPOTENCY_KEY_REUSED", 409, "idempotency key was used with a different payload");
  }
  return new AdmissionError(recorded.response.code, recorded.response.status, recorded.response.message);
}

function parseIntent(body: unknown): TradeIntent {
  const parsed = TradeIntentSchema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
  const financial = issues.some((i) => /amount|limit_price/.test(i.path));
  throw new AdmissionError(
    financial ? "INVALID_FINANCIAL_VALUE" : "INVALID_SHAPE",
    financial ? 422 : 400,
    financial ? "invalid financial value" : "intent does not match the contract",
    issues,
  );
}

export function responseFrom(
  runtime: KernelRuntime,
  intentId: string,
  receipt: ReceiptRow,
  proposal: ProposalRow | null,
  leaseRevision: number,
  policyVersion: number,
  accountEpoch: number,
  strategyKind: string,
): DecisionResponse {
  return {
    intent_id: intentId,
    proposal_id: proposal?.id ?? null,
    proposal_revision: proposal?.revision ?? null,
    outcome: receipt.outcome,
    state: proposal?.state ?? "DENIED",
    reason_codes: receipt.reasons as DecisionResponse["reason_codes"],
    candidate: proposal?.normalized_order ?? null,
    authority: {
      policy_version: policyVersion,
      lease_revision: leaseRevision,
      account_epoch: accountEpoch,
      requires_operator_approval: true,
    },
    provenance: provenanceFor(runtime.config, strategyKind),
    receipt_id: receipt.id,
    proposal_hash: proposal?.proposal_hash ?? null,
    expires_at: proposal?.expires_at.toISOString() ?? null,
  };
}

/**
 * Intent admission: the reservation transaction of prd.md 28.2. Everything
 * financial commits together with the decision receipt (INV-12); the account
 * row lock serializes all resource claims (INV-04); the same idempotency key
 * with the same canonical payload returns the recorded outcome (T-18) and with
 * a different payload is refused (T-19). Quarantine thresholds (prd.md 10.4)
 * are enforced in the same transaction.
 */
export async function submitIntent(
  runtime: KernelRuntime,
  input: { agent: AgentRow; body: unknown; idempotencyKey: string },
): Promise<AdmissionOutcome> {
  const pool = runtime.pool;
  const account = runtime.account;
  if (pool === null || account === null) throw new AdmissionError("NOT_READY", 503, "kernel has no loaded account");
  const intent = parseIntent(input.body);
  const payloadHash = hashCanonical(intent);

  const existing = await withClient(pool, (client) =>
    findIntentByIdempotencyKey(client, account.id, input.agent.id, input.idempotencyKey),
  );
  if (existing !== null) {
    if (existing.payload_hash !== payloadHash) {
      throw new AdmissionError("IDEMPOTENCY_KEY_REUSED", 409, "idempotency key was used with a different payload");
    }
    return withClient(pool, (client) => loadOutcome(runtime, client, existing.id, 200));
  }
  const previouslyDenied = await withClient(pool, (client) =>
    recordedAdmissionError(client, account.id, input.agent.id, input.idempotencyKey, payloadHash),
  );
  if (previouslyDenied !== null) throw previouslyDenied;

  const refreshedRulesId = await refreshInputsForSymbol(runtime, account.id, account.quote_asset, intent.symbol);

  const committed = await withTransaction<AdmissionOutcome | AdmissionError>(pool, async (tx) => {
    const accountRow = await lockAccountRow(tx, account.id);
    let agent = await lockAgentRow(tx, input.agent.id);
    if (agent === null || agent.account_id !== account.id)
      throw new AdmissionError("FORBIDDEN", 403, "agent is not bound to this account");

    const raced = await findIntentByIdempotencyKey(tx, account.id, agent.id, input.idempotencyKey);
    if (raced !== null) {
      if (raced.payload_hash !== payloadHash) {
        throw new AdmissionError("IDEMPOTENCY_KEY_REUSED", 409, "idempotency key was used with a different payload");
      }
      return loadOutcome(runtime, tx, raced.id, 200);
    }
    const denied = await recordedAdmissionError(tx, account.id, agent.id, input.idempotencyKey, payloadHash);
    if (denied !== null) return denied;

    const policyRow = await getCurrentPolicy(tx, account.id);
    if (policyRow === null) throw new AdmissionError("NOT_READY", 503, "no policy version exists for this account");
    const policy = PolicySchema.parse(policyRow.canonical_policy);

    const lease = await getLeaseById(tx, intent.lease_id, { lock: true });
    // Historical retries above are read-only. New authority requires the live
    // writer after every authority lock wait, before recording any agent fault.
    if (!(await hasLiveWriterLease(runtime))) {
      throw new AdmissionError("NOT_READY", 503, "writer ownership lost; admission blocked");
    }
    // Admission time must follow all authority locks so waiting cannot extend
    // lease validity or use an earlier burst-counting window for this request.
    const now = runtime.clock();

    // Burst rule before evaluation: the request that crosses the limit is not admitted (prd.md 10.5).
    const burst = await enforceBurstThreshold(tx, { accountId: account.id, agent, policy, now });
    if (burst !== null) agent = burst.agent;

    if (lease === null || lease.account_id !== account.id) {
      const response: StoredAdmissionError = {
        code: "NOT_FOUND",
        status: 404,
        message: "lease not found for this identity",
      };
      await recordHardViolation(tx, {
        accountId: account.id,
        agentId: agent.id,
        reason: "LEASE_NOT_FOUND",
        evidence: {
          record_kind: "DENIED_INTENT",
          lease_id: intent.lease_id,
          idempotency_key: input.idempotencyKey,
          payload_hash: payloadHash,
          canonical_payload: intent,
          response,
        },
        now,
      });
      await appendAuditEvent(tx, {
        id: newId("evt"),
        accountId: account.id,
        type: "INCIDENT_RAISED",
        payload: {
          type: "HARD_AUTHORITY_VIOLATION",
          agent_id: agent.id,
          reason: "LEASE_NOT_FOUND",
          idempotency_key: input.idempotencyKey,
          payload_hash: payloadHash,
        },
        occurredAt: now,
      });
      await enforceHardViolationThreshold(tx, { accountId: account.id, agent, policy, now });
      return new AdmissionError(response.code, response.status, response.message);
    }

    const { input: evaluation, baseAsset } = await assembleEvaluationInput({
      tx,
      accountRow,
      agent,
      lease,
      policyRow,
      policy,
      intent,
      now,
      refreshedRulesId,
    });
    const result = evaluate(evaluation);
    const response = await persistDecision(runtime, tx, {
      now,
      intent,
      payloadHash,
      idempotencyKey: input.idempotencyKey,
      agentId: agent.id,
      accountId: account.id,
      accountEpoch: accountRow.epoch,
      lease: { id: lease.id, revision: lease.revision, expires_at: lease.expires_at },
      policy: { id: policyRow.id, version: policyRow.version, max_proposal_age_ms: policy.max_proposal_age_ms },
      quoteAsset: account.quote_asset,
      baseAsset,
      result,
      evaluationInput: evaluation,
    });
    if (isHardViolation(result.reason_codes)) {
      await enforceHardViolationThreshold(tx, { accountId: account.id, agent, policy, now });
    }
    await sweepProposalsInTx(tx, runtime, now);
    return loadOutcome(runtime, tx, response.intent_id, 201);
  });
  // Preserve denial evidence and any quarantine before surfacing the HTTP error.
  if (committed instanceof AdmissionError) throw committed;
  return committed;
}

export async function persistDecision(
  runtime: KernelRuntime,
  tx: PoolClient,
  args: {
    now: Date;
    intent: TradeIntent;
    payloadHash: string;
    idempotencyKey: string;
    agentId: string;
    accountId: string;
    accountEpoch: number;
    lease: { id: string; revision: number; expires_at: Date };
    policy: { id: string; version: number; max_proposal_age_ms: number };
    quoteAsset: string;
    baseAsset: string;
    result: EvaluationResult;
    /** The exact evaluator input, archived with the receipt for verification replay (T-55). */
    evaluationInput?: EvaluationInput;
  },
): Promise<DecisionResponse> {
  const { now, intent, result } = args;
  const intentId = newId("intent");
  const seq = await nextIntentSeq(tx, args.accountId);
  await insertIntent(tx, {
    id: intentId,
    accountId: args.accountId,
    agentId: args.agentId,
    leaseId: args.lease.id,
    idempotencyKey: args.idempotencyKey,
    canonicalPayload: intent,
    payloadHash: args.payloadHash,
    accountSeq: seq,
    now,
  });
  await appendAuditEvent(tx, {
    id: newId("evt"),
    accountId: args.accountId,
    type: "INTENT_RECEIVED",
    payload: {
      intent_id: intentId,
      agent_id: args.agentId,
      lease_id: args.lease.id,
      payload_hash: args.payloadHash,
      account_seq: seq,
    },
    occurredAt: now,
  });
  const proposal = await recordProposalRevision(tx, {
    runtime,
    now,
    intentId,
    revision: 1,
    state: "COLLECTING",
    accountId: args.accountId,
    agentId: args.agentId,
    accountEpoch: args.accountEpoch,
    lease: args.lease,
    policy: args.policy,
    quoteAsset: args.quoteAsset,
    baseAsset: args.baseAsset,
    result,
  });
  const receipt = await recordReceipt(tx, {
    runtime,
    now,
    intentId,
    proposalId: proposal?.id ?? null,
    accountId: args.accountId,
    result,
    evaluationInput: args.evaluationInput,
  });
  return responseFrom(
    runtime,
    intentId,
    receipt,
    proposal,
    args.lease.revision,
    args.policy.version,
    args.accountEpoch,
    await intentStrategyKind(tx, intentId, args.accountId),
  );
}

/** Inserts a proposal revision with its reservations when the result carries a candidate. Shared by admission and conflict revalidation. */
export async function recordProposalRevision(
  tx: PoolClient,
  args: {
    runtime: KernelRuntime;
    now: Date;
    intentId: string;
    revision: number;
    state: "COLLECTING" | "AWAITING_APPROVAL";
    accountId: string;
    agentId: string;
    accountEpoch: number;
    lease: { id: string; revision: number; expires_at: Date };
    policy: { id: string; version: number; max_proposal_age_ms: number };
    quoteAsset: string;
    baseAsset: string;
    result: EvaluationResult;
  },
): Promise<ProposalRow | null> {
  const { now, result } = args;
  if (result.candidate === null) return null;
  const proposalId = newId("proposal");
  const expiresAt = new Date(
    Math.min(now.getTime() + args.policy.max_proposal_age_ms, args.lease.expires_at.getTime()),
  );
  const proposalHash = hashCanonical({
    account_id: args.accountId,
    intent_id: args.intentId,
    revision: args.revision,
    policy_version: args.policy.version,
    lease_revision: args.lease.revision,
    account_epoch: args.accountEpoch,
    environment: args.runtime.config.environment,
    order: result.candidate,
  });
  await insertProposal(tx, {
    id: proposalId,
    intentId: args.intentId,
    accountId: args.accountId,
    revision: args.revision,
    normalizedOrder: result.candidate,
    proposalHash,
    state: args.state,
    expiresAt,
    policyId: args.policy.id,
    leaseRevision: args.lease.revision,
    accountEpoch: args.accountEpoch,
    now,
  });
  const candidate: CandidateOrder = result.candidate;
  const reservations: Array<{ asset: string; amount: string; kind: "QUOTE" | "BASE" | "ATTEMPT" }> = [];
  if (candidate.side === "BUY")
    reservations.push({ asset: args.quoteAsset, amount: candidate.total_quote_reserved, kind: "QUOTE" });
  else reservations.push({ asset: args.baseAsset, amount: candidate.base_reserved, kind: "BASE" });
  reservations.push({ asset: "ATTEMPT", amount: "1", kind: "ATTEMPT" });
  for (const r of reservations) {
    await insertReservation(tx, {
      id: newId("rsv"),
      accountId: args.accountId,
      proposalId,
      agentId: args.agentId,
      ...r,
      now,
    });
  }
  await appendAuditEvent(tx, {
    id: newId("evt"),
    accountId: args.accountId,
    type: "RESERVATION_CREATED",
    payload: { proposal_id: proposalId, revision: args.revision, state: args.state, reservations },
    occurredAt: now,
  });
  return {
    id: proposalId,
    intent_id: args.intentId,
    account_id: args.accountId,
    revision: args.revision,
    normalized_order: candidate,
    proposal_hash: proposalHash,
    state: args.state,
    expires_at: expiresAt,
    policy_id: args.policy.id,
    lease_revision: args.lease.revision,
    account_epoch: args.accountEpoch,
    created_at: now,
    updated_at: now,
  };
}

export async function recordReceipt(
  tx: PoolClient,
  args: {
    runtime: KernelRuntime;
    now: Date;
    intentId: string;
    proposalId: string | null;
    accountId: string;
    result: EvaluationResult;
    evaluationInput?: EvaluationInput;
  },
): Promise<ReceiptRow> {
  const { now, result } = args;
  const receiptId = newId("receipt");
  const engineVersion = args.runtime.config.engineVersion;
  const fingerprint = decisionFingerprint({
    engine_version: engineVersion,
    normalized_request: result.normalized_request,
    input_refs: result.input_refs,
    outcome: result.outcome,
    reason_codes: result.reason_codes,
    checks: result.checks,
    evaluated_at: now.toISOString(),
  });
  await insertReceipt(tx, {
    id: receiptId,
    accountId: args.accountId,
    intentId: args.intentId,
    proposalId: args.proposalId,
    outcome: result.outcome,
    reasons: result.reason_codes,
    inputRefs: result.input_refs,
    checks: result.checks,
    normalizedRequest: result.normalized_request,
    decisionFingerprint: fingerprint,
    evaluatedAt: now,
    engineVersion,
    evaluationInput: args.evaluationInput,
  });
  await appendAuditEvent(tx, {
    id: newId("evt"),
    accountId: args.accountId,
    type: "DECISION_RECORDED",
    payload: {
      receipt_id: receiptId,
      intent_id: args.intentId,
      proposal_id: args.proposalId,
      outcome: result.outcome,
      reason_codes: result.reason_codes,
      decision_fingerprint: fingerprint,
    },
    occurredAt: now,
  });
  return {
    id: receiptId,
    account_id: args.accountId,
    intent_id: args.intentId,
    proposal_id: args.proposalId,
    evaluation_input: args.evaluationInput ?? null,
    outcome: result.outcome,
    reasons: result.reason_codes,
    input_refs: result.input_refs,
    checks: result.checks,
    normalized_request: result.normalized_request,
    decision_fingerprint: fingerprint,
    evaluated_at: now,
    engine_version: engineVersion,
  };
}

/** Registered strategy kind has no mutation path; replay uses its persisted owner, not current provider config. */
async function intentStrategyKind(client: PoolClient, intentId: string, accountId: string): Promise<string> {
  const result = await client.query<{ strategy_kind: string }>(
    `SELECT a.strategy_kind FROM intents i
       JOIN agents a ON a.id = i.agent_id AND a.account_id = i.account_id
      WHERE i.id = $1 AND i.account_id = $2`,
    [intentId, accountId],
  );
  const owner = result.rows[0];
  if (owner === undefined) throw new AdmissionError("INTERNAL", 500, "intent has no bound strategy identity");
  return owner.strategy_kind;
}

export async function loadOutcome(
  runtime: KernelRuntime,
  client: PoolClient,
  intentId: string,
  status: 200 | 201,
): Promise<AdmissionOutcome> {
  const receipt = await getLatestReceiptForIntent(client, intentId);
  if (receipt === null) throw new AdmissionError("INTERNAL", 500, "intent exists without a receipt");
  const proposal = await getLatestProposalForIntent(client, intentId);
  const refs = receipt.input_refs as { policy_version?: number; lease_revision?: number; account_epoch?: number };
  return {
    status,
    response: responseFrom(
      runtime,
      intentId,
      receipt,
      proposal,
      refs.lease_revision ?? 0,
      refs.policy_version ?? 0,
      refs.account_epoch ?? 0,
      await intentStrategyKind(client, intentId, receipt.account_id),
    ),
  };
}

/** Read-back for GET /v1/agent/intents/:id, scoped to the owning agent (FR-01). */
export async function getIntentOutcome(
  runtime: KernelRuntime,
  agentId: string,
  intentId: string,
): Promise<DecisionResponse | null> {
  const pool = runtime.pool;
  if (pool === null) return null;
  return withClient(pool, async (client) => {
    const receipt = await getLatestReceiptForIntent(client, intentId);
    if (receipt === null) return null;
    const intentRow = await client.query<{ agent_id: string }>("SELECT agent_id FROM intents WHERE id = $1", [
      intentId,
    ]);
    if (intentRow.rows[0]?.agent_id !== agentId) return null;
    const outcome = await loadOutcome(runtime, client, intentId, 200);
    return outcome.response;
  });
}
