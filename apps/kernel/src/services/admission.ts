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
import {
  dec,
  type EvaluationInput,
  type EvaluationResult,
  evaluate,
  type MarkView,
  max,
  mul,
  type ObservationView,
  type SymbolRulesView,
  toDecimalString,
  ZERO,
} from "@moneykernel/domain";
import {
  type AgentRow,
  appendAuditEvent,
  countReservedAttemptsForLease,
  findIntentByIdempotencyKey,
  getCurrentPolicy,
  getLatestProposalForIntent,
  getLatestReceiptForIntent,
  getLeaseById,
  getSnapshotsByIds,
  insertIntent,
  insertProposal,
  insertReceipt,
  insertReservation,
  latestSnapshotsBySymbol,
  ledgerVersion,
  listAssetBalances,
  listInventoryAllocations,
  listPendingBuyProposals,
  lockAccountRow,
  lockAgentRow,
  nextIntentSeq,
  type ProposalRow,
  type ReceiptRow,
  type SnapshotRow,
  sumOutstandingQuote,
  sumOutstandingQuoteForLease,
  sumReservedBase,
  withClient,
  withTransaction,
} from "@moneykernel/persistence";
import type { KernelRuntime } from "../boot.ts";
import { newId } from "../ids.ts";
import { refreshMarks, refreshSymbolRules } from "./observations.ts";
import { provenanceFor } from "./provenance.ts";

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

function markFromSnapshot(row: SnapshotRow): MarkView | null {
  const symbol = row.payload.symbol;
  const last = row.payload.last_price;
  const bids = row.payload.bids;
  let price: string | null = typeof last === "string" ? last : null;
  if (price === null && Array.isArray(bids) && bids.length > 0) {
    const top = bids[0] as { price?: unknown };
    if (typeof top.price === "string") price = top.price;
  }
  if (typeof symbol !== "string" || price === null) return null;
  return {
    symbol,
    price,
    snapshot_id: row.id,
    received_at: row.received_at.toISOString(),
    payload_hash: row.payload_hash,
  };
}

function rulesFromSnapshot(row: SnapshotRow | undefined): SymbolRulesView | null {
  if (row === undefined) return null;
  const p = row.payload as Record<string, unknown>;
  const str = (k: string): string => (typeof p[k] === "string" ? (p[k] as string) : "");
  const status = p.status;
  return {
    symbol: str("symbol"),
    base_asset: str("base_asset"),
    quote_asset: str("quote_asset"),
    status: status === "TRADING" || status === "HALT" || status === "BREAK" ? status : "UNKNOWN",
    tick_size: str("tick_size"),
    step_size: str("step_size"),
    min_qty: str("min_qty"),
    max_qty: str("max_qty"),
    min_notional: str("min_notional"),
    max_notional: typeof p.max_notional === "string" ? p.max_notional : null,
    unsupported_filters: Array.isArray(p.unsupported_filters) ? (p.unsupported_filters as string[]) : [],
    snapshot_id: row.id,
    payload_hash: row.payload_hash,
  };
}

