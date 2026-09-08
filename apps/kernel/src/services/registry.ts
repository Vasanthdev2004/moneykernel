import { createHash, randomBytes } from "node:crypto";
import {
  AssetSchema,
  hashCanonical,
  type LeaseCapabilities,
  NonNegativeDecimalStringSchema,
  type PolicyInput,
  PolicySchema,
} from "@moneykernel/contracts";
import { dec, toDecimalString, ZERO } from "@moneykernel/domain";
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
  type PoolClient,
  setAccountStatus,
  UNASSIGNED_OWNER,
  upsertAssetBalance,
  upsertInventoryAllocation,
  withTransaction,
} from "@moneykernel/persistence";
import { newId } from "../ids.ts";

/** Compose registry changes in a caller-owned transaction without taking another pool connection. */
function registryTransaction<T>(
  pool: Pool,
  transaction: PoolClient | undefined,
  fn: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  return transaction === undefined ? withTransaction(pool, fn) : fn(transaction);
}

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
  transaction?: PoolClient,
): Promise<{ agent: AgentRow; token: string }> {
  const { token, hash } = generateAgentToken();
  const agent = await registryTransaction(pool, transaction, async (tx) => {
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
  transaction?: PoolClient,
): Promise<LeaseRow> {
  return registryTransaction(pool, transaction, async (tx) => {
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
  transaction?: PoolClient,
): Promise<PolicyVersionRow> {
  const policy = PolicySchema.parse(input);
  return registryTransaction(pool, transaction, async (tx) => {
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
export async function resumeAccount(
  pool: Pool,
  accountId: string,
  operatorId: string,
  now: Date,
  transaction?: PoolClient,
): Promise<AccountRow> {
  return registryTransaction(pool, transaction, async (tx) => {
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
  transaction?: PoolClient,
): Promise<void> {
  await registryTransaction(pool, transaction, async (tx) => {
    const account = await lockAccountRow(tx, accountId);
    if (account.environment === "TESTNET") throw new Error("virtual balances are not allowed in TESTNET");
    if (account.status !== "PAUSED") throw new Error("virtual baseline requires a PAUSED account");
    const existing = await tx.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM asset_balances WHERE account_id = $1
         UNION ALL SELECT 1 FROM inventory_allocations WHERE account_id = $1
         UNION ALL SELECT 1 FROM ledger_entries WHERE account_id = $1
         UNION ALL SELECT 1 FROM audit_events WHERE account_id = $1 AND type = 'INVENTORY_ASSIGNED'
       ) AS present`,
      [accountId],
    );
    if (existing.rows[0]?.present) throw new Error("virtual baseline already exists; use a fresh account alias");

    const balances = new Map<string, string>();
    for (const [asset, quantity] of Object.entries(input.balances)) {
      balances.set(AssetSchema.parse(asset), NonNegativeDecimalStringSchema.parse(quantity));
    }
    const owners = Object.keys(input.allocations)
      .filter((owner) => owner !== UNASSIGNED_OWNER)
      .sort();
    const bound = await tx.query<{ id: string }>(
      "SELECT id FROM agents WHERE account_id = $1 AND id = ANY($2::text[]) ORDER BY id FOR UPDATE",
      [accountId, owners],
    );
    if (bound.rows.length !== owners.length) throw new Error("inventory owner is not bound to this account");

    const allocations = new Map<string, Map<string, string>>();
    const assigned = new Map<string, ReturnType<typeof dec>>();
    for (const [owner, assets] of Object.entries(input.allocations)) {
      const normalized = new Map<string, string>();
      for (const [rawAsset, quantity] of Object.entries(assets)) {
        const asset = AssetSchema.parse(rawAsset);
        if (!balances.has(asset)) throw new Error(`allocation asset ${asset} has no owned balance`);
        const amount = NonNegativeDecimalStringSchema.parse(quantity);
        normalized.set(asset, amount);
        assigned.set(asset, (assigned.get(asset) ?? ZERO).plus(dec(amount)));
      }
      allocations.set(owner, normalized);
    }
    const unassigned = allocations.get(UNASSIGNED_OWNER) ?? new Map<string, string>();
    for (const [asset, owned] of balances) {
      const residual = dec(owned).minus(assigned.get(asset) ?? ZERO);
      if (residual.lt(0)) throw new Error(`inventory allocations exceed owned ${asset}`);
      unassigned.set(asset, toDecimalString(dec(unassigned.get(asset) ?? "0").plus(residual)));
    }
    allocations.set(UNASSIGNED_OWNER, unassigned);

    const baselineRef = newId("baseline");
    let sequence = 0;
    for (const asset of [...balances.keys()].sort()) {
      const quantity = balances.get(asset) as string;
      await upsertAssetBalance(tx, accountId, asset, quantity);
      await tx.query(
        `INSERT INTO ledger_entries (id, account_id, agent_id, asset, signed_delta, category, source_ref, sequence, created_at)
         VALUES ($1, $2, NULL, $3, $4, 'BASELINE', $5, $6, $7)`,
        [newId("ledger"), accountId, asset, quantity, baselineRef, ++sequence, now],
      );
    }
    for (const [owner, assets] of [...allocations.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      for (const asset of [...assets.keys()].sort()) {
        await upsertInventoryAllocation(tx, accountId, owner, asset, assets.get(asset) as string);
      }
    }
    await appendAuditEvent(tx, {
      id: newId("evt"),
      accountId,
      type: "INVENTORY_ASSIGNED",
      payload: {
        operator_id: input.operatorId,
        baseline_ref: baselineRef,
        ledger_version: sequence,
        balances: Object.fromEntries(balances),
        allocations: Object.fromEntries([...allocations].map(([owner, assets]) => [owner, Object.fromEntries(assets)])),
        note: "virtual baseline; internal attribution, not a transfer",
      },
      occurredAt: now,
    });
  });
}
