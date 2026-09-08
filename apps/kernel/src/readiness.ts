import type { Readiness } from "@moneykernel/contracts";
import { countOutstandingCommands, getAccountById, withClient } from "@moneykernel/persistence";
import type { KernelRuntime, ReadinessCheck } from "./boot.ts";
import { hasLiveWriterLease } from "./services/writer.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Readiness (prd.md 19.5): database connectivity, compatible migrations, valid
 * configuration, writer ownership, required capability checks, and no blocking
 * unresolved account state. Liveness is separate and never implies readiness.
 */
export async function computeReadiness(runtime: KernelRuntime): Promise<Readiness> {
  const live: ReadinessCheck[] = [];

  if (runtime.pool === null) {
    live.push({ name: "database", ok: false, detail: "no pool; boot could not reach the database" });
  } else {
    try {
      await runtime.pool.query("SELECT 1");
      live.push({ name: "database", ok: true, detail: "reachable" });
    } catch (error) {
      live.push({ name: "database", ok: false, detail: errorMessage(error) });
    }
  }

  const writerHeld = await hasLiveWriterLease(runtime);
  live.push({
    name: "writer_lock",
    ok: writerHeld,
    detail: writerHeld ? `held: ${runtime.writer?.key}` : "not held by this process",
  });

  if (runtime.pool !== null && runtime.account !== null) {
    try {
      const accountId = runtime.account.id;
      const { counts, account } = await withClient(runtime.pool, async (client) => ({
        counts: await countOutstandingCommands(client, accountId),
        account: await getAccountById(client, accountId),
      }));
      live.push({
        name: "account_status",
        ok: account?.status === "READY" || account?.status === "PAUSED",
        detail: account?.status ?? "account missing",
      });
      live.push({
        name: "unresolved_commands",
        ok: counts.total === 0,
        detail: `armed=${counts.armed} unknown=${counts.unknown} accepted_unreconciled=${counts.accepted_unreconciled}`,
      });
    } catch (error) {
      live.push({ name: "account_status", ok: false, detail: errorMessage(error) });
      live.push({ name: "unresolved_commands", ok: false, detail: errorMessage(error) });
    }
  }

  const liveNames = new Set(live.map((c) => c.name));
  // The boot recovery report describes that attempt, not the current account.
  // A later successful query can settle its unknown commands without a restart;
  // the live unresolved_commands check remains the authority for that state.
  const checks = [...runtime.bootChecks.filter((c) => c.name !== "recovery" && !liveNames.has(c.name)), ...live];
  return { ready: checks.every((c) => c.ok), checks };
}
