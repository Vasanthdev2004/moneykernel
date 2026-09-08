import { randomBytes } from "node:crypto";

/** Application-generated identifiers: prefix plus 16 hex characters, matching the contracts IdSchema. */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}
