import {
  NO_TOKEN_USAGE,
  type ProposalOutput,
  type ProposalOutputInput,
  ProposalOutputSchema,
  type ProviderResult,
  type StrategyProvider,
} from "../provider.ts";

/** Fixed, deterministic output for tests and offline demos. Same validation path as every other provider. */
export class ScriptedProvider implements StrategyProvider {
  readonly source = "SCRIPTED" as const;
  readonly modelId = "scripted";
  readonly #output: ProposalOutput;

  constructor(output: ProposalOutputInput) {
    this.#output = ProposalOutputSchema.parse(output);
  }

  async propose(): Promise<ProviderResult> {
    return {
      output: this.#output,
      raw_text: JSON.stringify(this.#output),
      latency_ms: 0,
      repair_attempts: 0,
      usage: NO_TOKEN_USAGE,
      validation: "VALID",
    };
  }
}

export const SCRIPTED_NO_ACTION: ProposalOutputInput = {
  kind: "NO_ACTION",
  rationale: "scripted default: no proposal configured",
  observation_ids: [],
};
