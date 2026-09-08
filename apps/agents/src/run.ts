import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashCanonical, sha256Hex, type TradeIntentInput } from "@moneykernel/contracts";
import type { KernelClient, KernelResponse } from "./kernel-client.ts";
import { type AgentRole, PROMPT_VERSION } from "./prompt.ts";
import {
  contextFromKernel,
  errorMessage,
  NO_TOKEN_USAGE,
  type OutputValidation,
  type ProviderResult,
  type ProviderSource,
  type StrategyProvider,
  type TokenUsage,
} from "./provider.ts";

export type RunOptions = {
  client: KernelClient;
  provider: StrategyProvider;
  role: AgentRole;
  clock?: () => Date;
  /** Overrides the deterministic id derived from the context and provider identity. */
  runId?: string;
  dryRun?: boolean;
  /** When set, the trace is also written to `${traceDir}/${produced_at}-${run_id}.json`. */
  traceDir?: string;
  /**
   * Raw kernel context to use instead of fetching one: a supported agent session proposes against a
   * `--context-out` dump, and the submission must reference exactly the observations it was shown. The
   * kernel still judges their freshness (prd.md 13.8); a slow session earns STALE_MARKET_DATA, never an exemption.
   */
  context?: unknown;
};

export type OutputKind = "NO_ACTION" | "PROPOSAL" | "NO_PROPOSAL";

/** One record per run (prd.md 16.4). Never contains the agent token or a provider key. */
export type RunTrace = {
  run_id: string;
  produced_at: string;
  role: AgentRole;
  provider_source: ProviderSource;
  model_id: string;
  prompt_version: string;
  context_hash: string;
  latency_ms: number;
  repair_attempts: number;
  validation: OutputValidation | null;
  usage: TokenUsage;
  rationale: string | null;
  output_kind: OutputKind;
  intent: TradeIntentInput | null;
  kernel: KernelResponse | null;
  dry_run: boolean;
  error?: string;
};

/** Satisfies both the Idempotency-Key grammar (as `run-<id>`) and the IdSchema used for strategy_run_id. */
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{3,63}$/;

/** Same context, same provider identity, same run id: a re-run replays the earlier intent instead of creating another. */
export function deriveRunId(contextHash: string, provider: Pick<StrategyProvider, "source" | "modelId">): string {
  return sha256Hex(`${contextHash}${provider.source}${provider.modelId}`).slice(0, 16);
}

export function idempotencyKeyFor(runId: string): string {
  return `run-${runId}`;
}

export function tracePath(traceDir: string, trace: Pick<RunTrace, "produced_at" | "run_id">): string {
  const compact = trace.produced_at.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return join(traceDir, `${compact}-${trace.run_id}.json`);
}

async function writeTrace(traceDir: string, trace: RunTrace): Promise<void> {
  await mkdir(traceDir, { recursive: true });
  await writeFile(tracePath(traceDir, trace), `${JSON.stringify(trace, null, 2)}\n`, "utf8");
}

type TraceBase = Pick<
  RunTrace,
  "run_id" | "role" | "provider_source" | "model_id" | "prompt_version" | "context_hash" | "dry_run"
>;

function fromResult(result: ProviderResult): Pick<RunTrace, "latency_ms" | "repair_attempts" | "validation" | "usage"> {
  return {
    latency_ms: result.latency_ms,
    repair_attempts: result.repair_attempts,
    validation: result.validation,
    usage: result.usage,
  };
}

/**
 * One bounded strategy cycle: read the agent's own context, ask the provider
 * once, submit at most one intent. Provider failures (timeouts, invalid output
 * after the single repair round, stale sessions) become NO_PROPOSAL traces;
 * nothing is ever fabricated on the model's behalf (prd.md 11.7).
 */
export async function runOnce(options: RunOptions): Promise<RunTrace> {
  const clock = options.clock ?? (() => new Date());
  const { client, provider } = options;

  const context = contextFromKernel(options.context === undefined ? await client.getContext() : options.context);
  const contextHash = hashCanonical(context);
  const runId = options.runId ?? deriveRunId(contextHash, provider);
  if (!RUN_ID_RE.test(runId)) throw new Error(`RUN_ID_INVALID: "${runId}" must match ${RUN_ID_RE}`);

  const base: TraceBase = {
    run_id: runId,
    role: options.role,
    provider_source: provider.source,
    model_id: provider.modelId,
    prompt_version: PROMPT_VERSION,
    context_hash: contextHash,
    dry_run: options.dryRun === true,
  };
  const stamp = (trace: Omit<RunTrace, "produced_at">): RunTrace => ({ produced_at: clock().toISOString(), ...trace });

  let trace: RunTrace;
  if (context.lease === null) {
    trace = stamp({
      ...base,
      latency_ms: 0,
      repair_attempts: 0,
      validation: null,
      usage: NO_TOKEN_USAGE,
      rationale: "no active lease",
      output_kind: "NO_ACTION",
      intent: null,
      kernel: null,
    });
  } else {
    const lease = context.lease;
    const started = performance.now();
    let result: ProviderResult;
    try {
      result = await provider.propose(context);
    } catch (error) {
      trace = stamp({
        ...base,
        latency_ms: Math.round(performance.now() - started),
        repair_attempts: 0,
        validation: null,
        usage: NO_TOKEN_USAGE,
        rationale: null,
        output_kind: "NO_PROPOSAL",
        intent: null,
        kernel: null,
        error: errorMessage(error),
      });
      if (options.traceDir !== undefined) await writeTrace(options.traceDir, trace);
      return trace;
    }

    const { output } = result;
    if (output.kind === "NO_ACTION") {
      trace = stamp({
        ...base,
        ...fromResult(result),
        rationale: output.rationale,
        output_kind: "NO_ACTION",
        intent: null,
        kernel: null,
      });
    } else {
      const intent: TradeIntentInput = {
        schema_version: "1",
        lease_id: lease.lease_id,
        ...output.intent,
        rationale: output.rationale,
        strategy_run_id: runId,
      };
      const proposal = {
        ...base,
        ...fromResult(result),
        rationale: output.rationale,
        output_kind: "PROPOSAL" as const,
        intent,
      };
      if (options.dryRun === true) {
        trace = stamp({ ...proposal, kernel: null });
      } else {
        try {
          trace = stamp({ ...proposal, kernel: await client.submitIntent(idempotencyKeyFor(runId), intent) });
        } catch (error) {
          trace = stamp({ ...proposal, kernel: null, error: `KERNEL_SUBMIT_FAILED: ${errorMessage(error)}` });
        }
      }
    }
  }

  if (options.traceDir !== undefined) await writeTrace(options.traceDir, trace);
  return trace;
}
