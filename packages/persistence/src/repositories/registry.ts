import type { LeaseCapabilities } from "@moneykernel/contracts";
import type { PoolClient } from "pg";

export type AgentStatus = "ACTIVE" | "QUARANTINED" | "DISABLED";
export type LeaseStatus = "ACTIVE" | "EXPIRED" | "REVOKED" | "EXHAUSTED";

export type AgentRow = {
  id: string;
  account_id: string;
  name: string;
  strategy_kind: string;
  status: AgentStatus;
  revision: number;
  token_hash: string;
  created_at: Date;
  updated_at: Date;
};

export type LeaseRow = {
  id: string;
  account_id: string;
  agent_id: string;
  revision: number;
  budget_quote: string;
  consumed_quote: string;
  attempt_limit: number;
  attempts_consumed: number;
  starts_at: Date;
  expires_at: Date;
  status: LeaseStatus;
  capability_json: LeaseCapabilities;
  created_at: Date;
  updated_at: Date;
};

export type PolicyVersionRow = {
  id: string;
  account_id: string;
  version: number;
  canonical_policy: Record<string, unknown>;
  hash: string;
  created_by: string;
  created_at: Date;
};

// --- agents -----------------------------------------------------------------

export async function createAgent(
  client: PoolClient,
  input: { id: string; accountId: string; name: string; strategyKind: string; tokenHash: string; now: Date },
): Promise<AgentRow> {
  const result = await client.query<AgentRow>(
    `INSERT INTO agents (id, account_id, name, strategy_kind, status, revision, token_hash, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'ACTIVE', 1, $5, $6, $6) RETURNING *`,
    [input.id, input.accountId, input.name, input.strategyKind, input.tokenHash, input.now],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("agent insert returned no row");
  return row;
}

export async function findAgentByTokenHash(client: PoolClient, tokenHash: string): Promise<AgentRow | null> {
  const result = await client.query<AgentRow>("SELECT * FROM agents WHERE token_hash = $1", [tokenHash]);
  return result.rows[0] ?? null;
}

export async function getAgentById(client: PoolClient, id: string): Promise<AgentRow | null> {
  const result = await client.query<AgentRow>("SELECT * FROM agents WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}

/** Second step of the fixed lock order (account, agent, lease, ...). */
export async function lockAgentRow(client: PoolClient, id: string): Promise<AgentRow | null> {
  const result = await client.query<AgentRow>("SELECT * FROM agents WHERE id = $1 FOR UPDATE", [id]);
  return result.rows[0] ?? null;
}

export async function listAgents(client: PoolClient, accountId: string): Promise<AgentRow[]> {
  const result = await client.query<AgentRow>("SELECT * FROM agents WHERE account_id = $1 ORDER BY created_at", [
    accountId,
  ]);
  return result.rows;
}

export async function setAgentStatus(
  client: PoolClient,
  id: string,
  status: AgentStatus,
  now: Date,
): Promise<AgentRow> {
  const result = await client.query<AgentRow>(
    "UPDATE agents SET status = $2, revision = revision + 1, updated_at = $3 WHERE id = $1 RETURNING *",
    [id, status, now],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`agent ${id} not found`);
  return row;
}

// --- leases -----------------------------------------------------------------

export async function createLease(
  client: PoolClient,
  input: {
    id: string;
    accountId: string;
    agentId: string;
    budgetQuote: string;
    attemptLimit: number;
    startsAt: Date;
    expiresAt: Date;
    capabilities: LeaseCapabilities;
    now: Date;
  },
): Promise<LeaseRow> {
  const result = await client.query<LeaseRow>(
    `INSERT INTO leases (id, account_id, agent_id, revision, budget_quote, consumed_quote, attempt_limit, attempts_consumed,
                         starts_at, expires_at, status, capability_json, created_at, updated_at)
     VALUES ($1, $2, $3, 1, $4, 0, $5, 0, $6, $7, 'ACTIVE', $8::jsonb, $9, $9) RETURNING *`,
    [
      input.id,
      input.accountId,
      input.agentId,
      input.budgetQuote,
      input.attemptLimit,
      input.startsAt,
      input.expiresAt,
      JSON.stringify(input.capabilities),
      input.now,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("lease insert returned no row");
  return row;
}

export async function getLeaseById(
  client: PoolClient,
  id: string,
  options: { lock?: boolean } = {},
): Promise<LeaseRow | null> {
  const result = await client.query<LeaseRow>(
    `SELECT * FROM leases WHERE id = $1${options.lock ? " FOR UPDATE" : ""}`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function findActiveLeaseForAgent(
  client: PoolClient,
  accountId: string,
  agentId: string,
  options: { lock?: boolean } = {},
): Promise<LeaseRow | null> {
  const result = await client.query<LeaseRow>(
    `SELECT * FROM leases WHERE account_id = $1 AND agent_id = $2 AND status = 'ACTIVE'${options.lock ? " FOR UPDATE" : ""}`,
    [accountId, agentId],
  );
  return result.rows[0] ?? null;
}

export async function listLeases(client: PoolClient, accountId: string): Promise<LeaseRow[]> {
  const result = await client.query<LeaseRow>("SELECT * FROM leases WHERE account_id = $1 ORDER BY created_at", [
    accountId,
  ]);
  return result.rows;
}

export async function setLeaseStatus(
  client: PoolClient,
  id: string,
  status: LeaseStatus,
  now: Date,
): Promise<LeaseRow> {
  const result = await client.query<LeaseRow>(
    "UPDATE leases SET status = $2, revision = revision + 1, updated_at = $3 WHERE id = $1 RETURNING *",
    [id, status, now],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`lease ${id} not found`);
  return row;
}

// --- policy versions ----------------------------------------------------------

export async function createPolicyVersion(
  client: PoolClient,
  input: { id: string; accountId: string; policy: Record<string, unknown>; hash: string; createdBy: string; now: Date },
): Promise<PolicyVersionRow> {
  const next = await client.query<{ v: number }>(
    "SELECT COALESCE(MAX(version), 0) + 1 AS v FROM policy_versions WHERE account_id = $1",
    [input.accountId],
  );
  const version = next.rows[0]?.v ?? 1;
  const result = await client.query<PolicyVersionRow>(
    `INSERT INTO policy_versions (id, account_id, version, canonical_policy, hash, created_by, created_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7) RETURNING *`,
    [input.id, input.accountId, version, JSON.stringify(input.policy), input.hash, input.createdBy, input.now],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("policy insert returned no row");
  return row;
}

export async function getCurrentPolicy(client: PoolClient, accountId: string): Promise<PolicyVersionRow | null> {
  const result = await client.query<PolicyVersionRow>(
    "SELECT * FROM policy_versions WHERE account_id = $1 ORDER BY version DESC LIMIT 1",
    [accountId],
  );
  return result.rows[0] ?? null;
}
