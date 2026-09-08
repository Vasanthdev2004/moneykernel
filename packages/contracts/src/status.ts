import { z } from "zod";
import {
  EnvironmentSchema,
  IdSchema,
  IsoTimestampSchema,
  NonNegativeIntSchema,
  ProvenanceSchema,
} from "./primitives.ts";

export const AccountStatusSchema = z.enum(["PAUSED", "READY", "RECONCILING", "ERROR"]);
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

export const IntegrationStateSchema = z.enum(["CONNECTED", "DEGRADED", "NOT_CONNECTED", "NOT_CONFIGURED", "BLOCKED"]);

export const IntegrationStatusSchema = z.strictObject({
  state: IntegrationStateSchema,
  detail: z.string(),
  last_successful_read_at: IsoTimestampSchema.nullable(),
});

export const ReadinessSchema = z.strictObject({
  ready: z.boolean(),
  checks: z.array(
    z.strictObject({
      name: z.string(),
      ok: z.boolean(),
      detail: z.string(),
    }),
  ),
});
export type Readiness = z.infer<typeof ReadinessSchema>;

/** GET /v1/status (prd.md 15.2, FR-11). Always shows mode and provenance truthfully. */
export const StatusResponseSchema = z.strictObject({
  service: z.literal("moneykernel"),
  engine_version: z.string(),
  server_time: IsoTimestampSchema,
  mode: EnvironmentSchema,
  account: z.strictObject({
    id: IdSchema,
    alias: z.string(),
    environment: EnvironmentSchema,
    status: AccountStatusSchema,
    epoch: NonNegativeIntSchema,
    quote_asset: z.string(),
  }),
  in_flight_commands: NonNegativeIntSchema,
  unresolved_commands: NonNegativeIntSchema,
  provenance: ProvenanceSchema,
  integration: z.strictObject({
    agent_os_mcp: IntegrationStatusSchema,
    market_data: IntegrationStatusSchema,
    execution: IntegrationStatusSchema,
    model: IntegrationStatusSchema,
  }),
  readiness: ReadinessSchema,
});
export type StatusResponse = z.infer<typeof StatusResponseSchema>;

export const HealthLiveSchema = z.strictObject({ status: z.literal("alive"), server_time: IsoTimestampSchema });
