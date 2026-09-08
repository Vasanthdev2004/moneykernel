/**
 * Reviewed read operations for this probe only. Empty until actual discovery
 * and review: tool names and server readOnlyHint annotations grant no authority.
 *
 * After reviewing a discovered tool's behavior and schemas, pin its endpoint,
 * exact name, and full definition_hash from `spike:list`. Never auto-populate
 * this list from discovery. Any definition change requires a fresh review.
 */
export const REVIEWED_READ_TOOLS: ReadonlyArray<{
  endpoint: string;
  name: string;
  definition_hash: string;
}> = [];
