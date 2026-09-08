import { z } from "zod";

/**
 * Financial numbers cross every API boundary as decimal strings (prd.md 9.6).
 *
 * Accepted wire grammar: optional minus sign, integer digits, optional
 * fractional digits. No plus sign, whitespace, exponent, NaN, Infinity, hex,
 * thousands separators, or bare "." forms. Equivalent decimals canonicalize to
 * one form so "1.0" and "1.00" hash and deduplicate identically.
 */
export const DECIMAL_INPUT_RE = /^-?\d{1,60}(\.\d{1,60})?$/;

/** PostgreSQL column type is NUMERIC(38,18): at most 20 integer digits and 18 fractional digits. */
export const MAX_TOTAL_DIGITS = 38;
export const MAX_FRACTION_DIGITS = 18;
export const MAX_INTEGER_DIGITS = MAX_TOTAL_DIGITS - MAX_FRACTION_DIGITS;

/** A canonical decimal string. Only produced by `canonicalizeDecimal`. */
export type DecimalString = string & { readonly __brand: "DecimalString" };

export class DecimalFormatError extends Error {
  readonly code = "INVALID_FINANCIAL_VALUE";
  readonly input: string;
  constructor(message: string, input: string) {
    super(message);
    this.name = "DecimalFormatError";
    this.input = input;
  }
}

/**
 * Canonical form: no leading zeros in the integer part (except a lone "0"),
 * no trailing zeros in the fraction, no fraction when it would be empty, and
 * zero is always "0" (never "-0", "0.0", or "-0.00").
 */
export function canonicalizeDecimal(input: string): DecimalString {
  if (typeof input !== "string" || !DECIMAL_INPUT_RE.test(input)) {
    throw new DecimalFormatError(
      "decimal string must be -?digits[.digits] with no sign tricks, exponent, whitespace, or symbolic values",
      String(input),
    );
  }
  const negative = input.startsWith("-");
  const body = negative ? input.slice(1) : input;
  const dot = body.indexOf(".");
  const intRaw = dot === -1 ? body : body.slice(0, dot);
  const fracRaw = dot === -1 ? "" : body.slice(dot + 1);
  const int = intRaw.replace(/^0+(?=\d)/, "");
  const frac = fracRaw.replace(/0+$/, "");
  if (frac.length > MAX_FRACTION_DIGITS) {
    throw new DecimalFormatError(`more than ${MAX_FRACTION_DIGITS} fractional digits`, input);
  }
  if (int.length > MAX_INTEGER_DIGITS) {
    throw new DecimalFormatError(`more than ${MAX_INTEGER_DIGITS} integer digits`, input);
  }
  const isZero = int === "0" && frac.length === 0;
  if (isZero) return "0" as DecimalString;
  const magnitude = frac.length > 0 ? `${int}.${frac}` : int;
  return (negative ? `-${magnitude}` : magnitude) as DecimalString;
}

export function isDecimalString(value: unknown): value is DecimalString {
  if (typeof value !== "string") return false;
  try {
    return canonicalizeDecimal(value) === value;
  } catch {
    return false;
  }
}

export const isNegativeDecimal = (value: DecimalString): boolean => value.startsWith("-");
export const isZeroDecimal = (value: DecimalString): boolean => value === "0";
export const isPositiveDecimal = (value: DecimalString): boolean => !isNegativeDecimal(value) && !isZeroDecimal(value);

/** Zod schema: validates the wire grammar and canonicalizes. Output type is the branded DecimalString. */
export const DecimalStringSchema = z
  .string()
  .max(122)
  .transform((value, ctx): DecimalString => {
    try {
      return canonicalizeDecimal(value);
    } catch (error) {
      ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "invalid decimal string" });
      return z.NEVER;
    }
  });

export const NonNegativeDecimalStringSchema = DecimalStringSchema.refine((v) => !isNegativeDecimal(v), {
  message: "must not be negative",
});

export const PositiveDecimalStringSchema = DecimalStringSchema.refine((v) => isPositiveDecimal(v), {
  message: "must be greater than zero",
});
