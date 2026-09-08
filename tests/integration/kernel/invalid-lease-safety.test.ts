import { randomBytes } from "node:crypto";
import type { Policy } from "@moneykernel/contracts";
import { loadScenario } from "@moneykernel/integrations";
import { lockAccountRow, setLeaseStatus, withTransaction } from "@moneykernel/persistence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../../apps/kernel/src/app.ts";
import { boot } from "../../../apps/kernel/src/boot.ts";
import { FIXTURES_DIR } from "../../../apps/kernel/src/fixtures.ts";
import { issueLease, registerAgent } from "../../../apps/kernel/src/services/registry.ts";
import {
  buyIntent,
  type Harness,
  migrateTestDatabase,
  observationFor,
  seededAgent,
  startHarness,
  stopHarness,
  submitIntent,
  sumReserved,
} from "./harness.ts";

const harnesses: Harness[] = [];
beforeAll(migrateTestDatabase);
afterAll(async () => {
  for (const h of harnesses) await stopHarness(h);
});

async function start(policyOverrides: Partial<Policy> = {}) {
  const scenario = loadScenario("scenario-a-constrained-acquisition", FIXTURES_DIR);
  const h = await startHarness(
    { ...scenario, policy_overrides: { ...scenario.policy_overrides, ...policyOverrides } },
    "scenario-a-constrained-acquisition",
  );
  harnesses.push(h);
  const alpha = seededAgent(h, "agent_alpha");
  const observation = await observationFor(h, alpha.token, "SOLUSDT");
  return { h, alpha, observation };
}

async function stats(h: Harness, agentId: string) {
  if (h.runtime.pool === null) throw new Error("no pool");
  const result = await h.runtime.pool.query(
    `SELECT status, revision,
       (SELECT count(*)::int FROM incidents WHERE agent_id = a.id AND type = 'HARD_AUTHORITY_VIOLATION') AS violations,
       (SELECT count(*)::int FROM incidents WHERE agent_id = a.id AND type = 'AGENT_QUARANTINED') AS quarantines,
       (SELECT count(*)::int FROM intents WHERE agent_id = a.id) AS intents
       FROM agents a WHERE id = $1`,
    [agentId],
  );
  return result.rows[0];
}

