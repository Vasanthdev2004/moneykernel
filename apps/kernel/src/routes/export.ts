import { readFileSync } from "node:fs";
import { join } from "node:path";
import { errorEnvelope, type RunExport, RunExportSchema } from "@moneykernel/contracts";
import { exportAccountRows, getAccountById, listAuditEvents, withClient } from "@moneykernel/persistence";
import type { FastifyInstance } from "fastify";
import { requireOperator } from "../auth/operator.ts";
import type { KernelRuntime } from "../boot.ts";
import { FIXTURES_DIR } from "../fixtures.ts";
import { provenanceFor } from "../services/provenance.ts";

const MANIFEST_PATH = join(FIXTURES_DIR, "..", "..", "docs", "integration-manifest.json");

function manifestRef(): string {
  try {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as { checked_at?: unknown; status?: unknown };
    return `docs/integration-manifest.json (checked_at ${String(manifest.checked_at ?? "unknown")}, status ${String(manifest.status ?? "unknown")})`;
  } catch {
    return "docs/integration-manifest.json";
  }
}

function iso(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

/** Row-level sanitization: timestamps to ISO, bigints to numbers where the export schema expects them. */
function plain(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[key] = iso(value);
  return out;
}

/**
 * Sanitized audit/receipt export (prd.md 15.2 `GET /v1/runs/:id/export`, 23.4).
 * `:id` is the loaded account id or `current`; another account's data is never
 * served by this process. The bundle is validated against the frozen export
 * contract before it leaves, so `pnpm verify:receipt` can rely on its shape.
 */
export async function exportRoutes(app: FastifyInstance, options: { runtime: KernelRuntime }): Promise<void> {
  const { runtime } = options;
  app.addHook("preHandler", requireOperator(runtime));

  app.get("/v1/runs/:id/export", async (request, reply) => {
    if (runtime.pool === null || runtime.account === null) {
      reply.code(503);
      return errorEnvelope("NOT_READY", "kernel has no loaded account", request.id);
    }
    const { id } = request.params as { id: string };
    const accountId = runtime.account.id;
    if (id !== "current" && id !== accountId) {
      reply.code(404);
      return errorEnvelope("NOT_FOUND", "only the loaded account can be exported by this kernel", request.id);
    }
    const bundle = await withClient(runtime.pool, async (client): Promise<RunExport | null> => {
      const account = await getAccountById(client, accountId);
      if (account === null) return null;
      const rows = await exportAccountRows(client, accountId);
      const events = await listAuditEvents(client, accountId, { limit: 5000 });
      const receipts = rows.receipts.map((r) => ({
        decision_id: String(r.id),
        intent_id: String(r.intent_id),
        proposal_id: r.proposal_id === null ? null : String(r.proposal_id),
        engine_version: String(r.engine_version),
        normalized_request: r.normalized_request,
        input_refs: r.input_refs,
        outcome: r.outcome,
        reason_codes: r.reasons,
        checks: r.checks,
        evaluated_at: (r.evaluated_at as Date).toISOString(),
        decision_fingerprint: String(r.decision_fingerprint),
        evaluation_input: r.evaluation_input ?? null,
      }));
      return RunExportSchema.parse({
        schema_version: "1",
        exported_at: runtime.clock().toISOString(),
        engine_version: runtime.config.engineVersion,
        environment: runtime.config.environment,
        account: {
          id: account.id,
          alias: account.alias,
          environment: account.environment,
          status: account.status,
          epoch: account.epoch,
          quote_asset: account.quote_asset,
          configuration_hash: account.configuration_hash,
        },
        provenance: provenanceFor(runtime.config, "SCRIPTED"),
        integration_manifest: manifestRef(),
        policy_versions: rows.policy_versions.map(plain),
        agents: rows.agents.map(plain),
        leases: rows.leases.map(plain),
        intents: rows.intents.map((r) => ({ ...plain(r), account_seq: Number(r.account_seq) })),
        receipts,
        proposals: rows.proposals.map(plain),
        reservations: rows.reservations.map(plain),
        approvals: rows.approvals.map(plain),
        commands: rows.commands.map(plain),
        orders: rows.orders.map(plain),
        fills: rows.fills.map(plain),
        ledger_entries: rows.ledger_entries.map((r) => ({ ...plain(r), sequence: Number(r.sequence) })),
        balances: rows.balances.map(plain),
        allocations: rows.allocations.map(plain),
        conflicts: rows.conflicts.map(plain),
        incidents: rows.incidents.map(plain),
        audit_events: events,
        checkpoint: { previous_hash: null, event_count: events.length },
      });
    });
    if (bundle === null) {
      reply.code(503);
      return errorEnvelope("NOT_READY", "account row disappeared", request.id);
    }
    reply.header("Content-Disposition", `attachment; filename="moneykernel-run-${bundle.account.alias}.json"`);
    return bundle;
  });
}
