import { canonicalizeDecimal, hashCanonical } from "@moneykernel/contracts";
import { loadScenario } from "@moneykernel/integrations";
import { claimOperatorRequest, withClient } from "@moneykernel/persistence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../../apps/kernel/src/app.ts";
import { boot } from "../../../apps/kernel/src/boot.ts";
import { FIXTURES_DIR } from "../../../apps/kernel/src/fixtures.ts";
import {
  type Harness,
  migrateTestDatabase,
  observationFor,
  operator,
  opRequest,
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

async function start(fixture = "scenario-a-constrained-acquisition") {
  const h = await startHarness(loadScenario(fixture, FIXTURES_DIR), fixture);
  harnesses.push(h);
  return h;
}

async function restart(h: Harness) {
  const config = h.runtime.config;
  await h.app.close();
  await h.runtime.shutdown();
  h.runtime = await boot(config, { clock: () => new Date(h.clock.now) });
  h.app = buildApp(h.runtime);
}

function poolFor(h: Harness) {
  if (h.runtime.pool === null) throw new Error("test pool missing");
  return h.runtime.pool;
}

async function accountState(h: Harness) {
  return (await poolFor(h).query("SELECT status, epoch FROM accounts WHERE id = $1", [h.accountId])).rows[0];
}

describe("durable operator request identity", () => {
  it("replays an old resume after restart without undoing a later stop, and rejects changed payloads", async () => {
    const h = await start();
    let session = await operator(h);
    const original = await opRequest(
      h,
      session.token,
      "POST",
      "/v1/account/resume",
      {},
      {
        "idempotency-key": "original-resume-key",
      },
    );
    expect(original.status).toBe(200);
    expect(
      (
        await opRequest(
          h,
          session.token,
          "POST",
          "/v1/account/stop",
          {},
          {
            "idempotency-key": "later-stop-key",
          },
        )
      ).status,
    ).toBe(200);
    await restart(h);
    session = await operator(h);
    const before = await accountState(h);
    expect(before.status).toBe("PAUSED");
    const repeated = await opRequest(
      h,
      session.token,
      "POST",
      "/v1/account/resume",
      {},
      {
        "idempotency-key": "original-resume-key",
      },
    );
    expect(repeated.status).toBe(200);
    expect(repeated.headers["idempotent-replayed"]).toBe("true");
    expect(repeated.body).toEqual(original.body);
    expect(await accountState(h)).toEqual(before);
    const changed = await opRequest(
      h,
      session.token,
      "POST",
      "/v1/account/resume",
      {
        acknowledged_incident_ids: ["different_request"],
      },
      { "idempotency-key": "original-resume-key" },
    );
    expect(changed.status).toBe(409);
    expect(changed.body.error).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(await accountState(h)).toEqual(before);
  });

  it("claims a concurrent request once and keeps unresolved requests blocked after restart", async () => {
    const h = await start();
    let session = await operator(h);
    await opRequest(h, session.token, "POST", "/v1/account/stop", {}, { "idempotency-key": "pending-stop-key" });
    const input = {
      accountId: h.accountId,
      operatorId: "operator",
      scope: "resume",
      key: "crashed-resume-key",
      payloadHash: hashCanonical({ method: "POST", scope: "resume", params: {}, body: {} }),
      now: new Date(h.clock.now),
    };
    const claims = await Promise.all([
      claimOperatorRequest(poolFor(h), input),
      claimOperatorRequest(poolFor(h), input),
    ]);
    expect(claims.filter((c) => c.claimed)).toHaveLength(1);
    await restart(h);
    session = await operator(h);
    const before = await accountState(h);
    const retry = await opRequest(
      h,
      session.token,
      "POST",
      "/v1/account/resume",
      {},
      {
        "idempotency-key": input.key,
      },
    );
    expect(retry.status).toBe(409);
    expect(retry.body.error).toMatchObject({ code: "STATE_CONFLICT", details: { request_state: "PENDING" } });
    expect(await accountState(h)).toEqual(before);
  });
});

describe("operator writes preserve account identity and version preconditions", () => {
  it("allows only one concurrent policy update against a shared If-Match version", async () => {
    const h = await start();
    const session = await operator(h);
    const current = await opRequest(h, session.token, "GET", "/v1/policy");
    const body = current.body.policy as Record<string, unknown>;
    const responses = await Promise.all(
      ["40", "45"].map((cap) =>
        opRequest(
          h,
          session.token,
          "PUT",
          "/v1/policy",
          { ...body, max_order_notional_quote: cap },
          {
            "if-match": `"${current.body.version}"`,
          },
        ),
      ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(responses.find((r) => r.status === 409)?.body.error).toMatchObject({ code: "STALE_VERSION" });
    const saved = await opRequest(h, session.token, "GET", "/v1/policy");
    expect(saved.body.version).toBe(Number(current.body.version) + 1);
  });

  it("rejects foreign or missing lease and inventory owners without side effects", async () => {
    const h = await start();
    const other = await start();
    const session = await operator(h);
    const foreign = other.seed.agents[0];
    if (foreign === undefined) throw new Error("foreign agent missing");
    await opRequest(h, session.token, "POST", "/v1/account/stop", {}, { "idempotency-key": "ownership-stop-key" });
    for (const owner of [foreign.agent_id, "missing_agent"]) {
      const lease = await opRequest(h, session.token, "POST", "/v1/leases", {
        agent_id: owner,
        acquisition_budget_quote: "5",
        max_submission_attempts: 1,
        allowed_symbols: ["SOLUSDT"],
        allowed_sides: ["BUY"],
        allowed_order_types: ["LIMIT_IOC"],
        expires_at: "2026-09-08T12:20:00Z",
      });
      expect(lease.status).toBe(404);
      const assignment = await opRequest(h, session.token, "POST", "/v1/inventory/assignments", {
        assignments: [
          { owner: "UNASSIGNED", asset: "SOL", quantity: "2.2175" },
          { owner, asset: "SOL", quantity: "0.01" },
        ],
      });
      expect(assignment.status).toBe(404);
      const rows = await poolFor(h).query(
        "SELECT 1 FROM inventory_allocations WHERE account_id = $1 AND agent_or_unassigned_id = $2",
        [h.accountId, owner],
      );
      expect(rows.rowCount).toBe(0);
    }
    const unassigned = await poolFor(h).query(
      "SELECT owned_quantity FROM inventory_allocations WHERE account_id = $1 AND agent_or_unassigned_id = 'UNASSIGNED' AND asset = 'SOL'",
      [h.accountId],
    );
    expect(canonicalizeDecimal(unassigned.rows[0]?.owned_quantity)).toBe("2.2275");
  });

  it("retains base inventory reserved by a proposal when restart pauses the account", async () => {
    const h = await start("scenario-b-opposing-intents");
    const guard = h.seed.agents.find((a) => a.fixture_agent_id === "agent_inventory_guard");
    if (guard === undefined) throw new Error("inventory agent missing");
    const observation = await observationFor(h, guard.token, "BTCUSDT");
    const submitted = await submitIntent(
      h,
      guard.token,
      "reserved-inventory-intent",
      sellIntent(guard.lease_id, "BTCUSDT", "BTC", "0.0001", "100000", observation),
    );
    expect(submitted.status).toBe(201);
    expect(submitted.body.outcome).toBe("ALLOW_PROPOSAL");
    await restart(h);
    const session = await operator(h);
    const assignment = await opRequest(h, session.token, "POST", "/v1/inventory/assignments", {
      assignments: [
        { owner: guard.agent_id, asset: "BTC", quantity: "0" },
        { owner: "UNASSIGNED", asset: "BTC", quantity: "0.001" },
      ],
    });
    expect(assignment.status).toBe(409);
    const quantity = await withClient(poolFor(h), (client) =>
      client.query(
        "SELECT owned_quantity FROM inventory_allocations WHERE account_id = $1 AND agent_or_unassigned_id = $2 AND asset = 'BTC'",
        [h.accountId, guard.agent_id],
      ),
    );
    expect(canonicalizeDecimal(quantity.rows[0]?.owned_quantity)).toBe("0.001");
  });
});

describe("public mutation boundary", () => {
  it("blocks remote operator and agent mutations, ignores forwarding headers, and preserves local access", async () => {
    const h = await start();
    const session = await operator(h);
    const request = {
      method: "POST" as const,
      url: "/v1/agents",
      headers: { authorization: `Bearer ${session.token}`, "x-forwarded-for": "127.0.0.1" },
      payload: { name: "Local operator agent", strategy_kind: "SCRIPTED" },
    };
    const remote = await h.app.inject({ ...request, remoteAddress: "203.0.113.10" });
    expect(remote.statusCode).toBe(403);
    const local = await h.app.inject({ ...request, remoteAddress: "::ffff:127.0.0.1" });
    expect(local.statusCode).toBe(201);
    const agent = h.seed.agents[0];
    if (agent === undefined) throw new Error("agent missing");
    const remoteAgent = await h.app.inject({
      method: "POST",
      url: "/v1/agent/intents",
      remoteAddress: "203.0.113.10",
      headers: { authorization: `Bearer ${agent.token}`, "idempotency-key": "remote-agent-intent" },
      payload: {},
    });
    expect(remoteAgent.statusCode).toBe(403);
    const read = await h.app.inject({
      method: "GET",
      url: "/v1/agents",
      remoteAddress: "203.0.113.10",
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(read.statusCode).toBe(200);
    h.runtime.config.enablePublicMutations = true;
    expect((await h.app.inject({ ...request, remoteAddress: "203.0.113.10" })).statusCode).toBe(201);
    // Registration is still authenticated when public mutations are enabled.
    expect((await h.app.inject({ ...request, headers: {}, remoteAddress: "203.0.113.10" })).statusCode).toBe(401);
  });
});
