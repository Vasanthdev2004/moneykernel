import type { PoolClient } from "pg";

/**
 * Whole-account reads for the sanitized run export (prd.md 15.2, 23.4). Every
 * query is scoped to one account and ordered deterministically. Agent token
 * hashes are excluded at the SQL level so no caller can leak them by accident.
 */
type Row = Record<string, unknown>;

async function rows(client: PoolClient, sql: string, accountId: string): Promise<Row[]> {
  const result = await client.query<Row>(sql, [accountId]);
  return result.rows;
}

export async function exportAccountRows(client: PoolClient, accountId: string) {
  return {
    policy_versions: await rows(
      client,
      "SELECT id, version, canonical_policy AS policy, hash, created_by, created_at FROM policy_versions WHERE account_id = $1 ORDER BY version",
      accountId,
    ),
    agents: await rows(
      client,
      "SELECT id, name, strategy_kind, status, revision, created_at, updated_at FROM agents WHERE account_id = $1 ORDER BY created_at, id",
      accountId,
    ),
    leases: await rows(
      client,
      `SELECT id, agent_id, revision, budget_quote::text, consumed_quote::text, attempt_limit, attempts_consumed, starts_at, expires_at,
              status, capability_json, created_at, updated_at
         FROM leases WHERE account_id = $1 ORDER BY created_at, id`,
      accountId,
    ),
    intents: await rows(
      client,
      "SELECT id, agent_id, lease_id, idempotency_key, canonical_payload, payload_hash, account_seq, created_at FROM intents WHERE account_id = $1 ORDER BY account_seq",
      accountId,
    ),
    receipts: await rows(
      client,
      `SELECT id, intent_id, proposal_id, outcome, reasons, input_refs, checks, normalized_request, decision_fingerprint,
              evaluated_at, engine_version, evaluation_input
         FROM decision_receipts WHERE account_id = $1 ORDER BY evaluated_at, id`,
      accountId,
    ),
    proposals: await rows(
      client,
      `SELECT id, intent_id, revision, normalized_order, proposal_hash, state, expires_at, policy_id, lease_revision, account_epoch,
              created_at, updated_at
         FROM proposals WHERE account_id = $1 ORDER BY created_at, id`,
      accountId,
    ),
    reservations: await rows(
      client,
      `SELECT id, proposal_id, agent_id, asset, amount::text, kind, state, created_at, armed_at, released_at
         FROM reservations WHERE account_id = $1 ORDER BY created_at, id`,
      accountId,
    ),
    approvals: await rows(
      client,
      `SELECT id, proposal_id, proposal_revision, proposal_hash, operator_id, account_epoch, expires_at, status, consumed_at, created_at
         FROM approvals WHERE account_id = $1 ORDER BY created_at, id`,
      accountId,
    ),
    commands: await rows(
      client,
      `SELECT id, proposal_id, approval_id, client_order_id, state, exact_payload, armed_at, outcome_ref, reconciled_at, created_at, updated_at
         FROM commands WHERE account_id = $1 ORDER BY created_at, id`,
      accountId,
    ),
    orders: await rows(
      client,
      `SELECT id, command_id, exchange_order_id, client_order_id, symbol, status, executed_base::text, executed_quote::text, last_observed_at
         FROM orders WHERE account_id = $1 ORDER BY last_observed_at, id`,
      accountId,
    ),
    fills: await rows(
      client,
      `SELECT id, order_id, exchange_trade_id, symbol, base_qty::text, price::text, quote_qty::text, commission_asset, commission_qty::text, event_time
         FROM fills WHERE account_id = $1 ORDER BY event_time, id`,
      accountId,
    ),
    ledger_entries: await rows(
      client,
      `SELECT id, agent_id, asset, signed_delta::text, category, source_fill_id, source_ref, sequence, created_at
         FROM ledger_entries WHERE account_id = $1 ORDER BY sequence`,
      accountId,
    ),
    balances: await rows(
      client,
      "SELECT asset, owned_quantity::text, version FROM asset_balances WHERE account_id = $1 ORDER BY asset",
      accountId,
    ),
    allocations: await rows(
      client,
      "SELECT agent_or_unassigned_id, asset, owned_quantity::text, version FROM inventory_allocations WHERE account_id = $1 ORDER BY agent_or_unassigned_id, asset",
      accountId,
    ),
    conflicts: await rows(
      client,
      `SELECT c.id, c.symbol, c.status, c.resolution, c.operator_id, c.created_at, c.resolved_at,
              (SELECT array_agg(m.proposal_id ORDER BY m.proposal_id) FROM conflict_members m WHERE m.conflict_id = c.id) AS proposal_ids
         FROM conflicts c WHERE c.account_id = $1 ORDER BY c.created_at, c.id`,
      accountId,
    ),
    incidents: await rows(
      client,
      "SELECT id, agent_id, type, severity, status, evidence_refs, resolved_by, created_at, resolved_at FROM incidents WHERE account_id = $1 ORDER BY created_at, id",
      accountId,
    ),
  };
}
