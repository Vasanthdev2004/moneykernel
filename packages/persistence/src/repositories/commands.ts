import type { PoolClient } from "pg";

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

/** Counts per command state for one account; ARMED and OUTCOME_UNKNOWN block readiness (prd.md 19.5). */
export async function countCommandsByState(client: PoolClient, accountId: string): Promise<CommandStateCounts> {
  const result = await client.query<{ state: CommandState; n: number }>(
    "SELECT state, count(*)::int AS n FROM commands WHERE account_id = $1 GROUP BY state",
    [accountId],
  );
  const counts: CommandStateCounts = { ...EMPTY_COUNTS };
  for (const row of result.rows) counts[row.state] = row.n;
  return counts;
}