function responseFrom(
  runtime: KernelRuntime,
  intentId: string,
  receipt: ReceiptRow,
  proposal: ProposalRow | null,
  leaseRevision: number,
  policyVersion: number,
  accountEpoch: number,
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
    provenance: provenanceFor(runtime.config),
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
 * a different payload is refused (T-19).
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
  const quote = account.quote_asset;

  // Fast idempotent replay without refreshing observations.
  const existing = await withClient(pool, (client) =>
    findIntentByIdempotencyKey(client, account.id, input.agent.id, input.idempotencyKey),
  );
  if (existing !== null) {
    if (existing.payload_hash !== payloadHash) {
      throw new AdmissionError("IDEMPOTENCY_KEY_REUSED", 409, "idempotency key was used with a different payload");
    }
    return replay(runtime, existing.id);
  }

  // Refresh marks and symbol rules outside the transaction (prd.md 11.3).
  const balances = await withClient(pool, (client) => listAssetBalances(client, account.id));
  const heldSymbols = balances
    .filter((b) => b.asset !== quote && dec(b.owned_quantity).gt(0))
    .map((b) => `${b.asset}${quote}`);
  await refreshMarks(runtime, account.id, [intent.symbol, ...heldSymbols]);
  await refreshSymbolRules(runtime, account.id, intent.symbol, newId);

  return withTransaction(pool, async (tx) => {
    const now = runtime.clock();
    const accountRow = await lockAccountRow(tx, account.id);
    const agent = await lockAgentRow(tx, input.agent.id);
    if (agent === null || agent.account_id !== account.id)
      throw new AdmissionError("FORBIDDEN", 403, "agent is not bound to this account");

    // Re-check idempotency under the lock (a concurrent duplicate may have landed).
    const raced = await findIntentByIdempotencyKey(tx, account.id, agent.id, input.idempotencyKey);
    if (raced !== null) {
      if (raced.payload_hash !== payloadHash) {
        throw new AdmissionError("IDEMPOTENCY_KEY_REUSED", 409, "idempotency key was used with a different payload");
      }
      return loadOutcome(runtime, tx, raced.id, 200);
    }

    const lease = await getLeaseById(tx, intent.lease_id, { lock: true });
    if (lease === null || lease.account_id !== account.id) {
      throw new AdmissionError("NOT_FOUND", 404, "lease not found for this identity");
    }
    const policyRow = await getCurrentPolicy(tx, account.id);
    if (policyRow === null) throw new AdmissionError("NOT_READY", 503, "no policy version exists for this account");
    const policy = PolicySchema.parse(policyRow.canonical_policy);

    const rulesRow = await latestSnapshotsBySymbol(tx, account.id, "SYMBOL_RULES", [intent.symbol]);
    const rules = rulesFromSnapshot(rulesRow.get(intent.symbol));
    const refRows = await getSnapshotsByIds(tx, account.id, intent.observation_ids);
    const observations: ObservationView[] = refRows
      .filter((r) => r.type === "MARKET")
      .map((r) => ({
        snapshot_id: r.id,
        symbol: typeof r.payload.symbol === "string" ? r.payload.symbol : "",
        received_at: r.received_at.toISOString(),
        source_timestamp: r.source_time?.toISOString() ?? null,
        payload_hash: r.payload_hash,
      }));
    const markRows = await latestSnapshotsBySymbol(tx, account.id, "MARKET", [intent.symbol, ...heldSymbols]);
    const marks: MarkView[] = [...markRows.values()].map(markFromSnapshot).filter((m): m is MarkView => m !== null);

    const quoteRow = balances.find((b) => b.asset === quote);
    const holdings = balances
      .filter((b) => b.asset !== quote)
      .map((b) => ({ asset: b.asset, quantity: b.owned_quantity }));
    const baseAsset = rules?.base_asset ?? "";
    const allocations = await listInventoryAllocations(tx, account.id, agent.id);
    const agentBase = allocations.find((a) => a.asset === baseAsset)?.owned_quantity ?? "0";

    const pending = await listPendingBuyProposals(tx, account.id);
    const symbolMark = marks.find((m) => m.symbol === intent.symbol);
    let pendingExposure = ZERO;
    let pendingFees = ZERO;
    for (const p of pending) {
      const order = p.normalized_order;
      if (order.side !== "BUY") continue;
      pendingFees = pendingFees.plus(dec(order.fee_reserve_quote));
      if (order.symbol === intent.symbol) {
        const unit =
          symbolMark === undefined ? dec(order.limit_price) : max(dec(symbolMark.price), dec(order.limit_price));
        pendingExposure = pendingExposure.plus(mul(dec(order.quantity), unit));
      }
    }

    const evaluation: EvaluationInput = {
      now: now.toISOString(),
      intent,
      agent: { id: agent.id, status: agent.status, revision: agent.revision },
      account: {
        id: accountRow.id,
        status: accountRow.status,
        epoch: accountRow.epoch,
        quote_asset: accountRow.quote_asset,
      },
      lease: {
        id: lease.id,
        revision: lease.revision,
        agent_id: lease.agent_id,
        status: lease.status,
        budget_quote: lease.budget_quote,
        consumed_quote: lease.consumed_quote,
        attempt_limit: lease.attempt_limit,
        attempts_consumed: lease.attempts_consumed,
        starts_at: lease.starts_at.toISOString(),
        expires_at: lease.expires_at.toISOString(),
        allowed_symbols: lease.capability_json.allowed_symbols,
        allowed_sides: lease.capability_json.allowed_sides,
        allowed_order_types: lease.capability_json.allowed_order_types,
      },
      policy: { ...policy, version: policyRow.version },
      symbol_rules: rules,
      observations,
      marks,
      resources: {
        quote_owned: quoteRow?.owned_quantity ?? "0",
        outstanding_quote_reservations: await sumOutstandingQuote(tx, account.id),
        unresolved_debit_quote: "0",
        lease_outstanding_buy_quote: await sumOutstandingQuoteForLease(tx, lease.id),
        lease_reserved_attempts: await countReservedAttemptsForLease(tx, lease.id),
        agent_base_owned: agentBase,
        agent_base_reserved: baseAsset === "" ? "0" : await sumReservedBase(tx, account.id, agent.id, baseAsset),
        holdings,
        pending_buy_exposure_quote: toDecimalString(pendingExposure),
        pending_fee_reserves_quote: toDecimalString(pendingFees),
        ledger_version: await ledgerVersion(tx, account.id),
      },
    };

    const result = evaluate(evaluation);
    const persisted = await persistDecision(runtime, tx, {
      now,
      intent,
      payloadHash,
      idempotencyKey: input.idempotencyKey,
      agentId: agent.id,
      accountId: account.id,
      accountEpoch: accountRow.epoch,
      lease: { id: lease.id, revision: lease.revision, expires_at: lease.expires_at },
      policy: { id: policyRow.id, version: policyRow.version, max_proposal_age_ms: policy.max_proposal_age_ms },
      quoteAsset: quote,
      baseAsset,
      result,
    });
    return { status: 201, response: persisted };
  });
}

