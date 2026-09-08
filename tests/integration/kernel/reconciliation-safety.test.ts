import { canonicalizeDecimal as decimal, type NormalizedFill, type NormalizedOrder } from "@moneykernel/contracts";
import { loadScenario } from "@moneykernel/integrations";
import {
  getCommandById,
  listCommands,
  listReservationsForProposal,
  lockAccountRow,
  withClient,
  withTransaction,
} from "@moneykernel/persistence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatchOnce } from "../../../apps/kernel/src/dispatcher/dispatch.ts";
import { FIXTURES_DIR } from "../../../apps/kernel/src/fixtures.ts";
import { computeReadiness } from "../../../apps/kernel/src/readiness.ts";
import { sweepProposals } from "../../../apps/kernel/src/services/proposals.ts";
import { applyObservedOrderInTx, reconcileCommand } from "../../../apps/kernel/src/services/reconciliation.ts";
import {
  buyIntent,
  type Harness,
  migrateTestDatabase,
  observationFor,
  operator,
  opRequest,
  seededAgent,
  sellIntent,
  startHarness,
  stopHarness,
  submitIntent,
} from "./harness.ts";

const harnesses: Harness[] = [];
beforeAll(migrateTestDatabase);
afterAll(async () => {
  for (const h of harnesses) await stopHarness(h);
});

async function readyTrade(feeRate?: string, side: "BUY" | "SELL" = "BUY", buyPrice = "100", buyQuote = "20") {
  const scenario = loadScenario("scenario-a-constrained-acquisition", FIXTURES_DIR);
  scenario.account.balances = { USDT: "1000" };
  scenario.account.inventory_allocations = {};
  if (side === "SELL") {
    scenario.account.balances.SOL = "1";
    scenario.account.inventory_allocations.agent_alpha = { SOL: "1" };
    const alpha = scenario.agents.find((agent) => agent.agent_id === "agent_alpha");
    if (alpha === undefined) throw new Error("no scenario agent");
    alpha.lease.allowed_sides = ["BUY", "SELL"];
  }
  scenario.policy = {
    ...scenario.policy,
    max_order_notional_quote: "1000",
    max_symbol_share: "1",
    min_quote_cash_buffer: "0",
    valuation_buffer_quote: "0",
  };
  const h = await startHarness(scenario, "scenario-a-constrained-acquisition");
  harnesses.push(h);
  const alpha = seededAgent(h, "agent_alpha");
  const op = await operator(h);
  if (feeRate !== undefined) {
    const current = await opRequest(h, op.token, "GET", "/v1/policy");
    const changed = await opRequest(
      h,
      op.token,
      "PUT",
      "/v1/policy",
      {
        ...(current.body.policy as Record<string, unknown>),
        fee_rate: feeRate,
      },
      { "if-match": String(current.body.version), "idempotency-key": "fee-envelope-update" },
    );
    expect(changed.status).toBe(201);
  }
  const observation = await observationFor(h, alpha.token, "SOLUSDT");
  const submitted = await submitIntent(
    h,
    alpha.token,
    "safe-reconcile-buy",
    side === "BUY"
      ? buyIntent(alpha.lease_id, "SOLUSDT", buyQuote, buyPrice, observation)
      : sellIntent(alpha.lease_id, "SOLUSDT", "SOL", "0.2", "99.99", observation),
  );
  expect(submitted.status).toBe(201);
  h.tick(800);
  await sweepProposals(h.runtime, new Date(h.clock.now));
  const approved = await opRequest(
    h,
    op.token,
    "POST",
    `/v1/proposals/${submitted.body.proposal_id}/approve`,
    {
      proposal_revision: submitted.body.proposal_revision,
      proposal_hash: submitted.body.proposal_hash,
      expected_account_epoch: 1,
      operator_confirmation: true,
    },
    { "idempotency-key": "safe-reconcile-approve" },
  );
  expect(approved.status).toBe(201);
  const pool = h.runtime.pool;
  if (pool === null) throw new Error("no pool");
  const commands = await withClient(pool, (client) => listCommands(client, h.accountId));
  const command = commands[0];
  if (command === undefined) throw new Error("no command");
  return { h, pool, alpha, op, command, proposalId: String(submitted.body.proposal_id) };
}

