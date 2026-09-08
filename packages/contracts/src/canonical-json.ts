import { createHash } from "node:crypto";

/**
 * Deterministic JSON serialization for hashing, idempotency, and receipts.
 *
 * Compatible with RFC 8785 (JSON Canonicalization Scheme) for the value space
 * MoneyKernel allows: strings, booleans, null, safe integers, arrays, and plain
 * objects with keys sorted by UTF-16 code units. Non-integer numbers are
 * rejected on purpose: financial values must travel as decimal strings
 * (prd.md 9.6), so a float in a canonical payload is always a bug.
 */
export class CanonicalJsonError extends Error {
  readonly path: string;
  constructor(message: string, path: string) {
    super(`${message} at ${path}`);
    this.name = "CanonicalJsonError";
    this.path = path;
  }
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function formatPath(path: ReadonlyArray<string | number>): string {
  return path.length === 0 ? "$" : `$${path.map((p) => (typeof p === "number" ? `[${p}]` : `.${p}`)).join("")}`;
}

function serialize(value: unknown, path: Array<string | number>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalJsonError("non-finite number", formatPath(path));
      if (!Number.isSafeInteger(value)) {
        throw new CanonicalJsonError(
          "non-integer or unsafe number; financial values must be decimal strings",
          formatPath(path),
        );
      }
      return Object.is(value, -0) ? "0" : String(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item, index) => serialize(item, [...path, index])).join(",")}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalJsonError("non-plain object (Date, Map, class instance, ...)", formatPath(path));
      }
      const record = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(record).sort()) {
        const item = record[key];
        if (item === undefined) continue; // absent and undefined are the same thing, like JSON.stringify
        parts.push(`${JSON.stringify(key)}:${serialize(item, [...path, key])}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new CanonicalJsonError(`unsupported value type ${typeof value}`, formatPath(path));
  }
}

export function canonicalJson(value: unknown): string {
  return serialize(value, []);
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** sha256 of the canonical JSON form. Used for payload hashes, proposal hashes, and fingerprints. */
export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export const HEX64_RE = /^[0-9a-f]{64}$/;
