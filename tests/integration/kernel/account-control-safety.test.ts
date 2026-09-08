import { loadScenario } from "@moneykernel/integrations";
import { countOutstandingCommands, listCommands, listOutstandingCommands, withClient } from "@moneykernel/persistence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatchOnce } from "../../../apps/kernel/src/dispatcher/dispatch.ts";
import { FIXTURES_DIR } from "../../../apps/kernel/src/fixtures.ts";
import { computeReadiness } from "../../../apps/kernel/src/readiness.ts";
import { sweepProposals } from "../../../apps/kernel/src/services/proposals.ts";
import {
  buyIntent,
  type Harness,
  migrateTestDatabase,
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
  for (const h of harnesses) await stopHarness(h);
});

/**
 * An accepted command whose accounting cannot settle: the paper venue's order summary reports more executed base
 * than the fills it lists (fill detail lag), so reconciliation keeps the armed hold as a conservative buffer and
 * leaves `reconciled_at` unset (prd.md 11.6). Since G4 a clean paper fill settles inside the dispatch transaction.
 */
async function acceptedCommand() {
  const faults = { overstateExecutedFor: new Set<string>() };
  const h = await startHarness(
    loadScenario("scenario-a-constrained-acquisition", FIXTURES_DIR),
    "scenario-a-constrained-acquisition",
    { paperFaults: faults },
  );
  harnesses.push(h);
  const alpha = seededAgent(h, "agent_alpha");
  const op = await operator(h);
  const obs = await observationFor(h, alpha.token, "SOLUSDT");
  const submitted = await submitIntent(
    h,
    alpha.token,
    "control-buy-01",
    buyIntent(alpha.lease_id, "SOLUSDT", "20", "100", obs),
  );
  expect(submitted.status).toBe(201);
  h.tick(800);
  await sweepProposals(h.runtime, new Date(h.clock.now));
  const approval = await opRequest(
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
    { "idempotency-key": "control-approve-01" },
  );
  expect(approval.status).toBe(201);
  const readyPool = h.runtime.pool;
  if (readyPool === null) throw new Error("no pool");
  for (const command of await withClient(readyPool, (c) => listCommands(c, h.accountId)))
    faults.overstateExecutedFor.add(command.client_order_id);
  const dispatch = await dispatchOnce(h.runtime, new Date(h.clock.now));
  if (dispatch.kind !== "ARMED" || dispatch.outcome !== "ACCEPTED")
    throw new Error(`unexpected dispatch: ${JSON.stringify(dispatch)}`);
  const pool = h.runtime.pool;
  if (pool === null) throw new Error("no pool");
  return { h, op, pool, commandId: dispatch.command_id, proposalId: String(submitted.body.proposal_id) };
}

