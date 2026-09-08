import type { ExecutionSource, MarketSource, ModelSource, Provenance } from "@moneykernel/contracts";
import type { KernelConfig } from "../config.ts";

export function marketSourceFor(config: KernelConfig): MarketSource {
  switch (config.environment) {
    case "REPLAY":
      return "SYNTHETIC_FIXTURE";
    case "SHADOW":
      return "BINANCE_PUBLIC_REST";
    case "TESTNET":
      return "BINANCE_TESTNET_REST";
  }
}

export function executionSourceFor(config: KernelConfig): ExecutionSource {
  return config.environment === "TESTNET" ? "BINANCE_TESTNET" : "PAPER";
}

export function modelSourceFor(strategyKind: string): ModelSource {
  // G2 has no verified model-run evidence. Configuration and arbitrary strategy
  // labels cannot establish a live or recorded model call; that arrives in G6.
  return strategyKind === "SCRIPTED" ? "SCRIPTED" : "DISABLED";
}

/** Decision/context provenance follows the registered strategy, not provider configuration (FR-11). */
export function provenanceFor(config: KernelConfig, strategyKind: string): Provenance {
  return {
    execution_mode: config.environment,
    market_source: marketSourceFor(config),
    model_source: modelSourceFor(strategyKind),
    execution_source: executionSourceFor(config),
  };
}
