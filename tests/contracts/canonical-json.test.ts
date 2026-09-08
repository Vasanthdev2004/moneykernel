import { CanonicalJsonError, canonicalJson, hashCanonical, sha256Hex } from "@moneykernel/contracts";
import { describe, expect, it } from "vitest";

describe("canonicalJson", () => {
  it("is independent of key insertion order at every depth", () => {
    const a = { b: 1, a: { z: "x", y: [3, { q: true, p: null }] } };
    const b = { a: { y: [3, { p: null, q: true }], z: "x" }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"y":[3,{"p":null,"q":true}],"z":"x"},"b":1}');
  });

  it("preserves array order", () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it("skips undefined-valued keys exactly like JSON.stringify", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("rejects floats, NaN, Infinity, and unsafe integers", () => {
    expect(() => canonicalJson({ amount: 1.5 })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ amount: Number.NaN })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson([Number.POSITIVE_INFINITY])).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ n: 2 ** 53 })).toThrow(CanonicalJsonError);
  });

  it("reports the path of the offending value", () => {
    expect(() => canonicalJson({ a: [{ price: 0.1 }] })).toThrow("$.a[0].price");
  });

  it("rejects non-plain objects and unsupported types", () => {
    expect(() => canonicalJson({ when: new Date(0) })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ m: new Map() })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ big: 1n })).toThrow(CanonicalJsonError);
  });

  it("serializes negative zero as 0", () => {
    expect(canonicalJson(-0)).toBe("0");
  });

  it("escapes strings exactly like JSON.stringify", () => {
    expect(canonicalJson('a"b\n ')).toBe(JSON.stringify('a"b\n '));
  });
});

describe("hashing", () => {
  it("sha256Hex matches the known digest of an empty string", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("hashCanonical is stable and 64 lowercase hex characters", () => {
    const h = hashCanonical({ x: "1", y: ["a"] });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCanonical({ y: ["a"], x: "1" })).toBe(h);
  });
});
