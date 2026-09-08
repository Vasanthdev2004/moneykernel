import { loadScenario, MemoryPaperVenueStore, type PaperExecutionAdapter } from "@moneykernel/integrations";
import { listCommands, withClient } from "@moneykernel/persistence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../../apps/kernel/src/app.ts";
import { boot } from "../../../apps/kernel/src/boot.ts";
import { loadConfig } from "../../../apps/kernel/src/config.ts";
import { dispatchOnce } from "../../../apps/kernel/src/dispatcher/dispatch.ts";
import { FIXTURES_DIR } from "../../../apps/kernel/src/fixtures.ts";
import { sweepProposals } from "../../../apps/kernel/src/services/proposals.ts";
import { reconcileOutstanding } from "../../../apps/kernel/src/services/reconciliation.ts";
import {
  buyIntent,
  DATABASE_URL_TEST,
  type Harness,
  migrateTestDatabase,
  OPERATOR_SECRET,
  observationFor,
  operator,
  opRequest,
  restartHarness,
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

describe("REPLAY-only synthetic faults for the recorded demo (prd.md 23.2, 27.4)", () => {
  it("arms a dropped response for a proposal's deterministic client order id before approval", async () => {
    const h = await startHarness(loadScenario("scenario-d-lost-response", FIXTURES_DIR), "scenario-d-lost-response");
    harnesses.push(h);
    const alpha = seededAgent(h, "agent_alpha");
    const op = await operator(h);
    const obs = await observationFor(h, alpha.token, "SOLUSDT");
    const submitted = await submitIntent(
      h,
      alpha.token,
      "demo-fault-001",
      buyIntent(alpha.lease_id, "SOLUSDT", "20", "100", obs),
    );
    expect(submitted.status).toBe(201);
    const bad = await opRequest(h, op.token, "POST", "/v1/demo/faults", {
      kind: "DROP_RESPONSE_AFTER_ACCEPT",
      proposal_id: "proposal_missing",
    });
    expect(bad.status).toBe(404);
    const armed = await opRequest(h, op.token, "POST", "/v1/demo/faults", {
      kind: "DROP_RESPONSE_AFTER_ACCEPT",
      proposal_id: submitted.body.proposal_id,
    });
    expect(armed.status).toBe(201);
    expect(armed.body.hold_queries_until_restart).toBe(false);
    expect(String(armed.body.client_order_id)).toMatch(/^mk_[0-9a-f]{32}$/);
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
      { "idempotency-key": "demo-fault-approve" },
    );
    expect(approved.status).toBe(201);
    const pool = h.runtime.pool;
    if (pool === null) throw new Error("no pool");
    const ready = await withClient(pool, (c) => listCommands(c, h.accountId, ["READY"]));
    expect(ready[0]?.client_order_id).toBe(armed.body.client_order_id);
    const report = await dispatchOnce(h.runtime, new Date(h.clock.now));
    if (report.kind !== "ARMED") throw new Error("not armed");
    expect(report.outcome).toBe("OUTCOME_UNKNOWN");
    expect((h.runtime.execution as PaperExecutionAdapter).submitCount).toBe(1);
    expect(
      (
        await h.runtime.execution?.queryOrder({
          client_order_id: String(armed.body.client_order_id),
          exchange_order_id: null,
          symbol: "SOLUSDT",
        })
      )?.kind,
    ).toBe("FOUND");
  });

  it("keeps a labelled synthetic query outage unknown across background retries, then recovers once after restart", async () => {
    const scenario = loadScenario("scenario-d-lost-response", FIXTURES_DIR);
    const h = await startHarness(scenario, "scenario-d-lost-response");
    harnesses.push(h);
    const alpha = seededAgent(h, "agent_alpha");
    const op = await operator(h);
    const obs = await observationFor(h, alpha.token, "SOLUSDT");
    const submitted = await submitIntent(
      h,
      alpha.token,
      "held-query-intent",
      buyIntent(alpha.lease_id, "SOLUSDT", "20", "100", obs),
    );
    expect(submitted.status).toBe(201);
    const armed = await opRequest(h, op.token, "POST", "/v1/demo/faults", {
      kind: "DROP_RESPONSE_AFTER_ACCEPT",
      proposal_id: submitted.body.proposal_id,
      hold_queries_until_restart: true,
    });
    expect(armed.status).toBe(201);
    expect(armed.body.hold_queries_until_restart).toBe(true);
    expect(armed.body.note).toContain("SYNTHETIC FAULT SCENARIO");
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
      { "idempotency-key": "held-query-approve" },
    );
    expect(approved.status).toBe(201);
    const dispatched = await dispatchOnce(h.runtime, new Date(h.clock.now));
    expect(dispatched.kind === "ARMED" && dispatched.outcome === "OUTCOME_UNKNOWN").toBe(true);
    const pool = h.runtime.pool;
    if (pool === null) throw new Error("no pool");
    const before = (await withClient(pool, (client) => listCommands(client, h.accountId)))[0];
    if (before === undefined) throw new Error("no command");
    expect(before.client_order_id).toBe(armed.body.client_order_id);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      h.tick(10_000);
      const sweep = await reconcileOutstanding(h.runtime, new Date(h.clock.now));
      expect(sweep.reports).toHaveLength(1);
      expect(sweep.reports[0]?.result).toBe("STILL_UNKNOWN");
      const commands = await withClient(pool, (client) => listCommands(client, h.accountId));
      expect(commands).toHaveLength(1);
      expect(commands[0]?.state).toBe("OUTCOME_UNKNOWN");
      expect(commands[0]?.reconciled_at).toBeNull();
    }
    const paper = h.runtime.execution as PaperExecutionAdapter;
    expect(paper.submitCount).toBe(1);
    expect(Object.keys(paper.venueState().orders)).toEqual([before.client_order_id]);
    expect(paper.venueState().orders[before.client_order_id]?.fills).toHaveLength(1);
    expect(
      (await paper.queryOrder({ client_order_id: "unrelated-order", exchange_order_id: null, symbol: "SOLUSDT" })).kind,
    ).toBe("NOT_FOUND");
    // A real new process retains the venue journal but reconstructs its runtime-only faults as an empty object.
    const restarted = await restartHarness(h, scenario, { paperFaults: {} });
    harnesses.push(restarted);
    const afterPool = restarted.runtime.pool;
    if (afterPool === null) throw new Error("no restarted pool");
    const after = await withClient(afterPool, (client) => listCommands(client, restarted.accountId));
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(before.id);
    expect(after[0]?.client_order_id).toBe(before.client_order_id);
    expect(after[0]?.state).toBe("ACCEPTED");
    expect(after[0]?.reconciled_at).not.toBeNull();
    expect(restarted.runtime.account?.status).toBe("PAUSED");
    expect((restarted.runtime.execution as PaperExecutionAdapter).submitCount).toBe(1);
    const opAfter = await operator(restarted);
    const detail = await opRequest(restarted, opAfter.token, "GET", `/v1/commands/${before.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.order).toMatchObject({ status: "EXPIRED", client_order_id: before.client_order_id });
    expect(detail.body.fills as unknown[]).toHaveLength(1);
  });

  it("refuses synthetic faults outside REPLAY", async () => {
    const runtime = await boot(
      loadConfig({
        DATABASE_URL: DATABASE_URL_TEST,
        OPERATOR_BOOTSTRAP_SECRET: OPERATOR_SECRET,
        MONEYKERNEL_MODE: "SHADOW",
        MONEYKERNEL_ACCOUNT_ALIAS: `shadow-fault-${Date.now().toString(36)}`,
        LOG_LEVEL: "silent",
      }),
      { paperVenueStore: new MemoryPaperVenueStore() },
    );
    const app = buildApp(runtime);
    try {
      const login = await app.inject({
        method: "POST",
        url: "/v1/auth/session",
        payload: { bootstrap_secret: OPERATOR_SECRET },
      });
      const token = (login.json() as { session_token: string }).session_token;
      const res = await app.inject({
        method: "POST",
        url: "/v1/demo/faults",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: JSON.stringify({
          kind: "DROP_RESPONSE_AFTER_ACCEPT",
          proposal_id: "proposal_x",
          hold_queries_until_restart: true,
        }),
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
      await runtime.shutdown();
    }
  });
});
