import { DEFAULT_POLICY, PolicySchema } from "@moneykernel/contracts";
import { describe, expect, it } from "vitest";

describe("policy concentration ratio", () => {
  it.each(["0.000000000000000001", "0.999999999999999999", "1", "1.00"])(
    "accepts the exact positive ratio %s at or below one",
    (maxSymbolShare) => {
      expect(PolicySchema.safeParse({ ...DEFAULT_POLICY, max_symbol_share: maxSymbolShare }).success).toBe(true);
    },
  );

  it.each(["0", "-0.1", "1.000000000000000001", "1.00000000000000001", "2"])(
    "rejects the out-of-range ratio %s without floating-point rounding",
    (maxSymbolShare) => {
      expect(PolicySchema.safeParse({ ...DEFAULT_POLICY, max_symbol_share: maxSymbolShare }).success).toBe(false);
    },
  );
});
