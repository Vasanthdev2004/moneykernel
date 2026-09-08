import { DecimalFormatError } from "@moneykernel/contracts";
import {
  add,
  bpsDrift,
  cmp,
  dec,
  div,
  eq,
  feeReserve,
  floorToStep,
  fromLotCount,
  isNegative,
  lotCount,
  min,
  mul,
  notionalOf,
  quantityForNotional,
  ratio,
  roundPriceToTick,
  sub,
  toDecimalString,
} from "@moneykernel/domain";
import { describe, expect, it } from "vitest";

const s = (value: string) => toDecimalString(dec(value));

describe("dec / toDecimalString (prd.md 9.6)", () => {
  it.each(["1e5", "NaN", "Infinity", "+5", " 5", "1.", ".5", "", "0x1"])("T-05: rejects %j", (input) => {
    expect(() => dec(input)).toThrow(DecimalFormatError);
  });

  it("accepts negative decimals and reports the sign", () => {
    expect(isNegative(dec("-5"))).toBe(true);
    expect(isNegative(dec("0"))).toBe(false);
    expect(isNegative(dec("-0"))).toBe(false);
  });

  it("round-trips canonically", () => {
    expect(s("1.50")).toBe("1.5");
    expect(s("0.000")).toBe("0");
    expect(s("007.10")).toBe("7.1");
    expect(s("12345678901234567890.123456789012345678")).toBe("12345678901234567890.123456789012345678");
  });

  it("never emits exponent notation for extreme magnitudes", () => {
    expect(s("0.000000000000000001")).toBe("0.000000000000000001");
    expect(s("10000000000000000000")).toBe("10000000000000000000");
  });

  it("throws instead of rounding when a value exceeds 18 fractional digits", () => {
    expect(() => toDecimalString(div(dec("1"), dec("3")))).toThrow(DecimalFormatError);
    expect(toDecimalString(div(dec("1"), dec("3"), { scale: 18 }))).toBe("0.333333333333333333");
    expect(toDecimalString(div(dec("2"), dec("3"), { scale: 2, rounding: "UP" }))).toBe("0.67");
    expect(toDecimalString(div(dec("2"), dec("3"), { scale: 2 }))).toBe("0.66");
  });

  it("division by zero throws", () => {
    expect(() => div(dec("1"), dec("0"))).toThrow(RangeError);
    expect(() => ratio(dec("1"), dec("0"))).toThrow(RangeError);
  });

  it("products of two 18-place values stay exact", () => {
    const a = dec("0.123456789012345678");
    const product = mul(a, a);
    expect(product.toFixed()).toBe("0.015241578753238836527968299765279684");
    expect(product.decimalPlaces()).toBe(36);
    expect(toDecimalString(mul(dec("0.27"), dec("100")))).toBe("27");
  });
});

describe("step and tick normalization (prd.md 9.10, T-04)", () => {
  it.each([
    ["0.27", "0.001", "0.27"],
    ["0.2705", "0.001", "0.27"],
    ["0.00099", "0.001", "0"],
    ["5", "0.5", "5"],
    ["5.49", "0.5", "5"],
    ["123.456789", "0.00001", "123.45678"],
  ])("floorToStep(%s, %s) = %s", (value, step, expected) => {
    expect(toDecimalString(floorToStep(dec(value), dec(step)))).toBe(expected);
  });

  it("lot counts round-trip and reject bad inputs", () => {
    expect(lotCount(dec("0.27"), dec("0.001"))).toBe(270n);
    expect(toDecimalString(fromLotCount(270n, dec("0.001")))).toBe("0.27");
    expect(() => lotCount(dec("1"), dec("0"))).toThrow(RangeError);
    expect(() => lotCount(dec("-1"), dec("0.1"))).toThrow(RangeError);
    expect(() => fromLotCount(-1n, dec("0.1"))).toThrow(RangeError);
  });

  it.each([
    ["100.005", "0.01", "BUY", "100"],
    ["100.005", "0.01", "SELL", "100.01"],
    ["100", "0.01", "BUY", "100"],
    ["100", "0.01", "SELL", "100"],
    ["99999.999", "0.01", "BUY", "99999.99"],
    ["0.019", "0.01", "BUY", "0.01"],
  ])("roundPriceToTick(%s, %s, %s) = %s", (price, tick, side, expected) => {
    expect(toDecimalString(roundPriceToTick(dec(price), dec(tick), side as "BUY" | "SELL"))).toBe(expected);
  });

  it("refuses a BUY price that rounds to zero and non-positive inputs", () => {
    expect(() => roundPriceToTick(dec("0.001"), dec("0.01"), "BUY")).toThrow(RangeError);
    expect(() => roundPriceToTick(dec("0"), dec("0.01"), "SELL")).toThrow(RangeError);
    expect(() => roundPriceToTick(dec("1"), dec("0"), "SELL")).toThrow(RangeError);
  });

  it("quantityForNotional floors to the step", () => {
    expect(toDecimalString(quantityForNotional(dec("27"), dec("100"), dec("0.001")))).toBe("0.27");
    expect(toDecimalString(quantityForNotional(dec("10"), dec("3"), dec("0.001")))).toBe("3.333");
    expect(toDecimalString(quantityForNotional(dec("50"), dec("100000"), dec("0.00001")))).toBe("0.0005");
  });
});

