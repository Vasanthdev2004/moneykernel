import type { PoolClient } from "pg";
import type { CommandRow } from "./coordination.ts";

export type CommandState =
  | "READY"
  | "ABORTED_PRE_ARM"
  | "ARMED"
  | "ACCEPTED"
  | "REJECTED_CONFIRMED"
  | "OUTCOME_UNKNOWN";

export type CommandStateCounts = Record<CommandState, number>;

const EMPTY_COUNTS: CommandStateCounts = {
  READY: 0,
  ABORTED_PRE_ARM: 0,
  ARMED: 0,
  ACCEPTED: 0,
  REJECTED_CONFIRMED: 0,
  OUTCOME_UNKNOWN: 0,
};

/** Raw state counts. Use countOutstandingCommands for readiness: ACCEPTED is not proof of reconciliation. */
export async function countCommandsByState(client: PoolClient, accountId: string): Promise<CommandStateCounts> {
  const result = await client.query<{ state: CommandState; n: number }>(
    "SELECT state, count(*)::int AS n FROM commands WHERE account_id = $1 GROUP BY state",
    [accountId],
  );
  const counts: CommandStateCounts = { ...EMPTY_COUNTS };
  for (const row of result.rows) counts[row.state] = row.n;
  return counts;
}

export type OutstandingCommandCounts = {
  armed: number;
  unknown: number;
  accepted_unreconciled: number;
  total: number;
};

const ACCEPTED_UNRECONCILED = `c.state = 'ACCEPTED' AND (
  c.reconciled_at IS NULL
  OR NOT EXISTS (SELECT 1 FROM orders o WHERE o.command_id = c.id AND o.account_id = c.account_id)
  OR EXISTS (SELECT 1 FROM orders o WHERE o.command_id = c.id
             AND (o.account_id <> c.account_id OR o.status IN ('NEW', 'PARTIALLY_FILLED')))
  OR EXISTS (SELECT 1 FROM reservations r WHERE r.proposal_id = c.proposal_id
             AND r.state IN ('HELD', 'ARMED'))
)`;

/**
 * Authority remains blocked until external effects are reconciled (prd.md
 * 11.6/11.8). A terminal order alone is insufficient: fills, fees, and holds
 * may still need settlement. The reconciler must record reconciled_at in the
 * same transaction that finishes accounting and releases remaining holds.
 * Missing/open orders or outstanding holds override even a recorded marker.
 */
export async function countOutstandingCommands(
  client: PoolClient,
  accountId: string,
): Promise<OutstandingCommandCounts> {
  const result = await client.query<Omit<OutstandingCommandCounts, "total">>(
    `SELECT
       count(*) FILTER (WHERE c.state = 'ARMED')::int AS armed,
       count(*) FILTER (WHERE c.state = 'OUTCOME_UNKNOWN')::int AS unknown,
       count(*) FILTER (WHERE ${ACCEPTED_UNRECONCILED})::int AS accepted_unreconciled
     FROM commands c WHERE c.account_id = $1`,
    [accountId],
  );
  const counts = result.rows[0];
  if (counts === undefined) throw new Error("outstanding command count returned no row");
  return { ...counts, total: counts.armed + counts.unknown + counts.accepted_unreconciled };
}

/** The exact commands that block readiness, for stop acknowledgements and operator resume. */
export async function listOutstandingCommands(client: PoolClient, accountId: string): Promise<CommandRow[]> {
  const result = await client.query<CommandRow>(
    `SELECT c.* FROM commands c
      WHERE c.account_id = $1 AND (c.state IN ('ARMED', 'OUTCOME_UNKNOWN') OR (${ACCEPTED_UNRECONCILED}))
      ORDER BY c.created_at, c.id`,
    [accountId],
  );
  return result.rows;
}
