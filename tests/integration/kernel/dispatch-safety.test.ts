import { type ApprovalRequest, type ArmedCommand, canonicalizeDecimal } from "@moneykernel/contracts";
import { loadScenario, type PaperExecutionAdapter } from "@moneykernel/integrations";
import { type Pool, releaseWriterLock, tryAcquireWriterLock } from "@moneykernel/persistence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatchOnce } from "../../../apps/kernel/src/dispatcher/dispatch.ts";
import { FIXTURES_DIR } from "../../../apps/kernel/src/fixtures.ts";
import { approveProposal } from "../../../apps/kernel/src/services/approvals.ts";
import { sweepProposals } from "../../../apps/kernel/src/services/proposals.ts";
import {
  buyIntent,
  type Harness,
  migrateTestDatabase,
  observationFor,
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

async function pendingProposal(referenceMark?: string) {
  const scenario = loadScenario("scenario-a-constrained-acquisition", FIXTURES_DIR);
  scenario.account.balances = { USDT: "1000" };
  scenario.account.inventory_allocations = {};
  scenario.policy = {
    ...scenario.policy,
    max_order_notional_quote: "1000",
    max_symbol_share: "1",
    min_quote_cash_buffer: "0",
    valuation_buffer_quote: "0",
  };
  const fixtureAgent = scenario.agents[0];
  if (fixtureAgent === undefined) throw new Error("missing fixture agent");
  fixtureAgent.lease.acquisition_budget_quote = "1000";
  fixtureAgent.lease.max_submission_attempts = 5;
  const h = await startHarness(scenario, "scenario-a-constrained-acquisition");
  harnesses.push(h);
  if (referenceMark !== undefined) {
    const market = h.runtime.market;
    if (market === null) throw new Error("missing market");
    const read = market.getSnapshot.bind(market);
    market.getSnapshot = async (symbol) => ({
      ...(await read(symbol)),
      last_price: canonicalizeDecimal(referenceMark),
    });
    h.tick(1);
  }
  const alpha = seededAgent(h, "agent_alpha");
  const result = await submitIntent(
    h,
    alpha.token,
    "dispatch-safety-intent",
    buyIntent(alpha.lease_id, "SOLUSDT", "20", "100", await observationFor(h, alpha.token, "SOLUSDT")),
  );
  expect(result.status).toBe(201);
  h.tick(800);
  await sweepProposals(h.runtime, h.runtime.clock());
  const proposalId = String(result.body.proposal_id);
  const request: ApprovalRequest = {
    proposal_revision: Number(result.body.proposal_revision),
    proposal_hash: String(result.body.proposal_hash),
    expected_account_epoch: Number((result.body.authority as { account_epoch: number }).account_epoch),
    operator_confirmation: true,
  };
  const pool = h.runtime.pool;
  if (pool === null) throw new Error("missing pool");
  return { h, alpha, proposalId, request, pool };
}

async function approvedProposal(referenceMark?: string) {
  const prepared = await pendingProposal(referenceMark);
  await approveProposal(prepared.h.runtime, {
    proposalId: prepared.proposalId,
    request: prepared.request,
    operatorId: "dispatch-safety-review",
    now: prepared.h.runtime.clock(),
  });
  return prepared;
}

async function waitForBlockedOperation(pool: Pool, blockingPid: number) {
  for (let i = 0; i < 200; i += 1) {
    const result = await pool.query<{ n: number }>(
      "SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))",
      [blockingPid],
    );
    if ((result.rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("operation did not wait for the account lock");
}

describe("approval and dispatch authority under real lock contention", () => {
  it("T-09: refreshes the dispatch clock after waiting past proposal and lease expiry", async () => {
    const { h, pool, proposalId } = await approvedProposal();
    const locker = await pool.connect();
    try {
      await locker.query("BEGIN");
      const pid = (await locker.query<{ pid: number }>("SELECT pg_backend_pid() pid")).rows[0]?.pid;
      if (pid === undefined) throw new Error("missing blocker pid");
      await locker.query("SELECT * FROM accounts WHERE id=$1 FOR UPDATE", [h.accountId]);
      const pending = dispatchOnce(h.runtime, h.runtime.clock());
      await waitForBlockedOperation(pool, pid);
      h.tick(25 * 60_000);
      await locker.query("COMMIT");
      expect((await pending).kind).toBe("ABORTED_PRE_ARM");
      const rows = await pool.query("SELECT state,armed_at FROM commands WHERE proposal_id=$1", [proposalId]);
      expect(rows.rows).toEqual([{ state: "ABORTED_PRE_ARM", armed_at: null }]);
      expect((h.runtime.execution as PaperExecutionAdapter).submitCount).toBe(0);
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }
  });

  it("expires an approval request that waited behind the account lock", async () => {
    const { h, pool, proposalId, request } = await pendingProposal();
    const locker = await pool.connect();
    try {
      await locker.query("BEGIN");
      const pid = (await locker.query<{ pid: number }>("SELECT pg_backend_pid() pid")).rows[0]?.pid;
      if (pid === undefined) throw new Error("missing blocker pid");
      await locker.query("SELECT * FROM accounts WHERE id=$1 FOR UPDATE", [h.accountId]);
      const pending = approveProposal(h.runtime, {
        proposalId,
        request,
        operatorId: "test",
        now: h.runtime.clock(),
      }).catch((error: unknown) => error);
      await waitForBlockedOperation(pool, pid);
      h.tick(25 * 60_000);
      await locker.query("COMMIT");
      expect(await pending).toBeInstanceOf(Error);
      expect((await pool.query("SELECT state FROM proposals WHERE id=$1", [proposalId])).rows[0]?.state).toBe(
        "EXPIRED",
      );
      expect((await pool.query("SELECT id FROM approvals WHERE proposal_id=$1", [proposalId])).rows).toEqual([]);
      expect((await pool.query("SELECT state FROM reservations WHERE proposal_id=$1", [proposalId])).rows).toEqual([
        { state: "RELEASED" },
        { state: "RELEASED" },
      ]);
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }
  });

  it.each(["approve", "dispatch"] as const)(
    "refreshes authority time after a later lease lock wait during %s",
    async (operation) => {
      const prepared = operation === "approve" ? await pendingProposal() : await approvedProposal();
      const { h, pool, proposalId, request, alpha } = prepared;
      const locker = await pool.connect();
      try {
        await locker.query("BEGIN");
        const pid = (await locker.query<{ pid: number }>("SELECT pg_backend_pid() pid")).rows[0]?.pid;
        if (pid === undefined) throw new Error("missing blocker pid");
        await locker.query("SELECT * FROM leases WHERE id=$1 FOR UPDATE", [alpha.lease_id]);
        const pending =
          operation === "approve"
            ? approveProposal(h.runtime, { proposalId, request, operatorId: "test", now: h.runtime.clock() }).catch(
                (error: unknown) => error,
              )
            : dispatchOnce(h.runtime, h.runtime.clock());
        await waitForBlockedOperation(pool, pid);
        h.tick(25 * 60_000);
        await locker.query("COMMIT");
        const result = await pending;
        if (operation === "approve") expect(result).toBeInstanceOf(Error);
        else
          expect(result).toMatchObject({
            kind: "ABORTED_PRE_ARM",
            reason_codes: expect.arrayContaining(["LEASE_EXPIRED"]),
          });
        expect((h.runtime.execution as PaperExecutionAdapter).submitCount).toBe(0);
        expect((await pool.query("SELECT state FROM proposals WHERE id=$1", [proposalId])).rows[0]?.state).toBe(
          "INVALIDATED",
        );
      } finally {
        await locker.query("ROLLBACK");
        locker.release();
      }
    },
  );

  it("commits stale-approval invalidation and hold release before returning the refusal", async () => {
    const { h, pool, proposalId, request } = await pendingProposal();
    await expect(
      approveProposal(h.runtime, {
        proposalId,
        request: { ...request, expected_account_epoch: 99 },
        operatorId: "test",
        now: h.runtime.clock(),
      }),
    ).rejects.toMatchObject({ code: "STALE_VERSION" });
    expect((await pool.query("SELECT state FROM proposals WHERE id=$1", [proposalId])).rows[0]?.state).toBe(
      "INVALIDATED",
    );
    expect((await pool.query("SELECT state FROM reservations WHERE proposal_id=$1", [proposalId])).rows).toEqual([
      { state: "RELEASED" },
      { state: "RELEASED" },
    ]);
    expect(
      (
        await pool.query("SELECT id FROM audit_events WHERE account_id=$1 AND type='RESERVATION_RELEASED'", [
          h.accountId,
        ])
      ).rows,
    ).toHaveLength(1);
  });
});

describe("exact persisted authority before arming", () => {
  it.each([
    ["released holds", "UPDATE reservations SET state='RELEASED' WHERE proposal_id=$1"],
    ["missing attempt", "DELETE FROM reservations WHERE proposal_id=$1 AND kind='ATTEMPT'"],
    ["short financial hold", "UPDATE reservations SET amount=1 WHERE proposal_id=$1 AND kind='QUOTE'"],
    ["wrong financial asset", "UPDATE reservations SET asset='BTC' WHERE proposal_id=$1 AND kind='QUOTE'"],
    ["wrong attempt count", "UPDATE reservations SET amount=2 WHERE proposal_id=$1 AND kind='ATTEMPT'"],
  ])("rejects %s without consuming an attempt", async (_label, sql) => {
    const { h, pool, proposalId, alpha } = await approvedProposal();
    await pool.query(sql, [proposalId]);
    expect((await dispatchOnce(h.runtime, h.runtime.clock())).kind).toBe("ABORTED_PRE_ARM");
    expect((h.runtime.execution as PaperExecutionAdapter).submitCount).toBe(0);
    expect(
      (await pool.query("SELECT attempts_consumed FROM leases WHERE id=$1", [alpha.lease_id])).rows[0]
        ?.attempts_consumed,
    ).toBe(0);
    expect((await pool.query("SELECT status FROM approvals WHERE proposal_id=$1", [proposalId])).rows[0]?.status).toBe(
      "INVALIDATED",
    );
  });

  it.each([
    [
      "proposal order",
      "UPDATE proposals SET normalized_order=jsonb_set(jsonb_set(normalized_order,'{quantity}','\"0.3\"'::jsonb),'{notional_quote}','\"30\"'::jsonb) WHERE id=$1",
    ],
    [
      "persisted command payload",
      "UPDATE commands SET exact_payload=jsonb_set(exact_payload,'{quantity}','\"0.3\"'::jsonb) WHERE proposal_id=$1",
    ],
    ["approval revision", "UPDATE approvals SET proposal_revision=99 WHERE proposal_id=$1"],
  ])("rejects changed %s under the original approval binding", async (_label, sql) => {
    const { h, pool, proposalId } = await approvedProposal();
    await pool.query(sql, [proposalId]);
    expect((await dispatchOnce(h.runtime, h.runtime.clock())).kind).toBe("ABORTED_PRE_ARM");
    expect((h.runtime.execution as PaperExecutionAdapter).submitCount).toBe(0);
  });

  it("requires the live writer session to still own its advisory lock", async () => {
    const { h, pool, proposalId } = await approvedProposal();
    const writer = h.runtime.writer;
    if (writer === null) throw new Error("missing writer");
    const replacement = await pool.connect();
    try {
      await releaseWriterLock(writer.client, writer.key);
      expect(await tryAcquireWriterLock(replacement, writer.key)).toBe(true);
      expect((await dispatchOnce(h.runtime, h.runtime.clock())).kind).toBe("IDLE");
      expect((h.runtime.execution as PaperExecutionAdapter).submitCount).toBe(0);
      expect((await pool.query("SELECT state FROM commands WHERE proposal_id=$1", [proposalId])).rows[0]?.state).toBe(
        "READY",
      );
    } finally {
      await releaseWriterLock(replacement, writer.key);
      replacement.release();
    }
  });

  it("records nonterminating in-range drift and sends the exact persisted command", async () => {
    const { h, pool, proposalId } = await approvedProposal("100.03");
    const market = h.runtime.market;
    const execution = h.runtime.execution;
    if (market === null || execution === null) throw new Error("missing adapters");
    const read = market.getSnapshot.bind(market);
    market.getSnapshot = async (symbol) => ({ ...(await read(symbol)), last_price: canonicalizeDecimal("100.04") });
    let sent: ArmedCommand | null = null;
    const submit = execution.submitOnce.bind(execution);
    execution.submitOnce = async (payload) => {
      sent = payload;
      return submit(payload);
    };
    const result = await dispatchOnce(h.runtime, h.runtime.clock());
    expect(result.kind).toBe("ARMED");
    expect((execution as PaperExecutionAdapter).submitCount).toBe(1);
    const persisted = (await pool.query("SELECT exact_payload FROM commands WHERE proposal_id=$1", [proposalId]))
      .rows[0]?.exact_payload;
    expect(sent).toMatchObject({
      quantity: persisted.quantity,
      limit_price: persisted.limit_price,
      symbol: persisted.symbol,
      side: persisted.side,
      payload_hash: persisted.proposal_hash,
    });
    const event = (
      await pool.query("SELECT payload FROM audit_events WHERE account_id=$1 AND type='COMMAND_ARMED'", [h.accountId])
    ).rows[0];
    expect(event?.payload.drift_bps).toBe("0.999700089973008097");
  });
});
