import { Hex64Schema, hashCanonical } from "@moneykernel/contracts";
import { z } from "zod";
import { readJsonFile } from "../json-file.ts";
import {
  NO_TOKEN_USAGE,
  type ProviderResult,
  type StrategyContext,
  type StrategyProvider,
  validateOutput,
} from "../provider.ts";

/**
 * Written by a supported first-party agent session (for example a Claude Code
 * session) that read one `--context-out` dump and followed the prompt contract.
 * The session never holds the agent token; the runner submits on its behalf.
 */
export const SessionProposalSchema = z.object({
  produced_by: z.string().min(1),
  produced_at: z.string(),
  context_hash: Hex64Schema,
  raw_text: z.string(),
});
export type SessionProposal = z.infer<typeof SessionProposalSchema>;

const short = (hash: string): string => hash.slice(0, 12);

export class AgentSessionProvider implements StrategyProvider {
  readonly source = "SUPPORTED_AGENT_SESSION" as const;
  readonly modelId: string;
  readonly producedAt: string;
  readonly contextHash: string;
  readonly proposalPath: string;
  readonly #rawText: string;

  constructor(options: { proposalPath: string }) {
    const proposal = readJsonFile(options.proposalPath, SessionProposalSchema, "PROPOSAL_FILE_INVALID");
    this.proposalPath = options.proposalPath;
    this.modelId = proposal.produced_by;
    this.producedAt = proposal.produced_at;
    this.contextHash = proposal.context_hash;
    this.#rawText = proposal.raw_text;
  }

  /** A proposal written against any other context is refused: stale observations must never be submitted. */
  async propose(context: StrategyContext): Promise<ProviderResult> {
    const current = hashCanonical(context);
    if (current !== this.contextHash) {
      throw new Error(
        `STALE_CONTEXT: ${this.proposalPath} was produced for context ${short(this.contextHash)} but the kernel now serves ${short(current)}; run --context-out again and produce a new proposal`,
      );
    }
    const check = validateOutput(this.#rawText);
    if (!check.ok) throw new Error(`MODEL_OUTPUT_INVALID: ${check.error}`);
    return {
      output: check.output,
      raw_text: this.#rawText,
      latency_ms: 0,
      repair_attempts: 0,
      usage: NO_TOKEN_USAGE,
      validation: "VALID",
    };
  }
}
