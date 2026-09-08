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

export function modelSourceFor(config: KernelConfig): ModelSource {
  return config.modelProvider === "disabled" ? "DISABLED" : "LIVE_PROVIDER";
}

/** Truthful provenance block attached to every decision and status response (FR-11). */
export function provenanceFor(config: KernelConfig): Provenance {
  return {
    execution_mode: config.environment,
    market_source: marketSourceFor(config),
    model_source: modelSourceFor(config),
    execution_source: executionSourceFor(config),
  };
}
