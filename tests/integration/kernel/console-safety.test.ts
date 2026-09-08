import { loadScenario } from "@moneykernel/integrations";
import { appendAuditEvent, lockAccountRow, withTransaction } from "@moneykernel/persistence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURES_DIR } from "../../../apps/kernel/src/fixtures.ts";
import { newId } from "../../../apps/kernel/src/ids.ts";
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

async function start() {
  const h = await startHarness(
    loadScenario("scenario-a-constrained-acquisition", FIXTURES_DIR),
    "scenario-a-constrained-acquisition",
  );
  harnesses.push(h);
  return { h, op: await operator(h) };
}

async function openStream(h: Harness, token: string) {
  const address = await h.app.listen({ host: "127.0.0.1", port: 0 });
  const abort = new AbortController();
  const response = await fetch(`${address}/v1/events/stream?after=0`, {
    headers: { authorization: `Bearer ${token}` },
    signal: abort.signal,
  });
  expect(response.status).toBe(200);
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("no stream reader");
  const stream = { closed: false, events: [] as Array<{ id: string; account_seq: number }> };
  const done = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6);
          if (data !== undefined) stream.events.push(JSON.parse(data));
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    } finally {
      stream.closed = true;
    }
  })();
  await expect.poll(() => stream.events.length).toBeGreaterThan(0);
  return {
    stream,
    close: async () => {
      abort.abort();
      await done;
    },
  };
}

describe("console authorization and resource totals", () => {
  it("excludes the operator cash buffer from displayed available quote", async () => {
    const { h, op } = await start();
    const initial = await opRequest(h, op.token, "GET", "/v1/overview");
    expect(initial.status).toBe(200);
    expect(initial.body.cash_buffer_quote).toBe("10");
    expect(initial.body.available_quote).toBe("100");
    const alpha = seededAgent(h, "agent_alpha");
    const observation = await observationFor(h, alpha.token, "SOLUSDT");
    expect(
      (
        await submitIntent(
          h,
          alpha.token,
          "buffer-reserved",
          buyIntent(alpha.lease_id, "SOLUSDT", "5", "100", observation),
        )
      ).status,
    ).toBe(201);
    const reserved = await opRequest(h, op.token, "GET", "/v1/overview");
    expect(reserved.body.reserved_quote).toBe("5.005");
    expect(reserved.body.cash_buffer_quote).toBe("10");
    expect(reserved.body.available_quote).toBe("94.995");
    const current = await opRequest(h, op.token, "GET", "/v1/policy");
    const changed = await opRequest(
      h,
      op.token,
      "PUT",
      "/v1/policy",
      {
        ...(current.body.policy as Record<string, unknown>),
        min_quote_cash_buffer: "20",
      },
      { "if-match": String(current.body.version), "idempotency-key": "changed-cash-buffer" },
    );
    expect(changed.status).toBe(201);
    const updated = await opRequest(h, op.token, "GET", "/v1/overview");
    // The policy update invalidates the unused proposal and releases its hold.
    expect(updated.body).toMatchObject({ reserved_quote: "0", cash_buffer_quote: "20", available_quote: "90" });
  });

  it.each(["logout", "expiry"])("ends an active event stream on session %s", async (reason) => {
    const { h, op } = await start();
    const connection = await openStream(h, op.token);
    try {
      if (reason === "logout")
        expect((await opRequest(h, op.token, "DELETE", "/v1/auth/session", {})).status).toBe(204);
      else h.tick(12 * 60 * 60 * 1000 + 1);
      expect((await opRequest(h, op.token, "GET", "/v1/auth/session")).status).toBe(401);
      const pool = h.runtime.pool;
      if (pool === null) throw new Error("no pool");
      const eventId = newId("evt");
      await withTransaction(pool, async (tx) => {
        await lockAccountRow(tx, h.accountId);
        await appendAuditEvent(tx, {
          id: eventId,
          accountId: h.accountId,
          type: "ACCOUNT_STOPPED",
          payload: { fixture: "event committed after session ended" },
          occurredAt: new Date(h.clock.now),
        });
      });
      await expect
        .poll(() => connection.stream.closed || connection.stream.events.some((event) => event.id === eventId), {
          timeout: 2500,
        })
        .toBe(true);
      expect(connection.stream.events.some((event) => event.id === eventId)).toBe(false);
      expect(connection.stream.closed).toBe(true);
    } finally {
      await connection.close();
    }
  });

  it("closes active SSE sockets before waiting for server shutdown", async () => {
    const { h, op } = await start();
    const connection = await openStream(h, op.token);
    const closing = h.app.close();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const closed = await Promise.race([
        closing.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 1000);
        }),
      ]);
      expect(closed).toBe(true);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      await connection.close();
      await closing;
    }
  });
});