async function persistDecision(
  runtime: KernelRuntime,
  tx: Parameters<typeof insertIntent>[0],
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
  },
): Promise<DecisionResponse> {
  const { now, intent, result } = args;
  const intentId = newId("intent");
  const receiptId = newId("receipt");
  const engineVersion = runtime.config.engineVersion;
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

  const evaluatedAt = now.toISOString();
  const fingerprint = decisionFingerprint({
    engine_version: engineVersion,
    normalized_request: result.normalized_request,
    input_refs: result.input_refs,
    outcome: result.outcome,
    reason_codes: result.reason_codes,
    checks: result.checks,
    evaluated_at: evaluatedAt,
  });

  let proposal: ProposalRow | null = null;
  if (result.candidate !== null) {
    const proposalId = newId("proposal");
    const expiresAt = new Date(
      Math.min(now.getTime() + args.policy.max_proposal_age_ms, args.lease.expires_at.getTime()),
    );
    const proposalHash = hashCanonical({
      account_id: args.accountId,
      intent_id: intentId,
      revision: 1,
      policy_version: args.policy.version,
      lease_revision: args.lease.revision,
      account_epoch: args.accountEpoch,
      environment: runtime.config.environment,
      order: result.candidate,
    });
    await insertProposal(tx, {
      id: proposalId,
      intentId,
      accountId: args.accountId,
      revision: 1,
      normalizedOrder: result.candidate,
      proposalHash,
      state: "COLLECTING",
      expiresAt,
      policyId: args.policy.id,
      leaseRevision: args.lease.revision,
      accountEpoch: args.accountEpoch,
      now,
    });
    const reservations: Array<{ asset: string; amount: string; kind: "QUOTE" | "BASE" | "ATTEMPT" }> = [];
    const candidate: CandidateOrder = result.candidate;
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
    proposal = {
      id: proposalId,
      intent_id: intentId,
      account_id: args.accountId,
      revision: 1,
      normalized_order: candidate,
      proposal_hash: proposalHash,
      state: "COLLECTING",
      expires_at: expiresAt,
      policy_id: args.policy.id,
      lease_revision: args.lease.revision,
      account_epoch: args.accountEpoch,
      created_at: now,
      updated_at: now,
    };
    await appendAuditEvent(tx, {
      id: newId("evt"),
      accountId: args.accountId,
      type: "RESERVATION_CREATED",
      payload: { proposal_id: proposalId, reservations },
      occurredAt: now,
    });
  }

  await insertReceipt(tx, {
    id: receiptId,
    accountId: args.accountId,
    intentId,
    proposalId: proposal?.id ?? null,
    outcome: result.outcome,
    reasons: result.reason_codes,
    inputRefs: result.input_refs,
    checks: result.checks,
    normalizedRequest: result.normalized_request,
    decisionFingerprint: fingerprint,
    evaluatedAt: now,
    engineVersion,
  });
  await appendAuditEvent(tx, {
    id: newId("evt"),
    accountId: args.accountId,
    type: "DECISION_RECORDED",
    payload: {
      receipt_id: receiptId,
      intent_id: intentId,
      proposal_id: proposal?.id ?? null,
      outcome: result.outcome,
      reason_codes: result.reason_codes,
      decision_fingerprint: fingerprint,
    },
    occurredAt: now,
  });

  const receipt: ReceiptRow = {
    id: receiptId,
    account_id: args.accountId,
    intent_id: intentId,
    proposal_id: proposal?.id ?? null,
    outcome: result.outcome,
    reasons: result.reason_codes,
    input_refs: result.input_refs,
    checks: result.checks,
    normalized_request: result.normalized_request,
    decision_fingerprint: fingerprint,
    evaluated_at: now,
    engine_version: engineVersion,
  };
  return responseFrom(
    runtime,
    intentId,
    receipt,
    proposal,
    args.lease.revision,
    args.policy.version,
    args.accountEpoch,
  );
}

async function loadOutcome(
  runtime: KernelRuntime,
  client: Parameters<typeof getLatestReceiptForIntent>[0],
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
    ),
  };
}

async function replay(runtime: KernelRuntime, intentId: string): Promise<AdmissionOutcome> {
  const pool = runtime.pool;
  if (pool === null) throw new AdmissionError("NOT_READY", 503, "no database");
  return withClient(pool, (client) => loadOutcome(runtime, client, intentId, 200));
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