describe("stop and resume preserve accepted command uncertainty", () => {
  it("refuses resume after the original writer session loses its advisory lock", async () => {
    const h = await startHarness(
      loadScenario("scenario-a-constrained-acquisition", FIXTURES_DIR),
      "scenario-a-constrained-acquisition",
    );
    harnesses.push(h);
    const op = await operator(h);
    const stopped = await opRequest(
      h,
      op.token,
      "POST",
      "/v1/account/stop",
      {},
      {
        "idempotency-key": "lost-writer-stop",
      },
    );
    expect(stopped.status).toBe(200);
    const writer = h.runtime.writer;
    const pool = h.runtime.pool;
    if (writer === null || pool === null) throw new Error("no writer session or pool");
    await writer.client.query("SELECT pg_advisory_unlock(hashtext($1))", [writer.key]);
    expect(h.runtime.writer).toBe(writer);
    const resumed = await opRequest(
      h,
      op.token,
      "POST",
      "/v1/account/resume",
      {},
      {
        "idempotency-key": "lost-writer-resume",
      },
    );
    expect(resumed.status).toBe(409);
    expect(resumed.body.error).toMatchObject({
      code: "STATE_CONFLICT",
      details: expect.arrayContaining([expect.objectContaining({ name: "writer_lock", ok: false })]),
    });
    expect((await pool.query("SELECT status FROM accounts WHERE id = $1", [h.accountId])).rows[0]?.status).toBe(
      "PAUSED",
    );
  });

  it("reports accepted but unreconciled commands at stop and refuses resume", async () => {
    const { h, op, pool, commandId, proposalId } = await acceptedCommand();
    const holdsBefore = await pool.query(
      "SELECT id, state, amount FROM reservations WHERE proposal_id = $1 ORDER BY id",
      [proposalId],
    );
    const stopped = await opRequest(
      h,
      op.token,
      "POST",
      "/v1/account/stop",
      {},
      { "idempotency-key": "control-stop-01" },
    );
    expect(stopped.status).toBe(200);
    expect(stopped.body.in_flight_commands).toEqual([
      expect.objectContaining({ command_id: commandId, state: "ACCEPTED" }),
    ]);
    expect(stopped.body.note).toContain("reconciliation");
    const event = await pool.query(
      "SELECT payload FROM audit_events WHERE account_id = $1 AND type = 'ACCOUNT_STOPPED' ORDER BY account_seq DESC LIMIT 1",
      [h.accountId],
    );
    expect(event.rows[0]?.payload.in_flight_commands).toEqual([commandId]);
    const holdsAfter = await pool.query(
      "SELECT id, state, amount FROM reservations WHERE proposal_id = $1 ORDER BY id",
      [proposalId],
    );
    expect(holdsAfter.rows).toEqual(holdsBefore.rows);
    expect((await computeReadiness(h.runtime)).ready).toBe(false);
    const resumed = await opRequest(
      h,
      op.token,
      "POST",
      "/v1/account/resume",
      {},
      { "idempotency-key": "control-resume-01" },
    );
    expect(resumed.status).toBe(409);
    expect((await pool.query("SELECT status FROM accounts WHERE id = $1", [h.accountId])).rows[0]?.status).toBe(
      "PAUSED",
    );
  });

  it("uses the same settlement evidence for command lists, counts, and resume", async () => {
    const { h, op, pool, commandId, proposalId } = await acceptedCommand();
    await opRequest(h, op.token, "POST", "/v1/account/stop", {}, { "idempotency-key": "evidence-stop-01" });
    // Synthetic persisted-state fixtures exercise readiness, not a G4 accounting implementation.
    await pool.query("UPDATE commands SET reconciled_at = armed_at WHERE id = $1", [commandId]);
    const client = await pool.connect();
    try {
      expect((await countOutstandingCommands(client, h.accountId)).total).toBe(1);
      expect((await listOutstandingCommands(client, h.accountId)).map((command) => command.id)).toEqual([commandId]);
      expect(
        (await opRequest(h, op.token, "POST", "/v1/account/resume", {}, { "idempotency-key": "evidence-resume-01" }))
          .status,
      ).toBe(409);
      await pool.query("UPDATE reservations SET state = 'CONSUMED' WHERE proposal_id = $1 AND state = 'ARMED'", [
        proposalId,
      ]);
      await pool.query("UPDATE orders SET status = 'PARTIALLY_FILLED' WHERE command_id = $1", [commandId]);
      expect((await countOutstandingCommands(client, h.accountId)).total).toBe(1);
      expect((await listOutstandingCommands(client, h.accountId)).map((command) => command.id)).toEqual([commandId]);
      expect(
        (await opRequest(h, op.token, "POST", "/v1/account/resume", {}, { "idempotency-key": "evidence-resume-02" }))
          .status,
      ).toBe(409);
      await pool.query("UPDATE orders SET status = 'FILLED' WHERE command_id = $1", [commandId]);
      expect((await countOutstandingCommands(client, h.accountId)).total).toBe(0);
      expect(await listOutstandingCommands(client, h.accountId)).toEqual([]);
      expect(
        (await opRequest(h, op.token, "POST", "/v1/account/resume", {}, { "idempotency-key": "evidence-resume-03" }))
          .status,
      ).toBe(200);
    } finally {
      client.release();
    }
  });
});