describe("fees, drift, ratios (prd.md 9.8, 9.9)", () => {
  it("feeReserve rounds up, never down", () => {
    expect(toDecimalString(feeReserve(dec("27"), dec("0.001")))).toBe("0.027");
    expect(toDecimalString(feeReserve(dec("0.000000000000000001"), dec("0.5")))).toBe("0.000000000000000001");
    expect(toDecimalString(feeReserve(dec("1"), dec("0")))).toBe("0");
  });

  it("bpsDrift is symmetric in direction", () => {
    expect(toDecimalString(bpsDrift(dec("100"), dec("100.5")))).toBe("50");
    expect(toDecimalString(bpsDrift(dec("100"), dec("99.5")))).toBe("50");
    expect(toDecimalString(bpsDrift(dec("100"), dec("100")))).toBe("0");
    expect(() => bpsDrift(dec("0"), dec("1"))).toThrow(RangeError);
  });

  it("cmp and min agree with the comparison helpers", () => {
    expect(cmp(dec("1"), dec("2"))).toBe(-1);
    expect(cmp(dec("2"), dec("1"))).toBe(1);
    expect(cmp(dec("1.0"), dec("1"))).toBe(0);
    expect(toDecimalString(min(dec("3"), dec("2.5")))).toBe("2.5");
  });
});

describe("Scenario A worked arithmetic (prd.md 27.1)", () => {
  it("reproduces the PRD numbers exactly", () => {
    const equity = dec("1000");
    const reserve = dec("1");
    const maxShare = dec("0.25");
    const existingExposure = dec("222.75");
    const requested = dec("80");
    const orderCap = dec("50");
    const leaseRemaining = dec("40");
    const quoteEnvelope = dec("100");
    const feeRate = dec("0.001");
    const price = dec("100");
    const step = dec("0.001");

    const equityFloor = sub(equity, reserve);
    expect(toDecimalString(equityFloor)).toBe("999");
    const maxExposure = mul(equityFloor, maxShare);
    expect(toDecimalString(maxExposure)).toBe("249.75");
    const headroom = sub(maxExposure, existingExposure);
    expect(toDecimalString(headroom)).toBe("27");

    const feeFactor = add(dec("1"), feeRate);
    const caps = [requested, orderCap, div(leaseRemaining, feeFactor), div(quoteEnvelope, feeFactor), headroom];
    const notionalCap = caps.reduce((acc, value) => min(acc, value));
    expect(toDecimalString(notionalCap)).toBe("27");

    const quantity = quantityForNotional(notionalCap, price, step);
    expect(toDecimalString(quantity)).toBe("0.27");
    const notional = notionalOf(quantity, price);
    expect(toDecimalString(notional)).toBe("27");
    const fee = feeReserve(notional, feeRate);
    expect(toDecimalString(fee)).toBe("0.027");
    expect(toDecimalString(add(notional, fee))).toBe("27.027");

    const projectedShare = ratio(add(existingExposure, notional), equityFloor);
    expect(eq(projectedShare, dec("0.25"))).toBe(true);
  });
});
