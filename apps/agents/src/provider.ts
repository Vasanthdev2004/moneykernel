import {
  AssetSchema,
  DECIMAL_INPUT_RE,
  EnvironmentSchema,
  IdSchema,
  IntentSizeSchema,
  MAX_OBSERVATION_REFS,
  MAX_RATIONALE_CHARS,
  MarketSourceSchema,
  type ModelSource,
  NonNegativeIntSchema,
  OrderTypeSchema,
  PositiveDecimalStringSchema,
  SideSchema,
  SymbolSchema,
} from "@moneykernel/contracts";
import { z } from "zod";

/**
 * Strategy provider contract (prd.md 16.2). A provider receives a bounded
 * observation set plus the agent's own permissions and returns NO_ACTION or
 * exactly one proposal. It never sees exchange credentials, operator session
 * data, or other agents' prompts, and nothing it returns is authoritative: the
 * kernel validates and authorizes every intent independently (prd.md 16.3).
 */

/** Decimal text as the kernel emits it. Not canonicalized here so the context hashes exactly as received. */
const DecimalTextSchema = z.string().regex(DECIMAL_INPUT_RE, "expected a decimal string");

const agentShape = { id: IdSchema, name: z.string() };
const accountShape = { environment: EnvironmentSchema, quote_asset: AssetSchema };
const leaseShape = {
  lease_id: IdSchema,
  acquisition_budget_quote: DecimalTextSchema,
  consumed_quote: DecimalTextSchema,
  max_submission_attempts: NonNegativeIntSchema,
  attempts_consumed: NonNegativeIntSchema,
  expires_at: z.string(),
  allowed_symbols: z.array(SymbolSchema),
  allowed_sides: z.array(SideSchema),
  allowed_order_types: z.array(OrderTypeSchema),
};
const holdingShape = { asset: AssetSchema, quantity: DecimalTextSchema };
const bookLevelShape = { price: DecimalTextSchema, quantity: DecimalTextSchema };
const observationShape = {
  snapshot_id: IdSchema,
  symbol: SymbolSchema,
  source: MarketSourceSchema,
  received_at: z.string(),
  source_timestamp: z.string().nullable(),
  last_price: DecimalTextSchema.nullable(),
};

/** The bounded observation set a provider may see. Unknown fields are rejected so prompts never carry extras. */
export const StrategyContextSchema = z.strictObject({
  agent: z.strictObject(agentShape),
  account: z.strictObject(accountShape),
  lease: z.strictObject(leaseShape).nullable(),
  holdings: z.array(z.strictObject(holdingShape)),
  observations: z.array(
    z.strictObject({
      ...observationShape,
      best_bid: z.strictObject(bookLevelShape).nullable(),
      best_ask: z.strictObject(bookLevelShape).nullable(),
    }),
  ),
  server_time: z.string(),
});
export type StrategyContext = z.infer<typeof StrategyContextSchema>;

/**
 * Tolerant reading of the GET /v1/agent/context body: the same leaves, but
 * unknown keys are stripped at every level (payload hashes, provenance,
 * permitted actions, instructions, revisions, ...). Tolerance is deliberate:
 * the kernel may grow its response without breaking runners.
 */
const KernelContextSchema = z.object({
  agent: z.object(agentShape),
  account: z.object(accountShape),
  lease: z.object(leaseShape).nullable(),
  holdings: z.array(z.object(holdingShape)),
  observations: z.array(
    z.object({
      ...observationShape,
      best_bid: z.object(bookLevelShape).nullable(),
      best_ask: z.object(bookLevelShape).nullable(),
    }),
  ),
  server_time: z.string(),
});

export class ContextShapeError extends Error {
  readonly issues: string;
  constructor(issues: string) {
    super(`CONTEXT_SHAPE_INVALID: ${issues}`);
    this.name = "ContextShapeError";
    this.issues = issues;
  }
}

type IssueLike = { path: ReadonlyArray<PropertyKey>; message: string };

