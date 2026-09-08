import { type AuditEvent, errorEnvelope, PolicySchema } from "@moneykernel/contracts";
import { add, dec, sub, toDecimalString, ZERO } from "@moneykernel/domain";
import {
  countCommandsByState,
  countOutstandingCommands,
  getAccountById,
  getCommandForProposal,
  getCurrentPolicy,
  getIntentById,
  getOrderForCommand,
  getProposalById,
  listApprovalsForProposal,
  listAssetBalances,
  listAuditEvents,
  listConflicts,
  listFillsForOrder,
  listIncidents,
  listLedgerEntries,
  listOutstandingReservations,
  listPreArmProposals,
  listProposalsForIntent,
  listReceiptsForIntent,
  listReservationsForProposal,
  type PoolClient,
  withClient,
} from "@moneykernel/persistence";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireOperator } from "../auth/operator.ts";
import type { KernelRuntime } from "../boot.ts";
import { computeReadiness } from "../readiness.ts";

const STREAM_POLL_MS = 500;
const STREAM_HEARTBEAT_MS = 15_000;
const MAX_EVENT_PAGE = 1000;

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function parseAfter(raw: unknown): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function eventFrame(event: AuditEvent): string {
  return `id: ${event.account_seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Everything the receipt view and approval drawer need for one intent (prd.md 17.3). */
async function intentDocument(client: PoolClient, accountId: string, intentId: string) {
  const intent = await getIntentById(client, intentId);
  if (intent === null || intent.account_id !== accountId) return null;
  const receipts = await listReceiptsForIntent(client, intentId);
  const proposals = [];
  let command = null;
  for (const p of await listProposalsForIntent(client, intentId)) {
    const reservations = await listReservationsForProposal(client, p.id);
    const approvals = await listApprovalsForProposal(client, p.id);
    const c = await getCommandForProposal(client, p.id);
    if (c !== null) command = c;
    proposals.push({
      proposal_id: p.id,
      revision: p.revision,
      state: p.state,
      normalized_order: p.normalized_order,
      proposal_hash: p.proposal_hash,
      expires_at: p.expires_at.toISOString(),
      policy_id: p.policy_id,
      lease_revision: p.lease_revision,
      account_epoch: p.account_epoch,
      created_at: p.created_at.toISOString(),
      updated_at: p.updated_at.toISOString(),
      reservations: reservations.map((r) => ({
        id: r.id,
        asset: r.asset,
        amount: r.amount,
        kind: r.kind,
        state: r.state,
        created_at: r.created_at.toISOString(),
        armed_at: iso(r.armed_at),
        released_at: iso(r.released_at),
      })),
      approvals: approvals.map((a) => ({
        id: a.id,
        status: a.status,
        operator_id: a.operator_id,
        account_epoch: a.account_epoch,
        proposal_revision: a.proposal_revision,
        proposal_hash: a.proposal_hash,
        expires_at: a.expires_at.toISOString(),
        consumed_at: iso(a.consumed_at),
        created_at: a.created_at.toISOString(),
      })),
    });
  }
  const order = command === null ? null : await getOrderForCommand(client, command.id);
  const fills = order === null ? [] : await listFillsForOrder(client, order.id);
  const ledger = [];
  for (const fill of fills) ledger.push(...(await listLedgerEntries(client, accountId, { sourceFillId: fill.id })));
  return {
    intent: {
      id: intent.id,
      agent_id: intent.agent_id,
      lease_id: intent.lease_id,
      idempotency_key: intent.idempotency_key,
      canonical_payload: intent.canonical_payload,
      payload_hash: intent.payload_hash,
      account_seq: Number(intent.account_seq),
      created_at: intent.created_at.toISOString(),
    },
    receipts: receipts.map((r) => ({
      id: r.id,
      proposal_id: r.proposal_id,
      outcome: r.outcome,
      reasons: r.reasons,
      input_refs: r.input_refs,
      checks: r.checks,
      normalized_request: r.normalized_request,
      decision_fingerprint: r.decision_fingerprint,
      evaluated_at: r.evaluated_at.toISOString(),
      engine_version: r.engine_version,
    })),
    proposals,
    command:
      command === null
        ? null
        : {
            ...command,
            created_at: command.created_at.toISOString(),
            updated_at: command.updated_at.toISOString(),
            armed_at: iso(command.armed_at),
            reconciled_at: iso(command.reconciled_at),
          },
    order: order === null ? null : { ...order, last_observed_at: order.last_observed_at.toISOString() },
    fills: fills.map((f) => ({ ...f, event_time: f.event_time.toISOString() })),
    ledger_entries: ledger.map((l) => ({ ...l, created_at: l.created_at.toISOString() })),
  };
}

/**
 * Console reads (prd.md 15.2, 17): an overview for the status strip, the event
 * log with a durable cursor (JSON page and SSE stream, prd.md 12.6), and the
 * full decision document behind a proposal or intent. Read-only; the event
 * stream explains state and is never a command channel.
 */
export async function consoleRoutes(app: FastifyInstance, options: { runtime: KernelRuntime }): Promise<void> {
  const { runtime } = options;
  app.addHook("preHandler", requireOperator(runtime));

  const streams = new Set<() => void>();
  // Hijacked SSE responses must end before server.close waits for active connections.
  app.addHook("preClose", async () => {
    for (const close of streams) close();
    streams.clear();
  });

  const requireRuntime = (reply: FastifyReply, request: FastifyRequest) => {
    if (runtime.pool === null || runtime.account === null) {
      reply.code(503);
      return errorEnvelope("NOT_READY", "kernel has no loaded account", request.id);
    }
    return null;
  };

  app.get("/v1/overview", async (request, reply) => {
    const blocked = requireRuntime(reply, request);
    if (blocked !== null || runtime.pool === null || runtime.account === null) return blocked;
    const accountId = runtime.account.id;
    const quoteAsset = runtime.account.quote_asset;
    const readiness = await computeReadiness(runtime);
    return withClient(runtime.pool, async (client) => {
      const account = await getAccountById(client, accountId);
      if (account === null) {
        reply.code(503);
        return errorEnvelope("NOT_READY", "account row disappeared", request.id);
      }
      const balances = await listAssetBalances(client, accountId);
      const sums = new Map<string, { asset: string; kind: string; state: string; amount: ReturnType<typeof dec> }>();
      for (const r of await listOutstandingReservations(client, accountId)) {
        const key = `${r.asset}|${r.kind}|${r.state}`;
        const current = sums.get(key) ?? { asset: r.asset, kind: r.kind, state: r.state, amount: ZERO };
        current.amount = add(current.amount, dec(r.amount));
        sums.set(key, current);
      }
      let reservedQuote = ZERO;
      for (const s of sums.values())
        if (s.asset === quoteAsset && s.kind === "QUOTE") reservedQuote = add(reservedQuote, s.amount);
      const ownedQuote = dec(balances.find((b) => b.asset === quoteAsset)?.owned_quantity ?? "0");
      const policyRow = await getCurrentPolicy(client, accountId);
      const policy = policyRow === null ? null : PolicySchema.parse(policyRow.canonical_policy);
      const cashBuffer = policy === null ? ZERO : dec(policy.min_quote_cash_buffer);
      const pending = await listPreArmProposals(client, accountId);
      const incidents = await listIncidents(client, accountId, "OPEN");
      const outstanding = await countOutstandingCommands(client, accountId);
      return {
        server_time: runtime.clock().toISOString(),
        account: {
          id: account.id,
          alias: account.alias,
          environment: account.environment,
          status: account.status,
          epoch: account.epoch,
          quote_asset: account.quote_asset,
        },
        balances: balances.map((b) => ({ asset: b.asset, owned_quantity: b.owned_quantity })),
        reservations: [...sums.values()].map((s) => ({
          asset: s.asset,
          kind: s.kind,
          state: s.state,
          amount: toDecimalString(s.amount),
        })),
        available_quote: toDecimalString(sub(sub(ownedQuote, reservedQuote), cashBuffer)),
        reserved_quote: toDecimalString(reservedQuote),
        cash_buffer_quote: toDecimalString(cashBuffer),
        pending_approvals: pending.filter((p) => p.state === "AWAITING_APPROVAL").length,
        open_conflicts: (await listConflicts(client, accountId, "OPEN")).length,
        open_incidents: {
          CRITICAL: incidents.filter((i) => i.severity === "CRITICAL").length,
          WARNING: incidents.filter((i) => i.severity === "WARNING").length,
          INFO: incidents.filter((i) => i.severity === "INFO").length,
        },
        commands: await countCommandsByState(client, accountId),
        in_flight_commands: outstanding.total,
        unresolved_commands: outstanding.unknown + outstanding.accepted_unreconciled,
        readiness,
      };
    });
  });

  /** One page of the hash-chained event log after a durable cursor (account_seq). */
  app.get("/v1/events", async (request, reply) => {
    const blocked = requireRuntime(reply, request);
    if (blocked !== null || runtime.pool === null || runtime.account === null) return blocked;
    const accountId = runtime.account.id;
    const query = request.query as { after?: string; limit?: string; tail?: string };
    const limit = Math.min(Math.max(parseAfter(query.limit) || 200, 1), MAX_EVENT_PAGE);
    const events = await withClient(runtime.pool, async (client) => {
      if (query.tail !== undefined) {
        // The most recent `limit` events, still ascending, for a first paint.
        const result = await client.query<{ n: string }>(
          "SELECT COALESCE(MAX(account_seq), 0)::text AS n FROM audit_events WHERE account_id = $1",
          [accountId],
        );
        const latest = Number(result.rows[0]?.n ?? "0");
        return listAuditEvents(client, accountId, { afterSeq: Math.max(latest - limit, 0), limit });
      }
      return listAuditEvents(client, accountId, { afterSeq: parseAfter(query.after), limit });
    });
    const last = events[events.length - 1];
    return {
      events,
      next_after: last === undefined ? parseAfter(query.after) : last.account_seq,
      server_time: runtime.clock().toISOString(),
    };
  });

  /**
   * SSE stream from a durable cursor (prd.md 12.6): `after` query or Last-Event-ID
   * header, catch-up first, then committed events as they land; heartbeats keep
   * proxies from closing the connection. Deliveries may repeat; ids are the
   * account sequence so clients deduplicate.
   */
  app.get("/v1/events/stream", async (request, reply) => {
    const blocked = requireRuntime(reply, request);
    if (blocked !== null || runtime.pool === null || runtime.account === null) return blocked;
    const pool = runtime.pool;
    const accountId = runtime.account.id;
    const query = request.query as { after?: string };
    const lastEventId = request.headers["last-event-id"];
    let cursor = lastEventId !== undefined ? parseAfter(lastEventId) : parseAfter(query.after);
    const sessionToken = request.operator?.token;
    const authorized = (): boolean =>
      sessionToken !== undefined && runtime.sessions.get(sessionToken, runtime.clock()) !== null;

    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    });
    reply.hijack();
    res.write(`retry: 1000\n: connected after=${cursor}\n\n`);

    let closed = false;
    let busy = false;
    const pump = async (): Promise<void> => {
      if (closed || busy) return;
      if (!authorized()) {
        close();
        return;
      }
      busy = true;
      try {
        const events = await withClient(pool, (client) =>
          listAuditEvents(client, accountId, { afterSeq: cursor, limit: MAX_EVENT_PAGE }),
        );
        if (!authorized()) {
          close();
          return;
        }
        for (const event of events) {
          // The query may have waited while a logout or session expiry invalidated its authorization.
          if (closed || !authorized()) {
            close();
            break;
          }
          res.write(eventFrame(event));
          cursor = event.account_seq;
        }
      } catch (error) {
        if (!authorized()) close();
        else if (!closed) res.write(`: read failed ${error instanceof Error ? error.message : String(error)}\n\n`);
      } finally {
        busy = false;
      }
    };
    const poll = setInterval(() => void pump(), STREAM_POLL_MS);
    const heartbeat = setInterval(() => {
      if (closed) return;
      if (!authorized()) close();
      else res.write(": ping\n\n");
    }, STREAM_HEARTBEAT_MS);
    const close = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(poll);
      clearInterval(heartbeat);
      streams.delete(close);
      res.end();
    };
    request.raw.on("close", close);
    res.on("close", close);
    streams.add(close);
    await pump();
  });

  app.get("/v1/intents/:id", async (request, reply) => {
    const blocked = requireRuntime(reply, request);
    if (blocked !== null || runtime.pool === null || runtime.account === null) return blocked;
    const accountId = runtime.account.id;
    const { id } = request.params as { id: string };
    const document = await withClient(runtime.pool, (client) => intentDocument(client, accountId, id));
    if (document === null) {
      reply.code(404);
      return errorEnvelope("NOT_FOUND", "intent not found", request.id);
    }
    return document;
  });

  app.get("/v1/proposals/:id", async (request, reply) => {
    const blocked = requireRuntime(reply, request);
    if (blocked !== null || runtime.pool === null || runtime.account === null) return blocked;
    const accountId = runtime.account.id;
    const { id } = request.params as { id: string };
    const document = await withClient(runtime.pool, async (client) => {
      const proposal = await getProposalById(client, id);
      if (proposal === null || proposal.account_id !== accountId) return null;
      return intentDocument(client, accountId, proposal.intent_id);
    });
    if (document === null) {
      reply.code(404);
      return errorEnvelope("NOT_FOUND", "proposal not found", request.id);
    }
    return document;
  });
}
