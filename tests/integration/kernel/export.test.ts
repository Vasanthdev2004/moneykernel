import { RunExportSchema, verifyEventChain } from "@moneykernel/contracts";
import { loadScenario, type Scenario } from "@moneykernel/integrations";
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
  const s = loadScenario("scenario-a-constrained-acquisition", FIXTURES_DIR);
  s.account.balances = { USDT: "1000" };
  s.account.inventory_allocations = {};
  s.policy = {
    ...(s.policy ?? {}),
    max_order_notional_quote: "1000",
    max_symbol_share: "1",
    min_quote_cash_buffer: "0",
    valuation_buffer_quote: "0",
    max_unique_intents_per_60s: 1000,
  };
  return s;
}

describe("sanitized run export (prd.md 15.2, 14.5, 23.4; T-54, T-55, T-58)", () => {
  it("exports a contract-valid bundle with archived evaluator context, chain, and no secrets", async () => {
    const h = await startHarness(roomy(), "scenario-a-constrained-acquisition");
    harnesses.push(h);
    const alpha = seededAgent(h, "agent_alpha");
    const op = await operator(h);
    const obs = await observationFor(h, alpha.token, "SOLUSDT");
    const submitted = await submitIntent(
      h,
      alpha.token,
      "export-buy-001",
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
      { "idempotency-key": "export-approve-001" },
    );
    expect(approved.status).toBe(201);
    expect((await dispatchOnce(h.runtime, new Date(h.clock.now))).kind).toBe("ARMED");

    expect((await opRequest(h, op.token, "GET", "/v1/runs/acct_other/export")).status).toBe(404);
    const res = await opRequest(h, op.token, "GET", "/v1/runs/current/export");
    expect(res.status).toBe(200);
    expect(String(res.headers["content-disposition"])).toContain("moneykernel-run-");
    const bundle = RunExportSchema.parse(res.body);
    expect(bundle.account.id).toBe(h.accountId);
    expect(bundle.environment).toBe("REPLAY");
    expect(bundle.receipts.length).toBe(1);
    expect(bundle.receipts[0]?.evaluation_input).not.toBeNull();
    expect((bundle.receipts[0]?.evaluation_input as { intent: { symbol: string } }).intent.symbol).toBe("SOLUSDT");
    expect(bundle.commands.length).toBe(1);
    expect(bundle.fills.length).toBe(1);
    expect(bundle.ledger_entries.length).toBe(4);
    expect(verifyEventChain(bundle.audit_events, bundle.checkpoint.previous_hash).ok).toBe(true);
    expect(bundle.audit_events.length).toBe(bundle.checkpoint.event_count);
    const text = JSON.stringify(bundle);
    expect(text).not.toContain("token_hash");
    expect(text).not.toContain(alpha.token);
    expect(text).not.toContain(op.token);
    expect(text).not.toMatch(/mk[ao]_[A-Za-z0-9_-]{20,}/);
    const byId = await opRequest(h, op.token, "GET", `/v1/runs/${h.accountId}/export`);
    expect(byId.status).toBe(200);
  });
});
