import { describe, expect, it } from "vitest";

import { canonicalizeRetailerUrl } from "../../src/normalize/url.js";

describe("canonicalizeRetailerUrl", () => {
  it("resolves relative URLs and removes fragments and known tracking keys", () => {
    expect(
      canonicalizeRetailerUrl(
        "/produto/arroz?utm_source=x#top",
        "https://loja.test",
        ["loja.test"],
      ),
    ).toBe("https://loja.test/produto/arroz");
  });

  it("retains product identity parameters", () => {
    expect(
      canonicalizeRetailerUrl(
        "/produto/arroz?sku=10&utm_medium=email&variant=2&fbclid=ignored",
        "https://loja.test",
        ["loja.test"],
      ),
    ).toBe("https://loja.test/produto/arroz?sku=10&variant=2");
  });

  it("allows exact domains and their subdomains", () => {
    expect(
      canonicalizeRetailerUrl(
        "https://catalogo.loja.test/produto/1",
        "https://loja.test",
        ["loja.test"],
      ),
    ).toBe("https://catalogo.loja.test/produto/1");
  });

  it("normalizes the allowed hostname before returning the canonical URL", () => {
    expect(
      canonicalizeRetailerUrl(
        "https://LOJA.TEST./produto/1?sku=10",
        "https://loja.test",
        ["loja.test"],
      ),
    ).toBe("https://loja.test/produto/1?sku=10");
  });

  it("removes Shopify collection context from product identity URLs", () => {
    expect(
      canonicalizeRetailerUrl(
        "https://loja.test/collections/mercearia/products/arroz-1kg?variant=2",
        "https://loja.test",
        ["loja.test"],
      ),
    ).toBe("https://loja.test/products/arroz-1kg?variant=2");
  });

  it("rejects URLs outside the domain allowlist", () => {
    expect(() =>
      canonicalizeRetailerUrl(
        "https://evil.test/x",
        "https://loja.test",
        ["loja.test"],
      ),
    ).toThrow(/domain/i);
    expect(() =>
      canonicalizeRetailerUrl(
        "https://evilloja.test/x",
        "https://loja.test",
        ["loja.test"],
      ),
    ).toThrow(/domain/i);
  });

  it("rejects non-HTTP URLs and URLs containing credentials", () => {
    expect(() =>
      canonicalizeRetailerUrl(
        "javascript:alert(1)",
        "https://loja.test",
        ["loja.test"],
      ),
    ).toThrow(/protocol/i);
    expect(() =>
      canonicalizeRetailerUrl(
        "https://user:secret@loja.test/produto/1",
        "https://loja.test",
        ["loja.test"],
      ),
    ).toThrow(/credentials/i);
  });
});
