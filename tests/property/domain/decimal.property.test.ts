import { canonicalizeDecimal } from "@moneykernel/contracts";
import {
  add,
  cmp,
  dec,
  eq,
  floorToStep,
  fromLotCount,
  gt,
  isPositive,
  lotCount,
  lt,
  lte,
  notionalOf,
  quantityForNotional,
  roundPriceToTick,
  sub,
  toDecimalString,
} from "@moneykernel/domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

// Decimal strings are built from digits, never from floats.
const digits = (minLength: number, maxLength: number) =>
  fc.array(fc.constantFrom(..."0123456789"), { minLength, maxLength }).map((chars) => chars.join(""));

const decimalString = fc
  .tuple(digits(1, 12), fc.option(digits(1, 8), { nil: undefined }))
  .map(([integer, fraction]) => (fraction === undefined ? integer : `${integer}.${fraction}`));

const positiveDecimalString = decimalString.filter((value) => canonicalizeDecimal(value) !== "0");

const stepString = fc.constantFrom("1", "0.5", "0.25", "0.1", "0.01", "0.002", "0.001", "0.0001", "0.00001");

const runs = { numRuns: 400 };

describe("decimal properties (prd.md 9.6, 9.10)", () => {
  it("toDecimalString(dec(s)) equals the contracts canonical form", () => {
    fc.assert(
      fc.property(decimalString, (value) => {
        expect(toDecimalString(dec(value))).toBe(canonicalizeDecimal(value));
      }),
      runs,
    );
  });

  it("output never uses exponent notation or a plus sign", () => {
    fc.assert(
      fc.property(decimalString, decimalString, (a, b) => {
        const text = toDecimalString(add(dec(a), dec(b)));
        expect(text).not.toMatch(/[eE+]/);
      }),
      runs,
    );
  });

  it("floorToStep never rounds up, stays within one step, and is an exact multiple", () => {
    fc.assert(
      fc.property(decimalString, stepString, (value, stepText) => {
        const v = dec(value);
        const step = dec(stepText);
        const floored = floorToStep(v, step);
        expect(lte(floored, v)).toBe(true);
        expect(lt(sub(v, floored), step)).toBe(true);
        expect(eq(fromLotCount(lotCount(floored, step), step), floored)).toBe(true);
      }),
      runs,
    );
  });

  it("add and sub are inverses", () => {
    fc.assert(
      fc.property(decimalString, decimalString, (a, b) => {
        const x = dec(a);
        const y = dec(b);
        expect(eq(sub(add(x, y), y), x)).toBe(true);
      }),
      runs,
    );
  });

  it("quantityForNotional never commits more than the requested notional", () => {
    fc.assert(
      fc.property(positiveDecimalString, positiveDecimalString, stepString, (notional, price, stepText) => {
        const n = dec(notional);
        const p = dec(price);
        const q = quantityForNotional(n, p, dec(stepText));
        expect(lte(notionalOf(q, p), n)).toBe(true);
      }),
      runs,
    );
  });

  it("BUY tick rounding <= price <= SELL tick rounding", () => {
    fc.assert(
      fc.property(positiveDecimalString, stepString, (price, tickText) => {
        const p = dec(price);
        const tick = dec(tickText);
        fc.pre(!lt(p, tick));
        const buy = roundPriceToTick(p, tick, "BUY");
        const sell = roundPriceToTick(p, tick, "SELL");
        expect(lte(buy, p)).toBe(true);
        expect(lte(p, sell)).toBe(true);
        expect(isPositive(buy)).toBe(true);
        expect(lt(sub(sell, buy), add(tick, tick))).toBe(true);
      }),
      runs,
    );
  });

  it("cmp is antisymmetric and consistent with lt, gt, eq", () => {
    fc.assert(
      fc.property(decimalString, decimalString, (a, b) => {
        const x = dec(a);
        const y = dec(b);
        const c = cmp(x, y);
        expect(cmp(y, x)).toBe(-c as -1 | 0 | 1);
        expect(lt(x, y)).toBe(c === -1);
        expect(gt(x, y)).toBe(c === 1);
        expect(eq(x, y)).toBe(c === 0);
      }),
      runs,
    );
  });
});
