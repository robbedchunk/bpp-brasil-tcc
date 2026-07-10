import { describe, expect, it } from "vitest";

import { normalizeUnit } from "../../src/normalize/unit.js";

describe("normalizeUnit", () => {
  it("derives kilograms from grams while preserving the raw label", () => {
    expect(normalizeUnit("Pacote 500 g")).toEqual({
      raw: "Pacote 500 g",
      quantity: 500,
      unit: "g",
      baseQuantity: 0.5,
      baseUnit: "kg",
    });
  });

  it("normalizes decimal-comma kilograms", () => {
    expect(normalizeUnit("Saco 1,5 KG")).toMatchObject({
      quantity: 1.5,
      unit: "kg",
      baseQuantity: 1.5,
      baseUnit: "kg",
    });
  });

  it("derives liters from milliliters", () => {
    expect(normalizeUnit("Garrafa 750ml")).toMatchObject({
      quantity: 750,
      unit: "ml",
      baseQuantity: 0.75,
      baseUnit: "l",
    });
  });

  it("keeps liters in their base unit", () => {
    expect(normalizeUnit("2 L")).toMatchObject({
      quantity: 2,
      unit: "l",
      baseQuantity: 2,
      baseUnit: "l",
    });
  });

  it("returns null derived fields when no single valid measure is present", () => {
    expect(normalizeUnit(null)).toEqual({
      raw: null,
      quantity: null,
      unit: null,
      baseQuantity: null,
      baseUnit: null,
    });
    expect(normalizeUnit("Tamanho família")).toEqual({
      raw: "Tamanho família",
      quantity: null,
      unit: null,
      baseQuantity: null,
      baseUnit: null,
    });
    expect(normalizeUnit("Kit 500 g + 200 g")).toEqual({
      raw: "Kit 500 g + 200 g",
      quantity: null,
      unit: null,
      baseQuantity: null,
      baseUnit: null,
    });
  });

  it("rejects non-positive quantities", () => {
    expect(normalizeUnit("Pacote 0 g")).toMatchObject({
      quantity: null,
      unit: null,
    });
    expect(normalizeUnit("Pacote -5 kg")).toMatchObject({
      quantity: null,
      unit: null,
    });
  });

  it("parses a leading decimal separator without dropping it", () => {
    expect(normalizeUnit(".5 kg")).toMatchObject({
      quantity: 0.5,
      unit: "kg",
      baseQuantity: 0.5,
      baseUnit: "kg",
    });
  });

  it("does not extract a unit prefix followed by a digit", () => {
    expect(normalizeUnit("Pacote 500g2")).toMatchObject({
      quantity: null,
      unit: null,
    });
  });
});
