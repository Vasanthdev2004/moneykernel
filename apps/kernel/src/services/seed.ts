import { DEFAULT_POLICY, LeaseCapabilitiesSchema, type PolicyInput } from "@moneykernel/contracts";
import type { Scenario } from "@moneykernel/integrations";
import { lockAccountRow, recordSnapshot, withTransaction } from "@moneykernel/persistence";
import type { KernelRuntime } from "../boot.ts";
import { newId } from "../ids.ts";
import { issueLease, registerAgent, resumeAccount, setPolicy, setVirtualBalances } from "./registry.ts";

export type SeededAgent = { fixture_agent_id: string; agent_id: string; name: string; token: string; lease_id: string };
export type SeedResult = { account_id: string; policy_version: number; agents: SeededAgent[]; symbols: string[] };

/**
 * Initializes one pristine, paused virtual account in one transaction. A new
 * scenario run requires a fresh account alias; seeding never resets an old run.
 * Market reads happen before the account lock. Concurrent seeds serialize on
 * that lock, and the loser sees the committed first run before writing anything.
 */
export async function seedScenario(
  runtime: KernelRuntime,
  scenario: Scenario,
  options: { operatorId?: string; leaseDurationMs?: number; idSuffix?: string } = {},
): Promise<SeedResult> {
  const pool = runtime.pool;
  const account = runtime.account;
  if (pool === null || account === null) throw new Error("kernel has no loaded account");
  if (runtime.config.environment === "TESTNET") throw new Error("seeding virtual funds is not allowed in TESTNET");
  if (runtime.bootChecks.some((check) => !check.ok)) throw new Error("kernel readiness checks block scenario seeding");
  const market = runtime.market;
  if (market === null) throw new Error("a qualified market adapter is required before seeding");
  const operatorId = options.operatorId ?? "seed";
  // Fixture ids are reused across runs and accounts, so every seeded agent and lease gets a run tag.
  const runTag = options.idSuffix ?? newId("r").slice(-8);

  const policyInput: PolicyInput = {
    ...DEFAULT_POLICY,
    ...(scenario.policy ?? {}),
    ...(scenario.policy_overrides ?? {}),
  } as PolicyInput;
  const symbols = Object.keys(scenario.symbol_rules ?? {});
  const symbolRules = await Promise.all(symbols.map((symbol) => market.getSymbolRules(symbol)));

  return withTransaction(pool, async (tx) => {
    const current = await lockAccountRow(tx, account.id);
    if (current.status !== "PAUSED")
      throw new Error("seeding requires a pristine PAUSED account; use a fresh account alias");
    if (current.environment !== runtime.config.environment || current.quote_asset !== scenario.account.quote_asset) {
      throw new Error("scenario environment or quote asset does not match the account");
    }
    const existing = await tx.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM agents WHERE account_id = $1
         UNION ALL SELECT 1 FROM policy_versions WHERE account_id = $1
         UNION ALL SELECT 1 FROM asset_balances WHERE account_id = $1
         UNION ALL SELECT 1 FROM inventory_allocations WHERE account_id = $1
         UNION ALL SELECT 1 FROM intents WHERE account_id = $1
         UNION ALL SELECT 1 FROM ledger_entries WHERE account_id = $1
         UNION ALL SELECT 1 FROM snapshots WHERE account_id = $1
         UNION ALL SELECT 1 FROM incidents WHERE account_id = $1
         UNION ALL SELECT 1 FROM audit_events WHERE account_id = $1 AND type NOT IN ('ACCOUNT_CREATED', 'ACCOUNT_BOOTED')
       ) AS present`,
      [account.id],
    );
    if (existing.rows[0]?.present) throw new Error("account already contains a run; use a fresh account alias");

    const now = runtime.clock();
    const policy = await setPolicy(pool, account.id, policyInput, operatorId, now, tx);
    const agents: SeededAgent[] = [];
    const allocations: Record<string, Record<string, string>> = { ...scenario.account.inventory_allocations };
    for (const fixtureAgent of scenario.agents) {
      const id = `${fixtureAgent.agent_id}_${runTag}`;
      const { agent, token } = await registerAgent(
        pool,
        account.id,
        { id, name: fixtureAgent.name, strategyKind: fixtureAgent.strategy_kind },
        now,
        tx,
      );
      const fixtureLease = fixtureAgent.lease;
      const duration =
        options.leaseDurationMs ??
        Math.max(60_000, Date.parse(fixtureLease.expires_at) - Date.parse(fixtureLease.starts_at));
      const lease = await issueLease(
        pool,
        account.id,
        {
          id: `${fixtureLease.lease_id}_${runTag}`,
          agentId: agent.id,
          budgetQuote: fixtureLease.acquisition_budget_quote,
          attemptLimit: fixtureLease.max_submission_attempts,
          startsAt: now,
          expiresAt: new Date(now.getTime() + duration),
          capabilities: LeaseCapabilitiesSchema.parse({
            allowed_symbols: fixtureLease.allowed_symbols,
            allowed_sides: fixtureLease.allowed_sides,
            allowed_order_types: fixtureLease.allowed_order_types,
          }),
        },
        now,
        tx,
      );
      if (fixtureLease.assigned_inventory !== undefined) {
        allocations[agent.id] = { ...(allocations[agent.id] ?? {}), ...fixtureLease.assigned_inventory };
      }
      const fixtureKeyed = allocations[fixtureAgent.agent_id];
      if (fixtureKeyed !== undefined && fixtureAgent.agent_id !== agent.id) {
        allocations[agent.id] = { ...(allocations[agent.id] ?? {}), ...fixtureKeyed };
        delete allocations[fixtureAgent.agent_id];
      }
      agents.push({
        fixture_agent_id: fixtureAgent.agent_id,
        agent_id: agent.id,
        name: agent.name,
        token,
        lease_id: lease.id,
      });
    }

    await setVirtualBalances(
      pool,
      account.id,
      { balances: scenario.account.balances, allocations, operatorId },
      now,
      tx,
    );
    for (const rules of symbolRules) {
      await recordSnapshot(tx, {
        id: newId("rules"),
        accountId: account.id,
        type: "SYMBOL_RULES",
        source: rules.source,
        sourceTime: null,
        receivedAt: new Date(rules.received_at),
        payload: { ...rules },
        payloadHash: rules.payload_hash,
        parserVersion: "rules-1",
      });
    }
    await resumeAccount(pool, account.id, operatorId, now, tx);
    return { account_id: account.id, policy_version: policy.version, agents, symbols };
  });
}
