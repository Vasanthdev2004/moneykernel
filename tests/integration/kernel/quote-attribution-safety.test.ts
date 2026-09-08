import { loadScenario } from "@moneykernel/integrations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURES_DIR } from "../../../apps/kernel/src/fixtures.ts";
import { seedScenario } from "../../../apps/kernel/src/services/seed.ts";
import {
  type Harness,
  migrateTestDatabase,
  operator,
  opRequest,
  seededAgent,
  startHarness,
  stopHarness,
} from "./harness.ts";

const harnesses: Harness[] = [];
beforeAll(migrateTestDatabase);
afterAll(async () => {
  for (const h of harnesses) await stopHarness(h);
});

describe("shared quote cash attribution", () => {
  it("refuses assigning shared quote cash to an agent and allows an explicit correction to UNASSIGNED", async () => {
    const scenario = loadScenario("scenario-a-constrained-acquisition", FIXTURES_DIR);
    const h = await startHarness(scenario, scenario.scenario_id);
    harnesses.push(h);
    const alpha = seededAgent(h, "agent_alpha");
    const op = await operator(h);
    expect(
      (await opRequest(h, op.token, "POST", "/v1/account/stop", {}, { "idempotency-key": "quote-cash-stop" })).status,
    ).toBe(200);
    const pool = h.runtime.pool;
    if (pool === null) throw new Error("no pool");
    const before = await pool.query(
      "SELECT agent_or_unassigned_id, owned_quantity FROM inventory_allocations WHERE account_id = $1 AND asset = 'USDT' ORDER BY agent_or_unassigned_id",
      [h.accountId],
    );
    const assigned = await opRequest(h, op.token, "POST", "/v1/inventory/assignments", {
      assignments: [
        { owner: alpha.agent_id, asset: "USDT", quantity: "10" },
        { owner: "UNASSIGNED", asset: "USDT", quantity: "100" },
      ],
    });
    expect(assigned.status).toBe(422);
    expect(assigned.body.error).toMatchObject({ code: "INVALID_FINANCIAL_VALUE" });
    expect(
      (
        await pool.query(
          "SELECT agent_or_unassigned_id, owned_quantity FROM inventory_allocations WHERE account_id = $1 AND asset = 'USDT' ORDER BY agent_or_unassigned_id",
          [h.accountId],
        )
      ).rows,
    ).toEqual(before.rows);
    expect(
      (
        await opRequest(h, op.token, "POST", "/v1/inventory/assignments", {
          assignments: [
            { owner: alpha.agent_id, asset: "USDT", quantity: "0" },
            { owner: "UNASSIGNED", asset: "USDT", quantity: "110" },
          ],
        })
      ).status,
    ).toBe(201);
  });

  it("rejects a baseline with agent-owned quote cash atomically", async () => {
    const scenario = loadScenario("scenario-a-constrained-acquisition", FIXTURES_DIR);
    const h = await startHarness(scenario, scenario.scenario_id, { seed: false });
    harnesses.push(h);
    scenario.account.inventory_allocations.agent_alpha = { USDT: "10" };
    await expect(seedScenario(h.runtime, scenario)).rejects.toThrow(/shared quote cash/);
    const pool = h.runtime.pool;
    if (pool === null) throw new Error("no pool");
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM asset_balances WHERE account_id = $1", [h.accountId])).rows[0]
        ?.n,
    ).toBe(0);
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM agents WHERE account_id = $1", [h.accountId])).rows[0]?.n,
    ).toBe(0);
  });
});
