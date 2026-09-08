import type { Readiness } from "@moneykernel/contracts";
import { countCommandsByState, withClient } from "@moneykernel/persistence";
import type { KernelRuntime, ReadinessCheck } from "./boot.ts";

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

  if (runtime.writer === null) {
    live.push({ name: "writer_lock", ok: false, detail: "not held" });
  } else {
    try {
      await runtime.writer.client.query("SELECT 1");
      live.push({ name: "writer_lock", ok: true, detail: `held: ${runtime.writer.key}` });
    } catch (error) {
      live.push({ name: "writer_lock", ok: false, detail: `writer session lost: ${errorMessage(error)}` });
    }
  }

  if (runtime.pool !== null && runtime.account !== null) {
    try {
      const accountId = runtime.account.id;
      const counts = await withClient(runtime.pool, (client) => countCommandsByState(client, accountId));
      const blocking = counts.ARMED + counts.OUTCOME_UNKNOWN;
      live.push({
        name: "unresolved_commands",
        ok: blocking === 0,
        detail: `armed=${counts.ARMED} unknown=${counts.OUTCOME_UNKNOWN}`,
      });
    } catch (error) {
      live.push({ name: "unresolved_commands", ok: false, detail: errorMessage(error) });
    }
  }

  const liveNames = new Set(live.map((c) => c.name));
  const checks = [...runtime.bootChecks.filter((c) => !liveNames.has(c.name)), ...live];
  return { ready: checks.every((c) => c.ok), checks };
}
