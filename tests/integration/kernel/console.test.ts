import { verifyEventChain } from "@moneykernel/contracts";
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

type EventRow = { id: string; account_seq: number; type: string; payload: Record<string, unknown> };

describe("console reads (prd.md 12.6, 15.2, 17.3, T-53)", () => {
  it("serves the overview, the decision document, and a cursor-paged event log without gaps or duplicates", async () => {
    const h = await startHarness(roomy(), "scenario-a-constrained-acquisition");
    harnesses.push(h);
    const alpha = seededAgent(h, "agent_alpha");
    const op = await operator(h);

    const before = await opRequest(h, op.token, "GET", "/v1/overview");
    expect(before.status).toBe(200);
    expect(before.body.available_quote).toBe("1000");
    expect(before.body.reserved_quote).toBe("0");
    expect(before.body.pending_approvals).toBe(0);

    const obs = await observationFor(h, alpha.token, "SOLUSDT");
    const submitted = await submitIntent(
      h,
      alpha.token,
      "console-buy-001",
      buyIntent(alpha.lease_id, "SOLUSDT", "20", "100", obs),
    );
    expect(submitted.status).toBe(201);
    const reserved = await opRequest(h, op.token, "GET", "/v1/overview");
    expect(reserved.body.reserved_quote).toBe("20.02");
    expect(reserved.body.available_quote).toBe("979.98");
    expect(reserved.body.reservations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ asset: "USDT", kind: "QUOTE", state: "HELD", amount: "20.02" }),
      ]),
    );

    h.tick(800);
    await sweepProposals(h.runtime, new Date(h.clock.now));
    const queue = await opRequest(h, op.token, "GET", "/v1/overview");
    expect(queue.body.pending_approvals).toBe(1);

    // The decision document behind the proposal and behind the intent are the same record.
    const byProposal = await opRequest(h, op.token, "GET", `/v1/proposals/${String(submitted.body.proposal_id)}`);
    expect(byProposal.status).toBe(200);
    const byIntent = await opRequest(h, op.token, "GET", `/v1/intents/${String(submitted.body.intent_id)}`);
    expect(byIntent.body).toEqual(byProposal.body);
    const doc = byIntent.body as {
      receipts: Array<{ checks: Array<{ rule: string; result: string }>; decision_fingerprint: string }>;
      proposals: Array<{ state: string; reservations: unknown[]; approvals: unknown[] }>;
      command: null | { state: string };
    };
    expect(doc.receipts.length).toBe(1);
    expect(doc.receipts[0]?.checks.length).toBeGreaterThan(3);
    expect(doc.receipts[0]?.decision_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.proposals[0]?.state).toBe("AWAITING_APPROVAL");
    expect(doc.proposals[0]?.reservations.length).toBe(2);
    expect(doc.command).toBeNull();
    expect((await opRequest(h, op.token, "GET", "/v1/intents/intent_missing")).status).toBe(404);

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
      { "idempotency-key": "console-approve-001" },
    );
    expect(approved.status).toBe(201);
    const report = await dispatchOnce(h.runtime, new Date(h.clock.now));
    expect(report.kind).toBe("ARMED");
    const settled = await opRequest(h, op.token, "GET", `/v1/intents/${String(submitted.body.intent_id)}`);
    const linked = settled.body as {
      proposals: Array<{ approvals: Array<{ status: string }> }>;
      command: { state: string; reconciled_at: string | null };
      order: { status: string };
      fills: unknown[];
      ledger_entries: unknown[];
    };
    expect(linked.proposals[0]?.approvals.map((a) => a.status)).toEqual(["CONSUMED"]);
    expect(linked.command.state).toBe("ACCEPTED");
    expect(linked.command.reconciled_at).not.toBeNull();
    expect(linked.order.status).toBe("FILLED");
    expect(linked.fills.length).toBe(1);
    expect(linked.ledger_entries.length).toBe(3);
    const after = await opRequest(h, op.token, "GET", "/v1/overview");
    expect(after.body.reserved_quote).toBe("0");
    expect(after.body.available_quote).toBe("979.98");
    expect((after.body.commands as { ACCEPTED: number }).ACCEPTED).toBe(1);

    // Event log: a tail for the first paint, then cursor pages that never repeat or skip a sequence (T-53).
    const tail = await opRequest(h, op.token, "GET", "/v1/events?tail=1&limit=5");
    const tailEvents = tail.body.events as EventRow[];
    expect(tailEvents.length).toBe(5);
    const page1 = await opRequest(h, op.token, "GET", "/v1/events?after=0&limit=7");
    const p1 = page1.body.events as EventRow[];
    expect(p1.map((e) => e.account_seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const page2 = await opRequest(h, op.token, "GET", `/v1/events?after=${String(page1.body.next_after)}&limit=1000`);
    const p2 = page2.body.events as EventRow[];
    expect(p2[0]?.account_seq).toBe(8);
    const all = [...p1, ...p2];
    expect(new Set(all.map((e) => e.id)).size).toBe(all.length);
    expect(all.map((e) => e.account_seq)).toEqual(all.map((_, i) => i + 1));
    expect(tailEvents[tailEvents.length - 1]?.account_seq).toBe(all.length);
    expect(all.map((e) => e.type)).toEqual(
      expect.arrayContaining(["APPROVAL_CREATED", "COMMAND_ARMED", "FILL_RECONCILED"]),
    );
    expect(verifyEventChain(all as never, null).ok).toBe(true);
    const nothingNew = await opRequest(h, op.token, "GET", `/v1/events?after=${String(page2.body.next_after)}`);
    expect((nothingNew.body.events as unknown[]).length).toBe(0);
    expect(nothingNew.body.next_after).toBe(page2.body.next_after);
  });

  it("streams committed events over SSE from a durable cursor and catches up after a reconnect", async () => {
    const h = await startHarness(roomy(), "scenario-a-constrained-acquisition");
    harnesses.push(h);
    const op = await operator(h);
    const alpha = seededAgent(h, "agent_alpha");
    const address = await h.app.listen({ host: "127.0.0.1", port: 0 });

    async function readEvents(after: number, expectAtLeast: number, timeoutMs = 4000): Promise<EventRow[]> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const seen: EventRow[] = [];
      try {
        const res = await fetch(`${address}/v1/events/stream?after=${after}`, {
          headers: { authorization: `Bearer ${op.token}`, accept: "text/event-stream" },
          signal: controller.signal,
        });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/event-stream");
        const reader = res.body?.getReader();
        if (reader === undefined) throw new Error("no body");
        const decoder = new TextDecoder();
        let buffer = "";
        while (seen.length < expectAtLeast) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = frame
              .split("\n")
              .find((line) => line.startsWith("data: "))
              ?.slice(6);
            if (data !== undefined) seen.push(JSON.parse(data) as EventRow);
            boundary = buffer.indexOf("\n\n");
          }
        }
      } catch (error) {
        if (!(error instanceof Error && error.name === "AbortError")) throw error;
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
      return seen;
    }

    // Catch-up from genesis delivers the seeded history in order.
    const history = await readEvents(0, 3);
    expect(history.length).toBeGreaterThanOrEqual(3);
    expect(history.map((e) => e.account_seq)).toEqual(history.map((_, i) => i + 1));

    // New commits after the cursor arrive; a reconnect from the last id never repeats them.
    const obs = await observationFor(h, alpha.token, "SOLUSDT");
    const last = history[history.length - 1]?.account_seq ?? 0;
    const submitted = await submitIntent(
      h,
      alpha.token,
      "console-sse-001",
      buyIntent(alpha.lease_id, "SOLUSDT", "5", "100", obs),
    );
    expect(submitted.status).toBe(201);
    const fresh = await readEvents(last, 1);
    expect(fresh[0]?.account_seq).toBeGreaterThan(last);
    const types = fresh.map((e) => e.type);
    expect(types).toContain("INTENT_RECEIVED");
    const lastSeen = fresh[fresh.length - 1]?.account_seq ?? last;
    const again = await readEvents(lastSeen, 1, 1200);
    expect(again.every((e) => e.account_seq > lastSeen)).toBe(true);
  });
});
