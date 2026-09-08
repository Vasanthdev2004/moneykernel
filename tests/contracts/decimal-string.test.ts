import {
  canonicalizeDecimal,
  DecimalFormatError,
  DecimalStringSchema,
  hashCanonical,
  isDecimalString,
  NonNegativeDecimalStringSchema,
  PositiveDecimalStringSchema,
} from "@moneykernel/contracts";
import { describe, expect, it } from "vitest";

describe("canonicalizeDecimal (prd.md 9.6)", () => {
  it.each([
    ["1.0", "1"],
    ["1.00", "1"],
    ["01.50", "1.5"],
    ["000", "0"],
    ["0.000", "0"],
    ["-0", "0"],
    ["-0.00", "0"],
    ["-1.50", "-1.5"],
    ["100", "100"],
    ["0.27", "0.27"],
    ["27.027", "27.027"],
    ["0.000000000000000001", "0.000000000000000001"],
    ["12345678901234567890.123456789012345678", "12345678901234567890.123456789012345678"],
  ])("canonicalizes %s to %s", (input, expected) => {
    expect(canonicalizeDecimal(input)).toBe(expected);
  });

  it.each([
    "1e5",
    "1E5",
    "NaN",
    "Infinity",
    "-Infinity",
    "+1",
    "--1",
    " 1",
    "1 ",
    "1.",
    ".5",
    "",
    "1,5",
    "0x10",
    "1_000",
    "١٢٣",
    "0.0000000000000000001",
    "123456789012345678901",
  ])("rejects %j", (input) => {
    expect(() => canonicalizeDecimal(input)).toThrow(DecimalFormatError);
  });

  it("rejects non-string input", () => {
    expect(() => canonicalizeDecimal(1 as unknown as string)).toThrow(DecimalFormatError);
  });

  it("isDecimalString accepts only canonical forms", () => {
    expect(isDecimalString("1.5")).toBe(true);
    expect(isDecimalString("1.50")).toBe(false);
    expect(isDecimalString("01")).toBe(false);
    expect(isDecimalString(1.5)).toBe(false);
  });

  it("equivalent decimals hash identically after canonicalization", () => {
    const a = hashCanonical({ amount: canonicalizeDecimal("1.0") });
    const b = hashCanonical({ amount: canonicalizeDecimal("1.00") });
    const c = hashCanonical({ amount: canonicalizeDecimal("1.01") });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("decimal string schemas", () => {
  it("DecimalStringSchema canonicalizes and reports format errors", () => {
    expect(DecimalStringSchema.parse("2.50")).toBe("2.5");
    const result = DecimalStringSchema.safeParse("2.5e1");
    expect(result.success).toBe(false);
  });

  it("NonNegativeDecimalStringSchema rejects negatives and accepts zero", () => {
    expect(NonNegativeDecimalStringSchema.parse("0.0")).toBe("0");
    expect(NonNegativeDecimalStringSchema.safeParse("-0.1").success).toBe(false);
  });

  it("PositiveDecimalStringSchema rejects zero and negatives", () => {
    expect(PositiveDecimalStringSchema.parse("0.10")).toBe("0.1");
    expect(PositiveDecimalStringSchema.safeParse("0").success).toBe(false);
    expect(PositiveDecimalStringSchema.safeParse("0.0").success).toBe(false);
    expect(PositiveDecimalStringSchema.safeParse("-5").success).toBe(false);
  });
});
