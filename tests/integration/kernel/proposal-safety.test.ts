import { loadScenario, type PaperExecutionAdapter } from "@moneykernel/integrations";
import {
  getProposalById,
  listAuditEvents,
  listCommands,
  listReservationsForProposal,
  withClient,
} from "@moneykernel/persistence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatchOnce } from "../../../apps/kernel/src/dispatcher/dispatch.ts";
import { FIXTURES_DIR } from "../../../apps/kernel/src/fixtures.ts";
import { sweepProposals } from "../../../apps/kernel/src/services/proposals.ts";
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

async function approvedBuy() {
  const h = await startHarness(
    loadScenario("scenario-b-opposing-intents", FIXTURES_DIR),
    "scenario-b-opposing-intents",
  );
  harnesses.push(h);
  const alpha = seededAgent(h, "agent_alpha");
  const op = await operator(h);
  const buy = await submitIntent(
    h,
    alpha.token,
    "proposal-safety-buy",
    buyIntent(alpha.lease_id, "BTCUSDT", "50", "100000", await observationFor(h, alpha.token, "BTCUSDT")),
  );
  expect(buy.status).toBe(201);
  h.tick(800);
  await sweepProposals(h.runtime, new Date(h.clock.now));
  expect(
    (
      await opRequest(
        h,
        op.token,
        "POST",
        `/v1/proposals/${String(buy.body.proposal_id)}/approve`,
        {
          proposal_revision: buy.body.proposal_revision,
          proposal_hash: buy.body.proposal_hash,
          expected_account_epoch: 1,
          operator_confirmation: true,
        },
        { "idempotency-key": "proposal-safety-approval" },
      )
    ).status,
  ).toBe(201);
  return { h, op, proposalId: String(buy.body.proposal_id) };
}

describe("proposal authority boundaries", () => {
  it("opposite admission immediately invalidates an unused approval before any scheduler sweep", async () => {
    const { h, proposalId } = await approvedBuy();
    const guard = seededAgent(h, "agent_inventory_guard");
    const sell = await submitIntent(
      h,
      guard.token,
      "proposal-safety-sell",
      sellIntent(guard.lease_id, "BTCUSDT", "BTC", "0.0002", "100000", await observationFor(h, guard.token, "BTCUSDT")),
    );
    expect(sell.status).toBe(201);
    expect(sell.body.state).toBe("CONFLICT_HELD");
    const pool = h.runtime.pool;
    if (pool === null) throw new Error("no pool");
    expect((await withClient(pool, (c) => getProposalById(c, proposalId)))?.state).toBe("CONFLICT_HELD");
    expect((await withClient(pool, (c) => listCommands(c, h.accountId))).map((c) => c.state)).toEqual([
      "ABORTED_PRE_ARM",
    ]);
    expect((await dispatchOnce(h.runtime, new Date(h.clock.now))).kind).toBe("IDLE");
    expect((h.runtime.execution as PaperExecutionAdapter).submitCount).toBe(0);
  });

  it("never rejects or expires a proposal whose order has already armed", async () => {
    const { h, op, proposalId } = await approvedBuy();
    expect((await dispatchOnce(h.runtime, new Date(h.clock.now))).kind).toBe("ARMED");
    const pool = h.runtime.pool;
    if (pool === null) throw new Error("no pool");
    const before = await withClient(pool, (c) => getProposalById(c, proposalId));
    const holds = await withClient(pool, (c) => listReservationsForProposal(c, proposalId));
    const rejected = await opRequest(h, op.token, "POST", `/v1/proposals/${proposalId}/reject`, { reason: "too late" });
    expect(rejected.status).toBe(409);
    h.tick(180_000);
    expect((await sweepProposals(h.runtime, new Date(h.clock.now))).expired).not.toContain(proposalId);
    expect(
      (await opRequest(h, op.token, "POST", "/v1/account/stop", {}, { "idempotency-key": "proposal-safety-stop" }))
        .status,
    ).toBe(200);
    expect((await withClient(pool, (c) => getProposalById(c, proposalId)))?.state).toBe(before?.state);
    expect(await withClient(pool, (c) => listReservationsForProposal(c, proposalId))).toEqual(holds);
    const events = await withClient(pool, (c) => listAuditEvents(c, h.accountId));
    expect(
      events.some(
        (e) =>
          e.type === "PROPOSAL_STATE_CHANGED" &&
          e.payload.proposal_id === proposalId &&
          ["REJECTED", "EXPIRED", "INVALIDATED"].includes(String(e.payload.to)),
      ),
    ).toBe(false);
  });
});
