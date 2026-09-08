import { createHash, randomBytes } from "node:crypto";
import { hashCanonical, type LeaseCapabilities, type PolicyInput, PolicySchema } from "@moneykernel/contracts";
import {
  type AccountRow,
  type AgentRow,
  appendAuditEvent,
  createAgent,
  createLease,
  createPolicyVersion,
  findActiveLeaseForAgent,
  type LeaseRow,
  lockAccountRow,
  type PolicyVersionRow,
  type Pool,
  setAccountStatus,
  upsertAssetBalance,
  upsertInventoryAllocation,
  withTransaction,
} from "@moneykernel/persistence";
import { newId } from "../ids.ts";

/** Agent tokens: random, high entropy, shown once; only the sha256 is stored (FR-01). */
export function generateAgentToken(): { token: string; hash: string } {
  const token = `mka_${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashAgentToken(token) };
}

export function hashAgentToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function registerAgent(
  pool: Pool,
  accountId: string,
  input: { name: string; strategyKind: string; id?: string },
  now: Date,
): Promise<{ agent: AgentRow; token: string }> {
  const { token, hash } = generateAgentToken();
  const agent = await withTransaction(pool, async (tx) => {
    await lockAccountRow(tx, accountId);
    const row = await createAgent(tx, {
      id: input.id ?? newId("agent"),
      accountId,
      name: input.name,
      strategyKind: input.strategyKind,
      tokenHash: hash,
      now,
    });
    await appendAuditEvent(tx, {
      id: newId("evt"),
      accountId,
      type: "AGENT_REGISTERED",
      payload: { agent_id: row.id, name: row.name, strategy_kind: row.strategy_kind },
      occurredAt: now,
    });
    return row;
  });
  return { agent, token };
}

export class LeaseConflictError extends Error {
  constructor(agentId: string) {
    super(`agent ${agentId} already has an active lease`);
    this.name = "LeaseConflictError";
  }
}

export async function issueLease(
  pool: Pool,
  accountId: string,
  input: {
    agentId: string;
    budgetQuote: string;
    attemptLimit: number;
    startsAt: Date;
    expiresAt: Date;
    capabilities: LeaseCapabilities;
    id?: string;
  },
  now: Date,
): Promise<LeaseRow> {
  return withTransaction(pool, async (tx) => {
    await lockAccountRow(tx, accountId);
    const active = await findActiveLeaseForAgent(tx, accountId, input.agentId, { lock: true });
    if (active !== null) throw new LeaseConflictError(input.agentId);
    const lease = await createLease(tx, {
      id: input.id ?? newId("lease"),
      accountId,
      agentId: input.agentId,
      budgetQuote: input.budgetQuote,
      attemptLimit: input.attemptLimit,
      startsAt: input.startsAt,
      expiresAt: input.expiresAt,
      capabilities: input.capabilities,
      now,
    });
    await appendAuditEvent(tx, {
      id: newId("evt"),
      accountId,
      type: "LEASE_ISSUED",
      payload: {
        lease_id: lease.id,
        agent_id: lease.agent_id,
        budget_quote: lease.budget_quote,
        attempt_limit: lease.attempt_limit,
        starts_at: lease.starts_at.toISOString(),
        expires_at: lease.expires_at.toISOString(),
        capabilities: input.capabilities,
      },
      occurredAt: now,
    });
    return lease;
  });
}

export async function setPolicy(
  pool: Pool,
  accountId: string,
  input: PolicyInput,
  createdBy: string,
  now: Date,
): Promise<PolicyVersionRow> {
  const policy = PolicySchema.parse(input);
  return withTransaction(pool, async (tx) => {
    await lockAccountRow(tx, accountId);
    const row = await createPolicyVersion(tx, {
      id: newId("policy"),
      accountId,
      policy,
      hash: hashCanonical(policy),
      createdBy,
      now,
    });
    await appendAuditEvent(tx, {
      id: newId("evt"),
      accountId,
      type: "POLICY_UPDATED",
      payload: { policy_id: row.id, version: row.version, hash: row.hash, created_by: createdBy },
      occurredAt: now,
    });
    return row;
  });
}

/** Operator resume (prd.md 5.1). Readiness gating arrives with the operator API; the seed uses this directly. */
export async function resumeAccount(pool: Pool, accountId: string, operatorId: string, now: Date): Promise<AccountRow> {
  return withTransaction(pool, async (tx) => {
    await lockAccountRow(tx, accountId);
    const row = await setAccountStatus(tx, accountId, "READY", now);
    await appendAuditEvent(tx, {
      id: newId("evt"),
      accountId,
      type: "ACCOUNT_RESUMED",
      payload: { operator_id: operatorId, status: row.status, epoch: row.epoch },
      occurredAt: now,
    });
    return row;
  });
}

/** Virtual-fund baseline for REPLAY/SHADOW: owned balances and internal attribution (prd.md 9.4). */
export async function setVirtualBalances(
  pool: Pool,
  accountId: string,
  input: { balances: Record<string, string>; allocations: Record<string, Record<string, string>>; operatorId: string },
  now: Date,
): Promise<void> {
  await withTransaction(pool, async (tx) => {
    await lockAccountRow(tx, accountId);
    for (const [asset, quantity] of Object.entries(input.balances))
      await upsertAssetBalance(tx, accountId, asset, quantity);
    for (const [owner, assets] of Object.entries(input.allocations)) {
      for (const [asset, quantity] of Object.entries(assets))
        await upsertInventoryAllocation(tx, accountId, owner, asset, quantity);
    }
    await appendAuditEvent(tx, {
      id: newId("evt"),
      accountId,
      type: "INVENTORY_ASSIGNED",
      payload: {
        operator_id: input.operatorId,
        balances: input.balances,
        allocations: input.allocations,
        note: "virtual baseline; internal attribution, not a transfer",
      },
      occurredAt: now,
    });
  });
}
