import { z } from "zod";

/** HTTP error semantics (prd.md 15.7). Product decisions (denials) are not errors; they are recorded outcomes. */
export const ERROR_STATUS = {
  INVALID_JSON: 400,
  INVALID_SHAPE: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  IDEMPOTENCY_KEY_REUSED: 409,
  STALE_VERSION: 409,
  APPROVAL_CONSUMED: 409,
  STATE_CONFLICT: 409,
  INVALID_FINANCIAL_VALUE: 422,
  RATE_LIMITED: 429,
  NOT_READY: 503,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;
export const ErrorCodeSchema = z.enum(Object.keys(ERROR_STATUS) as [ErrorCode, ...ErrorCode[]]);

export const ErrorEnvelopeSchema = z.strictObject({
  error: z.strictObject({
    code: ErrorCodeSchema,
    message: z.string(),
    request_id: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

export function errorEnvelope(code: ErrorCode, message: string, requestId: string, details?: unknown): ErrorEnvelope {
  return details === undefined
    ? { error: { code, message, request_id: requestId } }
    : { error: { code, message, request_id: requestId, details } };
}