/** Compact, single-line rendering of validation issues; used in errors and in the one repair prompt. */
export function formatIssues(error: { issues: ReadonlyArray<IssueLike> }): string {
  return error.issues
    .map((issue) => `${issue.path.length === 0 ? "$" : issue.path.map(String).join(".")}: ${issue.message}`)
    .join("; ");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Builds the strict context from a kernel response. Everything outside the schema is dropped before any prompt sees it. */
export function contextFromKernel(raw: unknown): StrategyContext {
  const tolerant = KernelContextSchema.safeParse(raw);
  if (!tolerant.success) throw new ContextShapeError(formatIssues(tolerant.error));
  return StrategyContextSchema.parse(tolerant.data);
}

const RationaleSchema = z.string().max(MAX_RATIONALE_CHARS);

/** The proposal half of a TradeIntent: the runner adds schema_version and lease_id itself. */
export const ProposalIntentSchema = z
  .strictObject({
    symbol: SymbolSchema,
    side: SideSchema,
    order_type: OrderTypeSchema,
    size: IntentSizeSchema,
    limit_price: PositiveDecimalStringSchema,
    observation_ids: z.array(IdSchema).min(1).max(MAX_OBSERVATION_REFS),
  })
  .superRefine((intent, ctx) => {
    if (intent.side === "BUY" && intent.size.kind !== "QUOTE_NOTIONAL") {
      ctx.addIssue({ code: "custom", path: ["size", "kind"], message: "BUY intents must size by QUOTE_NOTIONAL" });
    }
    if (intent.side === "SELL" && intent.size.kind !== "BASE_QUANTITY") {
      ctx.addIssue({ code: "custom", path: ["size", "kind"], message: "SELL intents must size by BASE_QUANTITY" });
    }
  });
export type ProposalIntent = z.infer<typeof ProposalIntentSchema>;

/** Strict model output: unknown keys (including any "override") are rejected, amounts must be decimal strings. */
export const ProposalOutputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("NO_ACTION"),
    rationale: RationaleSchema,
    observation_ids: z.array(IdSchema),
  }),
  z.strictObject({
    kind: z.literal("PROPOSAL"),
    rationale: RationaleSchema,
    intent: ProposalIntentSchema,
  }),
]);
export type ProposalOutput = z.infer<typeof ProposalOutputSchema>;
/** Wire form (plain decimal strings) accepted by the schema; the parsed form carries canonical decimals. */
export type ProposalOutputInput = z.input<typeof ProposalOutputSchema>;

export type ProviderSource = Exclude<ModelSource, "DISABLED">;
export type OutputValidation = "VALID" | "REPAIRED";
export type TokenUsage = { input_tokens: number | null; output_tokens: number | null };
export const NO_TOKEN_USAGE: TokenUsage = Object.freeze({ input_tokens: null, output_tokens: null });

export type ProviderResult = {
  output: ProposalOutput;
  raw_text: string;
  latency_ms: number;
  repair_attempts: number;
  usage: TokenUsage;
  validation: OutputValidation;
};

export interface StrategyProvider {
  readonly source: ProviderSource;
  readonly modelId: string;
  propose(context: StrategyContext): Promise<ProviderResult>;
}

const FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/i;

/** Returns the first balanced JSON object in the text (preferring a fenced block), or null. */
export function extractJsonObject(text: string): string | null {
  const fenced = FENCE_RE.exec(text);
  const haystack = fenced?.[1] ?? text;
  const start = haystack.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < haystack.length; i += 1) {
    const ch = haystack.charAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return haystack.slice(start, i + 1);
    }
  }
  return null;
}

export type ValidationResult = { ok: true; output: ProposalOutput } | { ok: false; error: string };

/** Strict output validation (prd.md 16.2). The error text is safe to hand back to a model as data. */
export function validateOutput(text: string): ValidationResult {
  const candidate = extractJsonObject(text);
  if (candidate === null) return { ok: false, error: "no JSON object found in the response" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    return { ok: false, error: `malformed JSON: ${errorMessage(error)}` };
  }
  const result = ProposalOutputSchema.safeParse(parsed);
  if (!result.success) return { ok: false, error: `schema violation: ${formatIssues(result.error)}` };
  return { ok: true, output: result.data };
}
