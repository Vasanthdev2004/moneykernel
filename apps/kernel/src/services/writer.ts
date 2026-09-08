import type { KernelRuntime } from "../boot.ts";

/** Check the original writer session without reacquiring or incrementing its advisory lock. */
export async function hasLiveWriterLease(runtime: KernelRuntime): Promise<boolean> {
  const writer = runtime.writer;
  if (writer === null) return false;
  try {
    const result = await writer.client.query<{ owns_lock: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_locks
          WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
            AND classid = ((hashtext($1)::bigint >> 32) & 4294967295)::oid
            AND objid = (hashtext($1)::bigint & 4294967295)::oid AND objsubid = 1
       ) AS owns_lock`,
      [writer.key],
    );
    return runtime.writer === writer && result.rows[0]?.owns_lock === true;
  } catch {
    return false;
  }
}
