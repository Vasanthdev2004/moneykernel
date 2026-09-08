import { DEFAULT_POLICY, LeaseCapabilitiesSchema, type PolicyInput } from "@moneykernel/contracts";
import type { Scenario } from "@moneykernel/integrations";
import type { KernelRuntime } from "../boot.ts";
import { newId } from "../ids.ts";
import { recordSymbolRules } from "./observations.ts";
import { issueLease, registerAgent, resumeAccount, setPolicy, setVirtualBalances } from "./registry.ts";

export type SeededAgent = { fixture_agent_id: string; agent_id: string; name: string; token: string; lease_id: string };
export type SeedResult = { account_id: string; policy_version: number; agents: SeededAgent[]; symbols: string[] };

/**
 * Loads a scenario into the running account: policy version, virtual balances
 * and attribution, symbol rules, agents with fresh tokens, leases whose window
 * starts now, then operator resume. Only REPLAY and SHADOW (virtual funds).
 * Lease ids from the fixture are kept so fixture intents reference them.
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
  const operatorId = options.operatorId ?? "seed";
  const now = runtime.clock();
  // Fixture ids are reused across runs and accounts, so every seeded agent and lease gets a run tag.
  const runTag = options.idSuffix ?? newId("r").slice(-8);

  const policyInput: PolicyInput = {
    ...DEFAULT_POLICY,
    ...(scenario.policy ?? {}),
    ...(scenario.policy_overrides ?? {}),
  } as PolicyInput;
  const policy = await setPolicy(pool, account.id, policyInput, operatorId, now);

  const agents: SeededAgent[] = [];
  const allocations: Record<string, Record<string, string>> = { ...scenario.account.inventory_allocations };
  for (const fixtureAgent of scenario.agents) {
    const id = `${fixtureAgent.agent_id}_${runTag}`;
    const { agent, token } = await registerAgent(
      pool,
      account.id,
      { id, name: fixtureAgent.name, strategyKind: fixtureAgent.strategy_kind },
      now,
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
    );
    if (fixtureLease.assigned_inventory !== undefined) {
      allocations[agent.id] = { ...(allocations[agent.id] ?? {}), ...fixtureLease.assigned_inventory };
    }
    // Fixture allocations keyed by the fixture agent id move to the registered id.
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

  await setVirtualBalances(pool, account.id, { balances: scenario.account.balances, allocations, operatorId }, now);

  const symbols = Object.keys(scenario.symbol_rules ?? {});
  if (runtime.market !== null) {
    for (const symbol of symbols) {
      const rules = await runtime.market.getSymbolRules(symbol);
      await recordSymbolRules(pool, account.id, newId("rules"), rules);
    }
  }

  await resumeAccount(pool, account.id, operatorId, now);
  return { account_id: account.id, policy_version: policy.version, agents, symbols };
}