describe("durable rejected lease requests", () => {
  it("commits three distinct violations, quarantines, and preserves exact errors across restart", async () => {
    const { h, alpha, observation } = await start();
    const foreign = await start();
    const valid = await submitIntent(
      h,
      alpha.token,
      "before-bad-leases",
      buyIntent(alpha.lease_id, "SOLUSDT", "7", "100", observation),
    );
    expect(valid.status).toBe(201);
    expect(await sumReserved(h, "QUOTE")).toBe("7.007");
    const leases = ["lease_missing_one", "lease_missing_two", foreign.alpha.lease_id];
    const responses = [];
    for (const [index, leaseId] of leases.entries()) {
      responses.push(
        await submitIntent(
          h,
          alpha.token,
          `invalid-lease-${index}`,
          buyIntent(leaseId, "SOLUSDT", "7", "100", observation),
        ),
      );
    }
    expect(responses.map((response) => response.status)).toEqual([404, 404, 404]);
    expect(await stats(h, alpha.agent_id)).toMatchObject({
      status: "QUARANTINED",
      revision: 2,
      violations: 3,
      quarantines: 1,
      intents: 1,
    });
    expect(await sumReserved(h, "QUOTE")).toBe("0");
    expect((await stats(foreign.h, foreign.alpha.agent_id)).status).toBe("ACTIVE");

    await stopHarness(h);
    harnesses.splice(harnesses.indexOf(h), 1);
    const runtime = await boot(h.runtime.config, { clock: () => new Date(h.clock.now) });
    const restarted = { ...h, runtime, app: buildApp(runtime) };
    harnesses.push(restarted);
    const replay = await submitIntent(
      restarted,
      alpha.token,
      "invalid-lease-0",
      buyIntent(leases[0] as string, "SOLUSDT", "7", "100", observation),
    );
    expect(replay.status).toBe(404);
    expect(replay.body.error).toMatchObject({ code: "NOT_FOUND", message: "lease not found for this identity" });
    expect(await stats(restarted, alpha.agent_id)).toMatchObject({
      status: "QUARANTINED",
      violations: 3,
      quarantines: 1,
      intents: 1,
    });
  });

  it("counts rejected requests toward the durable burst limit without recounting retries", async () => {
    const { h, alpha, observation } = await start({
      max_unique_intents_per_60s: 2,
      max_hard_violations_per_60s: 100,
    });
    const body = buyIntent("lease_burst_missing", "SOLUSDT", "7", "100", observation);
    for (const key of ["burst-denied-0", "burst-denied-0", "burst-denied-1"]) {
      expect((await submitIntent(h, alpha.token, key, body)).status).toBe(404);
    }
    expect(await stats(h, alpha.agent_id)).toMatchObject({ status: "ACTIVE", violations: 2, quarantines: 0 });
    expect((await submitIntent(h, alpha.token, "burst-denied-2", body)).status).toBe(404);
    expect(await stats(h, alpha.agent_id)).toMatchObject({ status: "QUARANTINED", violations: 3, quarantines: 1 });
    if (h.runtime.pool === null) throw new Error("no pool");
    const incident = await h.runtime.pool.query(
      "SELECT evidence_refs FROM incidents WHERE agent_id = $1 AND type = 'AGENT_QUARANTINED'",
      [alpha.agent_id],
    );
    expect(incident.rows[0].evidence_refs).toMatchObject({
      trigger: "INTENT_BURST",
      unique_intents_in_window: 2,
      limit: 2,
    });
  });

  it("counts concurrent exact retries once, rejects changed payloads, and scopes keys to the agent", async () => {
    const { h, alpha, observation } = await start();
    const body = buyIntent("lease_absent", "SOLUSDT", "7", "100", observation);
    const replies = await Promise.all(
      Array.from({ length: 5 }, () => submitIntent(h, alpha.token, "same-denied-key", body)),
    );
    expect(replies.map((reply) => reply.status)).toEqual([404, 404, 404, 404, 404]);
    expect(await stats(h, alpha.agent_id)).toMatchObject({
      status: "ACTIVE",
      violations: 1,
      quarantines: 0,
      intents: 0,
    });
    const changed = await submitIntent(h, alpha.token, "same-denied-key", {
      ...body,
      size: { ...body.size, amount: "8" },
    });
    expect(changed.status).toBe(409);
    expect(changed.body.error).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect((await stats(h, alpha.agent_id)).violations).toBe(1);

    if (h.runtime.pool === null) throw new Error("no pool");
    const stranger = await registerAgent(
      h.runtime.pool,
      h.accountId,
      { name: "Independent", strategyKind: "SCRIPTED" },
      new Date(h.clock.now),
    );
    const separate = await submitIntent(h, stranger.token, "same-denied-key", {
      ...body,
      size: { ...body.size, amount: "8" },
    });
    expect(separate.status).toBe(404);
    expect((await stats(h, stranger.agent.id)).violations).toBe(1);
    expect((await stats(h, alpha.agent_id)).violations).toBe(1);
  });

  it("keeps the original 404 even if the previously missing lease is later issued", async () => {
    const { h, alpha, observation } = await start();
    const leaseId = `lease_later_${randomBytes(6).toString("hex")}`;
    const body = buyIntent(leaseId, "SOLUSDT", "7", "100", observation);
    const denied = await submitIntent(h, alpha.token, "lease-later-denial", body);
    expect(denied.status).toBe(404);
    const pool = h.runtime.pool;
    if (pool === null) throw new Error("no pool");
    await withTransaction(pool, async (tx) => {
      await lockAccountRow(tx, h.accountId);
      await setLeaseStatus(tx, alpha.lease_id, "REVOKED", new Date(h.clock.now));
    });
    await issueLease(
      pool,
      h.accountId,
      {
        id: leaseId,
        agentId: alpha.agent_id,
        budgetQuote: "40",
        attemptLimit: 2,
        startsAt: new Date(h.clock.now),
        expiresAt: new Date(h.clock.now + 60_000),
        capabilities: { allowed_symbols: ["SOLUSDT"], allowed_sides: ["BUY"], allowed_order_types: ["LIMIT_IOC"] },
      },
      new Date(h.clock.now),
    );
    const replay = await submitIntent(h, alpha.token, "lease-later-denial", body);
    expect(replay.status).toBe(404);
    expect(replay.body.error).toMatchObject({ code: "NOT_FOUND", message: "lease not found for this identity" });
    expect((await stats(h, alpha.agent_id)).violations).toBe(1);
    const fresh = await submitIntent(h, alpha.token, "lease-later-fresh", body);
    expect(fresh.status).toBe(201);
    expect(fresh.body.outcome).toBe("ALLOW_PROPOSAL");
  });
});
