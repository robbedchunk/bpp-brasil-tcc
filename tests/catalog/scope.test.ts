import { describe, expect, it } from "vitest";

import { decideFoodAtHomeScope } from "../../src/catalog/scope.js";

describe("food-at-home catalog scope", () => {
  it.each([
    [
      "7030839",
      "https://carrefourbrfood.vtexcommercestable.com.br/filtro-permanente-para-cafe-102-pequeno-cicley-5601169/p",
    ],
    [
      "7030838",
      "https://carrefourbrfood.vtexcommercestable.com.br/filtro-permanente-para-cafe-103-grande-cicley-5601142/p",
    ],
  ])("excludes Carrefour kitchen filters even when product %s contains cafe", (
    externalId,
    canonicalUrl,
  ) => {
    const decision = decideFoodAtHomeScope({
      canonicalUrl,
      externalId,
      sourceCategory: "/Utilidades Domésticas/Cozinha/Coador/",
    });

    expect(decision).toMatchObject({
      inScope: false,
      reason: "excluded_category",
      evidence: {
        includedTerms: expect.arrayContaining(["cafe"]),
        excludedTerms: expect.arrayContaining(["utilidade", "cozinha", "coador"]),
      },
    });
  });

  it("gives an explicit non-food source category precedence over a food-looking URL", () => {
    expect(decideFoodAtHomeScope({
      canonicalUrl: "https://shop.test/cafe-premium-kit",
      externalId: "kit",
      sourceCategory: "/Dermocosméticos/Beleza/",
    })).toMatchObject({
      inScope: false,
      reason: "excluded_category",
      evidence: {
        excludedTerms: expect.arrayContaining(["dermocosmetico", "beleza"]),
      },
    });
  });

  it.each([
    "/Mercearia/Arroz e feijão/",
    "/Bebidas/Sucos/",
    "/Adega/Vinhos/",
  ])("includes food-at-home category evidence: %s", (sourceCategory) => {
    expect(decideFoodAtHomeScope({
      canonicalUrl: "https://shop.test/produto-sem-categoria-no-slug/p",
      externalId: "food",
      sourceCategory,
    })).toMatchObject({ inScope: true, reason: "included_category" });
  });

  it("fails closed when supplied category evidence is unknown", () => {
    expect(decideFoodAtHomeScope({
      canonicalUrl: "https://shop.test/cafe-torrado/p",
      externalId: "unknown",
      sourceCategory: "/Novidades/",
    })).toMatchObject({ inScope: false, reason: "missing_category_evidence" });
  });

  it("does not treat a food syllable inside an unrelated category as evidence", () => {
    expect(decideFoodAtHomeScope({
      canonicalUrl: "https://shop.test/produto-sem-categoria/p",
      externalId: "keys",
      sourceCategory: "/Chaveiros e Chaves/",
    })).toMatchObject({ inScope: false, reason: "missing_category_evidence" });
    expect(decideFoodAtHomeScope({
      canonicalUrl: "https://shop.test/produto/p",
      externalId: "poultry",
      sourceCategory: "/Açougue/Aves/",
    })).toMatchObject({ inScope: true, reason: "included_category" });
  });

  it("uses a category-retaining URL only when source category is absent", () => {
    expect(decideFoodAtHomeScope({
      canonicalUrl: "https://shop.test/mercearia/arroz/arroz-tipo-1/p",
      externalId: "rice",
      sourceCategory: null,
    })).toMatchObject({ inScope: true, reason: "included_category" });
  });
});
