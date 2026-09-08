import { RunExportSchema, verifyEventChain } from "@moneykernel/contracts";
import { dec } from "@moneykernel/domain";
import { loadScenario, type Scenario } from "@moneykernel/integrations";
import { appendAuditEvent, lockAccountRow, withTransaction } from "@moneykernel/persistence";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dispatchOnce } from "../../../apps/kernel/src/dispatcher/dispatch.ts";
import { FIXTURES_DIR } from "../../../apps/kernel/src/fixtures.ts";
import { newId } from "../../../apps/kernel/src/ids.ts";
import { sweepProposals } from "../../../apps/kernel/src/services/proposals.ts";
import { registerAgent } from "../../../apps/kernel/src/services/registry.ts";
import {
  buyIntent,
  type Harness,
  migrateTestDatabase,
  OPERATOR_SECRET,
  observationFor,
  operator,
  opRequest,
  seededAgent,
  startHarness,
  stopHarness,
  submitIntent,
} from "./harness.ts";

const harnesses: Harness[] = [];
beforeAll(migrateTestDatabase);
afterAll(async () => {
  for (const h of harnesses) await stopHarness(h).catch(() => undefined);
});

function roomy(): Scenario {
  const scenario = loadScenario("scenario-a-constrained-acquisition", FIXTURES_DIR);
  scenario.account.balances = { USDT: "1000" };
  scenario.account.inventory_allocations = {};
  scenario.policy = {
    ...(scenario.policy ?? {}),
    max_order_notional_quote: "1000",
    max_symbol_share: "1",
    min_quote_cash_buffer: "0",
    valuation_buffer_quote: "0",
    max_unique_intents_per_60s: 1000,
  };
  return scenario;
}

async function fresh() {
  const h = await startHarness(roomy(), "scenario-a-constrained-acquisition");
  harnesses.push(h);
  return h;
}