/** Adapter observation fixtures exercise accounting with ordinary fills plus realistic fee/partial variants. */
function alterObserved(
  h: Harness,
  changeOrder: (order: NormalizedOrder) => NormalizedOrder,
  changeFill: (fill: NormalizedFill) => NormalizedFill | NormalizedFill[],
) {
  const original = h.runtime.execution;
  if (original === null) throw new Error("no adapter");
  h.runtime.execution = {
    environment: original.environment,
    getAccountSnapshot: () => original.getAccountSnapshot(),
    submitOnce: async (command) => {
      const result = await original.submitOnce(command);
      return result.kind === "ACCEPTED" ? { ...result, order: changeOrder(result.order) } : result;
    },
    queryOrder: async (identity) => {
      const result = await original.queryOrder(identity);
      return result.kind === "FOUND" ? { ...result, order: changeOrder(result.order) } : result;
    },
    listRelevantFills: async (cursor) => {
      const page = await original.listRelevantFills(cursor);
      return { ...page, fills: page.fills.flatMap(changeFill) };
    },
    cancelKnownOrder: (command) => original.cancelKnownOrder(command),
  };
}

describe("reconciliation preserves resource accounting", () => {
  it.each([1, 2])("accepts correctly rounded per-fill fees across %s fill(s)", async (count) => {
    const { h } = await readyTrade(undefined, "BUY", "100.01", "20.002");
    alterObserved(
      h,
      (order) => ({ ...order, executed_quote: decimal("20.0000000000000001") }),
      (fill) =>
        Array.from({ length: count }, (_, index) => ({
          ...fill,
          fill_id: `${fill.fill_id}-${index}`,
          price: decimal("100.0000000000000005"),
          base_qty: decimal(count === 1 ? "0.2" : "0.1"),
          quote_qty: decimal(count === 1 ? "20.0000000000000001" : "10.00000000000000005"),
          commission_qty: decimal(count === 1 ? "0.020000000000000001" : "0.010000000000000001"),
        })),
    );
    const result = await dispatchOnce(h.runtime, new Date(h.clock.now));
    if (result.kind !== "ARMED") throw new Error("not armed");
    expect(result.reconciliation).toMatchObject({
      complete: true,
      reconciled: true,
      problems: [],
      fee_quote: count === 1 ? "0.020000000000000001" : "0.020000000000000002",
    });
  });
  it("settles SELL base once, credits net quote proceeds, and never replenishes acquisition budget", async () => {
    const { h, pool, alpha } = await readyTrade(undefined, "SELL");
    const result = await dispatchOnce(h.runtime, new Date(h.clock.now));
    if (result.kind !== "ARMED") throw new Error("not armed");
    expect(result.reconciliation).toMatchObject({
      reconciled: true,
      consumed_base: "0.2",
      released_base: "0",
      lease_consumed_delta: "0",
    });
    const balances = await pool.query(
      "SELECT asset, owned_quantity::text AS amount FROM asset_balances WHERE account_id = $1 ORDER BY asset",
      [h.accountId],
    );
    expect(balances.rows).toEqual([
      { asset: "SOL", amount: "0.800000000000000000" },
      { asset: "USDT", amount: "1019.978002000000000000" },
    ]);
    const allocations = await pool.query(
      "SELECT asset, sum(owned_quantity)::text AS amount FROM inventory_allocations WHERE account_id = $1 GROUP BY asset ORDER BY asset",
      [h.accountId],
    );
    expect(allocations.rows).toEqual(balances.rows);
    expect(
      (await pool.query("SELECT consumed_quote::text AS amount FROM leases WHERE id = $1", [alpha.lease_id])).rows[0]
        ?.amount,
    ).toBe("0.000000000000000000");
  });

  it("conserves attribution for every controlled asset after an ordinary BUY", async () => {
    const { h, pool } = await readyTrade();
    const result = await dispatchOnce(h.runtime, new Date(h.clock.now));
    expect(result.kind).toBe("ARMED");
    const mismatched = await pool.query(
      `SELECT b.asset, b.owned_quantity::text AS owned, COALESCE(sum(a.owned_quantity), 0)::text AS attributed
         FROM asset_balances b LEFT JOIN inventory_allocations a
           ON a.account_id = b.account_id AND a.asset = b.asset
        WHERE b.account_id = $1 GROUP BY b.asset, b.owned_quantity
       HAVING b.owned_quantity <> COALESCE(sum(a.owned_quantity), 0)`,
      [h.accountId],
    );
    expect(mismatched.rows).toEqual([]);
  });

  it("pauses when actual quote fees exceed the model instead of declaring settlement complete", async () => {
    const { h, pool, command, proposalId } = await readyTrade("0.0001");
    const result = await dispatchOnce(h.runtime, new Date(h.clock.now));
    if (result.kind !== "ARMED") throw new Error("not armed");
    expect(result.reconciliation?.fee_quote).toBe("0.02");
    const balances = await pool.query(
      "SELECT owned_quantity::text AS qty FROM asset_balances WHERE account_id = $1 AND asset = 'USDT'",
      [h.accountId],
    );
    expect(balances.rows[0]?.qty).toBe("979.980000000000000000");
    expect((await computeReadiness(h.runtime)).ready).toBe(false);
    const row = await pool.query("SELECT reconciled_at FROM commands WHERE id = $1", [command.id]);
    expect(row.rows[0]?.reconciled_at).toBeNull();
    expect(
      (await withClient(pool, (client) => listReservationsForProposal(client, proposalId))).find(
        (r) => r.kind === "QUOTE",
      ),
    ).toMatchObject({ state: "ARMED", amount: "20.002000000000000000" });
    expect((await pool.query("SELECT status FROM accounts WHERE id = $1", [h.accountId])).rows[0]?.status).toBe(
      "RECONCILING",
    );
  });

  it.each(["SOL", "BNB"])(
    "preserves actual %s fee obligations and pauses when the asset is outside the approved model",
    async (asset) => {
      const { h, pool, proposalId } = await readyTrade();
      alterObserved(
        h,
        (order) => order,
        (fill) => ({ ...fill, commission_asset: asset, commission_qty: decimal("0.0002") }),
      );
      const result = await dispatchOnce(h.runtime, new Date(h.clock.now));
      if (result.kind !== "ARMED") throw new Error("not armed");
      expect(result.reconciliation?.reconciled).toBe(false);
      if (asset === "SOL") {
        expect(result.reconciliation).toMatchObject({ new_fills: 1, fee_base: "0.0002" });
        expect(
          (
            await pool.query(
              "SELECT owned_quantity::text AS amount FROM asset_balances WHERE account_id = $1 AND asset = 'SOL'",
              [h.accountId],
            )
          ).rows[0]?.amount,
        ).toBe("0.199800000000000000");
      } else {
        expect(result.reconciliation).toMatchObject({ new_fills: 0, skipped_fills: 1 });
        expect(
          (
            await pool.query(
              "SELECT evidence_refs FROM incidents WHERE account_id = $1 AND type = 'UNSUPPORTED_FEE_ASSET'",
              [h.accountId],
            )
          ).rows[0]?.evidence_refs,
        ).toMatchObject({ commission_asset: "BNB", commission_qty: "0.0002" });
      }
      expect(
        (await withClient(pool, (client) => listReservationsForProposal(client, proposalId))).find(
          (r) => r.kind === "QUOTE",
        ),
      ).toMatchObject({ state: "ARMED", amount: "20.020000000000000000" });
      expect((await computeReadiness(h.runtime)).ready).toBe(false);
    },
  );

  it("moves partial BUY cost out of the remaining hold when it enters consumed lease budget", async () => {
    const { h, pool, alpha, command, proposalId } = await readyTrade();
    let terminal = false;
    alterObserved(
      h,
      (order) => ({
        ...order,
        status: terminal ? "EXPIRED" : "PARTIALLY_FILLED",
        executed_base: decimal("0.1"),
        executed_quote: decimal("10"),
      }),
      (fill) => ({ ...fill, base_qty: decimal("0.1"), quote_qty: decimal("10"), commission_qty: decimal("0.01") }),
    );
    const result = await dispatchOnce(h.runtime, new Date(h.clock.now));
    if (result.kind !== "ARMED") throw new Error("not armed");
    expect(result.reconciliation?.reconciled).toBe(false);
    const lease = await pool.query("SELECT consumed_quote::text AS consumed FROM leases WHERE id = $1", [
      alpha.lease_id,
    ]);
    expect(lease.rows[0]?.consumed).toBe("10.010000000000000000");
    const reservations = await withClient(pool, (client) => listReservationsForProposal(client, proposalId));
    expect(
      reservations
        .filter((r) => r.kind === "QUOTE")
        .map((r) => [r.state, r.amount])
        .sort(),
    ).toEqual([
      ["ARMED", "10.010000000000000000"],
      ["CONSUMED", "10.010000000000000000"],
    ]);
    const duplicate = await reconcileCommand(h.runtime, command.id, new Date(h.clock.now), "OPERATOR");
    expect(duplicate.apply).toMatchObject({
      new_fills: 0,
      duplicate_fills: 1,
      consumed_quote: "0",
      released_quote: "0",
    });
    terminal = true;
    const expired = await reconcileCommand(h.runtime, command.id, new Date(h.clock.now), "OPERATOR");
    expect(expired.apply).toMatchObject({
      reconciled: true,
      new_fills: 0,
      consumed_quote: "0",
      released_quote: "10.01",
    });
    const settled = await pool.query(
      "SELECT state, sum(amount)::text AS amount FROM reservations WHERE proposal_id = $1 AND kind = 'QUOTE' GROUP BY state ORDER BY state",
      [proposalId],
    );
    expect(settled.rows).toEqual([
      { state: "CONSUMED", amount: "10.010000000000000000" },
      { state: "RELEASED", amount: "10.010000000000000000" },
    ]);
    expect(
      (await pool.query("SELECT consumed_quote::text AS consumed FROM leases WHERE id = $1", [alpha.lease_id])).rows[0]
        ?.consumed,
    ).toBe("10.010000000000000000");
  });

  it.each(["order_environment", "order_side", "fill_symbol", "fill_order_id"])(
    "refuses %s mismatches before posting any accounting",
    async (mismatch) => {
      const { h, pool, proposalId } = await readyTrade();
      alterObserved(
        h,
        (order) =>
          mismatch === "order_environment"
            ? { ...order, environment: "SHADOW" }
            : mismatch === "order_side"
              ? { ...order, side: "SELL" }
              : order,
        (fill) =>
          mismatch === "fill_symbol"
            ? { ...fill, symbol: "AVAXUSDT" }
            : mismatch === "fill_order_id"
              ? { ...fill, order: { ...fill.order, exchange_order_id: "another-order" } }
              : fill,
      );
      const result = await dispatchOnce(h.runtime, new Date(h.clock.now));
      if (result.kind !== "ARMED") throw new Error("not armed");
      expect(result.reconciliation?.reconciled).toBe(false);
      expect(
        (await pool.query("SELECT count(*)::int AS n FROM fills WHERE account_id = $1", [h.accountId])).rows[0]?.n,
      ).toBe(0);
      expect(
        (
          await pool.query(
            "SELECT owned_quantity::text AS qty FROM asset_balances WHERE account_id = $1 AND asset = 'USDT'",
            [h.accountId],
          )
        ).rows[0]?.qty,
      ).toBe("1000.000000000000000000");
      expect((await computeReadiness(h.runtime)).ready).toBe(false);
      const reservations = await withClient(pool, (client) => listReservationsForProposal(client, proposalId));
      expect(reservations.find((r) => r.kind === "QUOTE")).toMatchObject({
        state: "ARMED",
        amount: "20.020000000000000000",
      });
    },
  );

  it("does not silently discard changed fees on a previously recorded fill identity", async () => {
    const { h, pool, command } = await readyTrade();
    let corrected = false;
    alterObserved(
      h,
      (order) => ({ ...order, status: corrected ? "FILLED" : "PARTIALLY_FILLED" }),
      (fill) => ({ ...fill, commission_qty: decimal(corrected ? "0.2" : "0.02") }),
    );
    await dispatchOnce(h.runtime, new Date(h.clock.now));
    corrected = true;
    const result = await reconcileCommand(h.runtime, command.id, new Date(h.clock.now), "OPERATOR");
    expect(result.apply?.reconciled).toBe(false);
    expect(result.apply?.problems).toEqual(
      expect.arrayContaining([expect.stringContaining("immutable recorded identity")]),
    );
    const fills = await pool.query("SELECT commission_qty::text AS fee FROM fills WHERE account_id = $1", [
      h.accountId,
    ]);
    expect(fills.rows).toEqual([{ fee: "0.020000000000000000" }]);
    expect((await computeReadiness(h.runtime)).ready).toBe(false);
  });

  it("keeps a completed settlement intact when a contradictory late response arrives", async () => {
    const { h, pool, command, op } = await readyTrade();
    await dispatchOnce(h.runtime, new Date(h.clock.now));
    const execution = h.runtime.execution;
    if (execution === null) throw new Error("no adapter");
    const query = await execution.queryOrder({
      client_order_id: command.client_order_id,
      exchange_order_id: null,
      symbol: "SOLUSDT",
    });
    if (query.kind !== "FOUND") throw new Error("no venue order");
    const page = await execution.listRelevantFills({ since_event_time: null, since_fill_id: null });
    const before = await withClient(pool, (client) => getCommandById(client, command.id));
    const result = await withTransaction(pool, async (tx) => {
      await lockAccountRow(tx, h.accountId);
      const current = await getCommandById(tx, command.id, { lock: true });
      if (current === null) throw new Error("no command");
      return applyObservedOrderInTx(tx, h.runtime, {
        command: current,
        order: { ...query.order, environment: "SHADOW" },
        fills: page.fills,
        now: new Date(h.clock.now),
        source: "DISPATCH",
      });
    });
    expect(result.reconciled).toBe(false);
    const after = await withClient(pool, (client) => getCommandById(client, command.id));
    expect(after).toMatchObject({ state: "ACCEPTED", reconciled_at: before?.reconciled_at });
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM fills WHERE account_id = $1", [h.accountId])).rows[0]?.n,
    ).toBe(1);
    expect((await computeReadiness(h.runtime)).ready).toBe(false);
    expect((await pool.query("SELECT status FROM accounts WHERE id = $1", [h.accountId])).rows[0]?.status).toBe(
      "RECONCILING",
    );
    const resume = await opRequest(
      h,
      op.token,
      "POST",
      "/v1/account/resume",
      {},
      { "idempotency-key": "late-mismatch-resume" },
    );
    expect(resume.status).toBe(409);
  });

  it("preserves a terminal order when a stale accepted partial observation arrives after settlement", async () => {
    const { h, pool, command } = await readyTrade();
    await dispatchOnce(h.runtime, new Date(h.clock.now));
    const execution = h.runtime.execution;
    if (execution === null) throw new Error("no adapter");
    const query = await execution.queryOrder({
      client_order_id: command.client_order_id,
      exchange_order_id: null,
      symbol: "SOLUSDT",
    });
    if (query.kind !== "FOUND") throw new Error("no venue order");
    const page = await execution.listRelevantFills({ since_event_time: null, since_fill_id: null });
    await withTransaction(pool, async (tx) => {
      await lockAccountRow(tx, h.accountId);
      const current = await getCommandById(tx, command.id, { lock: true });
      if (current === null) throw new Error("no command");
      return applyObservedOrderInTx(tx, h.runtime, {
        command: current,
        order: {
          ...query.order,
          status: "PARTIALLY_FILLED",
          executed_base: decimal("0.1"),
          executed_quote: decimal("10"),
        },
        fills: page.fills,
        now: new Date(h.clock.now),
        source: "DISPATCH",
      });
    });
    const saved = await pool.query(
      "SELECT status, executed_base::text AS base, executed_quote::text AS quote FROM orders WHERE command_id = $1",
      [command.id],
    );
    expect(saved.rows[0]).toEqual({ status: "FILLED", base: "0.200000000000000000", quote: "20.000000000000000000" });
    expect((await computeReadiness(h.runtime)).ready).toBe(true);
  });
});
