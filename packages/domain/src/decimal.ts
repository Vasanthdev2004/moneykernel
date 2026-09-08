import { canonicalizeDecimal, type DecimalString } from "@moneykernel/contracts";
import { Decimal } from "decimal.js";

/**
 * Deterministic decimal arithmetic for the domain (prd.md 9.6, 9.8, 9.10).
 *
 * Every value enters through `dec` (strict canonical decimal strings) and
 * leaves through `toDecimalString` (canonical, never exponent notation, never
 * silently rounded). JavaScript numbers never touch a quantity, price, fee,
 * or balance. A private decimal.js clone keeps configuration local:
 * 80 significant digits so products of two NUMERIC(38,18) values stay exact,
 * ROUND_DOWN by default so nothing is ever rounded in the agent's favour.
 */
const DecimalCtor = Decimal.clone({
  precision: 80,
  rounding: Decimal.ROUND_DOWN,
  toExpNeg: -100,
  toExpPos: 100,
});

export type Dec = Decimal;
export type Side = "BUY" | "SELL";
export type Rounding = "DOWN" | "UP" | "HALF_EVEN" | "FLOOR" | "CEIL";

const ROUNDING_MODES: Record<Rounding, Decimal.Rounding> = {
  DOWN: Decimal.ROUND_DOWN,
  UP: Decimal.ROUND_UP,
  HALF_EVEN: Decimal.ROUND_HALF_EVEN,
  FLOOR: Decimal.ROUND_FLOOR,
  CEIL: Decimal.ROUND_CEIL,
};

export const MAX_FRACTION_DIGITS = 18;

/** Parses a canonical-izable decimal string strictly, or normalizes an existing Dec into this clone. */
export function dec(value: string | Dec): Dec {
  if (typeof value === "string") return new DecimalCtor(canonicalizeDecimal(value));
  return new DecimalCtor(value);
}

/** Canonical string form. Throws (never rounds) when the value needs more precision than NUMERIC(38,18) holds. */
export function toDecimalString(value: Dec): DecimalString {
  return canonicalizeDecimal(value.toFixed());
}

export const ZERO: Dec = new DecimalCtor(0);
export const ONE: Dec = new DecimalCtor(1);

export const add = (a: Dec, b: Dec): Dec => a.plus(b);
export const sub = (a: Dec, b: Dec): Dec => a.minus(b);
export const mul = (a: Dec, b: Dec): Dec => a.times(b);
export const neg = (a: Dec): Dec => a.negated();
export const abs = (a: Dec): Dec => a.abs();
export const min = (a: Dec, b: Dec): Dec => (a.lte(b) ? a : b);
export const max = (a: Dec, b: Dec): Dec => (a.gte(b) ? a : b);

export function div(a: Dec, b: Dec, options: { scale?: number; rounding?: Rounding } = {}): Dec {
  if (b.isZero()) throw new RangeError("division by zero");
  const quotient = a.dividedBy(b);
  if (options.scale === undefined) return quotient;
  return quotient.toDecimalPlaces(options.scale, ROUNDING_MODES[options.rounding ?? "DOWN"]);
}

export const eq = (a: Dec, b: Dec): boolean => a.eq(b);
export const lt = (a: Dec, b: Dec): boolean => a.lt(b);
export const lte = (a: Dec, b: Dec): boolean => a.lte(b);
export const gt = (a: Dec, b: Dec): boolean => a.gt(b);
export const gte = (a: Dec, b: Dec): boolean => a.gte(b);
export const isZero = (a: Dec): boolean => a.isZero();
export const isNegative = (a: Dec): boolean => a.isNegative() && !a.isZero();
export const isPositive = (a: Dec): boolean => a.isPositive() && !a.isZero();

export function cmp(a: Dec, b: Dec): -1 | 0 | 1 {
  const c = a.comparedTo(b);
  if (c < 0) return -1;
  if (c > 0) return 1;
  return 0;
}

function assertStep(step: Dec, what: string): void {
  if (!isPositive(step)) throw new RangeError(`${what} must be greater than zero`);
}

/** Integer number of `step` lots that fit in `value` (floor). value >= 0, step > 0. */
export function lotCount(value: Dec, step: Dec): bigint {
  assertStep(step, "step");
  if (isNegative(value)) throw new RangeError("value must not be negative");
  return BigInt(value.dividedToIntegerBy(step).toFixed(0));
}

export function fromLotCount(lots: bigint, step: Dec): Dec {
  assertStep(step, "step");
  if (lots < 0n) throw new RangeError("lot count must not be negative");
  return new DecimalCtor(lots.toString()).times(step);
}

/** Largest non-negative multiple of `step` that is <= value. Rounds down, never up (prd.md 9.10). */
export function floorToStep(value: Dec, step: Dec): Dec {
  return fromLotCount(lotCount(value, step), step);
}

/**
 * Price normalization that never weakens the submitted limit: a BUY limit
 * rounds down to the tick, a SELL limit rounds up. Uses exact integer lot
 * arithmetic, not a rounded division.
 */
export function roundPriceToTick(price: Dec, tick: Dec, side: Side): Dec {
  assertStep(tick, "tick");
  if (!isPositive(price)) throw new RangeError("price must be greater than zero");
  let lots = price.dividedToIntegerBy(tick);
  if (side === "SELL" && lots.times(tick).lt(price)) lots = lots.plus(1);
  const result = lots.times(tick);
  if (result.isZero()) throw new RangeError("price rounds to zero at this tick size");
  return result;
}

/** floor_to_step(notional / price, step), division carried at full clone precision, rounded down. */
export function quantityForNotional(notional: Dec, price: Dec, step: Dec): Dec {
  if (!isPositive(price)) throw new RangeError("price must be greater than zero");
  if (isNegative(notional)) throw new RangeError("notional must not be negative");
  return floorToStep(notional.dividedBy(price), step);
}

/** Exact quantity * price. */
export const notionalOf = (quantity: Dec, price: Dec): Dec => quantity.times(price);

/** Conservative fee envelope: notional * rate rounded UP to 18 places (prd.md 9.8). */
export function feeReserve(notional: Dec, feeRate: Dec): Dec {
  if (isNegative(notional) || isNegative(feeRate)) throw new RangeError("fee inputs must not be negative");
  return notional.times(feeRate).toDecimalPlaces(MAX_FRACTION_DIGITS, Decimal.ROUND_UP);
}

/** |current - reference| / reference * 10000, reference > 0. */
export function bpsDrift(reference: Dec, current: Dec): Dec {
  if (!isPositive(reference)) throw new RangeError("reference price must be greater than zero");
  return current.minus(reference).abs().dividedBy(reference).times(10000);
}

/** numerator / denominator at clone precision, rounded down; denominator > 0. Used for concentration shares. */
export function ratio(numerator: Dec, denominator: Dec): Dec {
  if (!isPositive(denominator)) throw new RangeError("denominator must be greater than zero");
  return numerator.dividedBy(denominator);
}
