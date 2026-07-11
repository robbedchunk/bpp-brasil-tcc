import type { ProductRef } from "../strategies/types.js";

export const MIN_FOOD_CATALOG_PRODUCTS = 1_500;
export const MAX_FOOD_CATALOG_PRODUCTS = 3_000;
export const FOOD_AT_HOME_SCOPE_RULE_VERSION = "food-at-home-category-v1";

const INCLUDED_CATEGORY_TERMS = [
  "acougue",
  "adega",
  "alimento",
  "arroz",
  "ave",
  "bebida",
  "biscoito",
  "cafe",
  "carne",
  "cereal",
  "cerveja",
  "cha",
  "confeitaria",
  "congelado",
  "doce",
  "farinha",
  "feijao",
  "food",
  "frios",
  "fruta",
  "grao",
  "hortifruti",
  "laticinio",
  "legume",
  "massa",
  "mercearia",
  "molho",
  "oleo",
  "ovo",
  "padaria",
  "peixaria",
  "peixe",
  "prato-pronto",
  "queijo",
  "rotisserie",
  "sorvete",
  "sushi",
  "tempero",
  "verdura",
  "vinho",
] as const;

const EXCLUDED_CATEGORY_TERMS = [
  "automotivo",
  "bazar",
  "beleza",
  "brinquedo",
  "casa-e-cozinha",
  "coador",
  "cosmetico",
  "cozinha",
  "dermocosmetico",
  "eletro",
  "farmacia",
  "floricultura",
  "higiene",
  "jardim",
  "lavanderia",
  "limpeza",
  "papelaria",
  "perfumaria",
  "pet",
  "roupa",
  "tabacaria",
  "utilidade",
  "utilidade-domestica",
  "utensilio",
] as const;

function normalized(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function singularToken(token: string): string {
  if (token.length <= 3) return token;
  if (token.endsWith("ais")) return `${token.slice(0, -3)}al`;
  if (token.endsWith("eis")) return `${token.slice(0, -3)}el`;
  if (token.endsWith("ois")) return `${token.slice(0, -3)}ol`;
  if (token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function matchingTerms(text: string, terms: readonly string[]): string[] {
  const tokens = text.split("-").filter(Boolean).map(singularToken);
  return terms.filter((term) => {
    const expected = term.split("-").filter(Boolean).map(singularToken);
    if (expected.length === 0 || expected.length > tokens.length) return false;
    return tokens.some((_token, start) => expected.every(
      (candidate, offset) => tokens[start + offset] === candidate,
    ));
  });
}

export interface CatalogScopeEvidence {
  sourceCategory: string | null;
  normalizedCategory: string | null;
  normalizedPath: string;
  includedTerms: string[];
  excludedTerms: string[];
}

export interface CatalogScopeDecision {
  inScope: boolean;
  reason: "included_category" | "excluded_category" | "missing_category_evidence";
  ruleVersion: typeof FOOD_AT_HOME_SCOPE_RULE_VERSION;
  evidence: CatalogScopeEvidence;
}

/**
 * Fail-closed, category-first food-at-home scope decision. The product URL path
 * is a secondary category signal for storefronts whose product links retain a
 * category prefix; it is never treated as a substitute for arbitrary page text.
 */
export function decideFoodAtHomeScope(ref: ProductRef): CatalogScopeDecision {
  const category = ref.sourceCategory === null ? null : normalized(ref.sourceCategory);
  let path = "";
  try {
    path = normalized(decodeURIComponent(new URL(ref.canonicalUrl).pathname));
  } catch {
    // Canonicalization normally happens before this layer. Invalid paths carry
    // no positive scope evidence and therefore fail closed.
  }
  const categoryExcludedTerms = category === null
    ? []
    : matchingTerms(category, EXCLUDED_CATEGORY_TERMS);
  const categoryIncludedTerms = category === null
    ? []
    : matchingTerms(category, INCLUDED_CATEGORY_TERMS);
  const pathExcludedTerms = matchingTerms(path, EXCLUDED_CATEGORY_TERMS);
  const pathIncludedTerms = matchingTerms(path, INCLUDED_CATEGORY_TERMS);
  const excludedTerms = [...new Set([
    ...categoryExcludedTerms,
    ...pathExcludedTerms,
  ])];
  const includedTerms = [...new Set([
    ...categoryIncludedTerms,
    ...pathIncludedTerms,
  ])];
  const evidence: CatalogScopeEvidence = {
    sourceCategory: ref.sourceCategory,
    normalizedCategory: category,
    normalizedPath: path,
    includedTerms,
    excludedTerms,
  };
  // A supplied source category is authoritative. In particular, a product
  // name or slug containing a food word (for example a coffee-filter product)
  // must never override an explicitly non-food catalog category.
  const decisionExcludedTerms = category !== null
    ? categoryExcludedTerms
    : pathExcludedTerms;
  const decisionIncludedTerms = category !== null
    ? categoryIncludedTerms
    : pathIncludedTerms;
  if (decisionExcludedTerms.length > 0) {
    return {
      inScope: false,
      reason: "excluded_category",
      ruleVersion: FOOD_AT_HOME_SCOPE_RULE_VERSION,
      evidence,
    };
  }
  if (decisionIncludedTerms.length > 0) {
    return {
      inScope: true,
      reason: "included_category",
      ruleVersion: FOOD_AT_HOME_SCOPE_RULE_VERSION,
      evidence,
    };
  }
  return {
    inScope: false,
    reason: "missing_category_evidence",
    ruleVersion: FOOD_AT_HOME_SCOPE_RULE_VERSION,
    evidence,
  };
}