describe("complete, consistent, sanitized exports (T-54, T-55, T-58)", () => {
  it("exports the complete event chain after the first 5,000 events", async () => {
    const h = await fresh();
    const op = await operator(h);
    const pool = h.runtime.pool;
    if (pool === null) throw new Error("missing pool");
    const tail = await withTransaction(pool, async (tx) => {
      await lockAccountRow(tx, h.accountId);
      let last = { account_seq: 0, event_hash: "" };
      for (let index = 0; index < 5001; index++) {
        last = await appendAuditEvent(tx, {
          id: newId("evt"),
          accountId: h.accountId,
          type: "SNAPSHOT_RECORDED",
          payload: { fixture_index: index },
          occurredAt: new Date(h.clock.now),
        });
      }
      return last;
    });
    const exported = await opRequest(h, op.token, "GET", "/v1/runs/current/export");
    expect(exported.status).toBe(200);
    const bundle = RunExportSchema.parse(exported.body);
    expect(bundle.audit_events.length).toBe(tail.account_seq);
    expect(bundle.audit_events.at(-1)?.event_hash).toBe(tail.event_hash);
    expect(bundle.checkpoint.event_count).toBe(tail.account_seq);
    expect(bundle.checkpoint.final_seq).toBe(tail.account_seq);
    expect(bundle.checkpoint.final_hash).toBe(tail.event_hash);
    expect(verifyEventChain(bundle.audit_events, null).ok).toBe(true);
  });

  it("keeps authority, settlement, balances and events in one snapshot while a fill commits", async () => {
    const h = await fresh();
    const op = await operator(h);
    const alpha = seededAgent(h, "agent_alpha");
    const obs = await observationFor(h, alpha.token, "SOLUSDT");
    const submitted = await submitIntent(
      h,
      alpha.token,
      "snapshot-buy-001",
      buyIntent(alpha.lease_id, "SOLUSDT", "20", "100", obs),
    );
    expect(submitted.status).toBe(201);
    h.tick(800);
    await sweepProposals(h.runtime, new Date(h.clock.now));
    const approved = await opRequest(
      h,
      op.token,
      "POST",
      `/v1/proposals/${String(submitted.body.proposal_id)}/approve`,
      {
        proposal_revision: submitted.body.proposal_revision,
        proposal_hash: submitted.body.proposal_hash,
        expected_account_epoch: 1,
        operator_confirmation: true,
      },
      { "idempotency-key": "snapshot-approve-001" },
    );
    expect(approved.status).toBe(201);
    const pool = h.runtime.pool;
    if (pool === null) throw new Error("missing pool");
    const client = await pool.connect();
    const query = client.query.bind(client);
    let settled = false;
    client.query = (async (...args: Parameters<typeof query>) => {
      const result = await query(...args);
      if (!settled && typeof args[0] === "string" && args[0].includes("FROM leases WHERE account_id")) {
        settled = true;
        expect((await dispatchOnce(h.runtime, new Date(h.clock.now))).kind).toBe("ARMED");
      }
      return result;
    }) as typeof client.query;
    // pg also has a callback overload; this request uses its Promise form.
    const connect = vi.spyOn(pool, "connect").mockImplementationOnce(() => Promise.resolve(client) as never);
    let exported: Awaited<ReturnType<typeof opRequest>>;
    try {
      exported = await opRequest(h, op.token, "GET", "/v1/runs/current/export");
    } finally {
      client.query = query;
      connect.mockRestore();
    }
    expect(settled).toBe(true);
    expect(exported.status).toBe(200);
    const bundle = RunExportSchema.parse(exported.body);
    expect(bundle.commands[0]?.state).toBe("READY");
    expect(dec(String(bundle.leases.find((lease) => lease.id === alpha.lease_id)?.consumed_quote)).eq("0")).toBe(true);
    expect(bundle.fills).toHaveLength(0);
    expect(dec(String(bundle.balances.find((balance) => balance.asset === "USDT")?.owned_quantity)).eq("1000")).toBe(
      true,
    );
    expect(bundle.audit_events.some((event) => event.type === "FILL_RECONCILED")).toBe(false);

    const after = RunExportSchema.parse((await opRequest(h, op.token, "GET", "/v1/runs/current/export")).body);
    expect(after.commands[0]?.state).toBe("ACCEPTED");
    expect(after.fills).toHaveLength(1);
    expect(after.audit_events.some((event) => event.type === "FILL_RECONCILED")).toBe(true);
  });

  it.each(["agent token", "bootstrap secret"])("refuses a download containing an embedded %s", async (kind) => {
    const h = await fresh();
    const op = await operator(h);
    const alpha = seededAgent(h, "agent_alpha");
    const secret = kind === "agent token" ? alpha.token : OPERATOR_SECRET;
    const obs = await observationFor(h, alpha.token, "SOLUSDT");
    const submitted = await submitIntent(
      h,
      alpha.token,
      "sensitive-buy-001",
      buyIntent(alpha.lease_id, "SOLUSDT", "20", "100", obs, { rationale: `debug credential ${secret}` }),
    );
    expect(submitted.status).toBe(201);
    const exported = await opRequest(h, op.token, "GET", "/v1/runs/current/export");
    expect(exported.status).toBe(409);
    expect(JSON.stringify(exported.body)).not.toContain(secret);
    expect(exported.headers["content-disposition"]).toBeUndefined();
  });

  it("does not label a mixed-strategy account as an entirely scripted run", async () => {
    const h = await fresh();
    const op = await operator(h);
    const pool = h.runtime.pool;
    if (pool === null) throw new Error("missing pool");
    const before = RunExportSchema.parse((await opRequest(h, op.token, "GET", "/v1/runs/current/export")).body);
    expect(before.provenance.model_source).toBe("SCRIPTED");
    const { agent } = await registerAgent(
      pool,
      h.accountId,
      { name: "unverified model strategy", strategyKind: "ANTHROPIC" },
      new Date(h.clock.now),
    );
    const after = RunExportSchema.parse((await opRequest(h, op.token, "GET", "/v1/runs/current/export")).body);
    expect(after.provenance.model_source).toBe("DISABLED");
    expect(after.agents.find((row) => row.id === agent.id)?.strategy_kind).toBe("ANTHROPIC");
  });
});
