import { describe, expect, it } from "vitest";

import { parseBrl } from "../../src/normalize/brl.js";

describe("parseBrl", () => {
  it("parses Brazilian thousands separators and a decimal comma", () => {
    expect(parseBrl("R$ 1.299,90")).toBe(1_299.9);
    expect(parseBrl("R$\u00a01.299.999,09")).toBe(1_299_999.09);
  });

  it("parses one- or two-digit decimal fractions", () => {
    expect(parseBrl(" 12,5 ")).toBe(12.5);
    expect(parseBrl("BRL 12.50")).toBe(12.5);
  });

  it("accepts positive finite numbers without reparsing them", () => {
    expect(parseBrl(1_299.9)).toBe(1_299.9);
  });

  it("rejects unavailable and unsupported inputs", () => {
    expect(parseBrl("indisponível")).toBeNull();
    expect(parseBrl(null)).toBeNull();
    expect(parseBrl({ value: "12,50" })).toBeNull();
  });

  it("rejects non-positive and non-finite values", () => {
    for (const input of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "0,00", "-1,00"]) {
      expect(parseBrl(input)).toBeNull();
    }
  });

  it("rejects ambiguous separator groupings instead of guessing", () => {
    expect(parseBrl("1.299")).toBeNull();
    expect(parseBrl("1,299")).toBeNull();
    expect(parseBrl("12.34,56")).toBeNull();
  });
});
