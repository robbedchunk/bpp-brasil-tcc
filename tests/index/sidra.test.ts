import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { fetchOfficialSeries, parseOfficialSeries } from "../../src/index/sidra.js";

const fixtureUrl = new URL("../fixtures/sidra/table-7060.json", import.meta.url);
const duplicateFixtureUrl = new URL(
  "../fixtures/sidra/table-7060-duplicate-month.json",
  import.meta.url,
);

describe("official SIDRA table 7060", () => {
  it("validates identity and preserves exact requested monthly values", async () => {
    const body = await readFile(fixtureUrl);
    const result = parseOfficialSeries(body, "2026-05", "2026-06");
    expect(result.points).toEqual([
      expect.objectContaining({ month: "2026-05", variationPct: "1.67", areaCode: "3501" }),
      expect.objectContaining({ month: "2026-06", variationPct: "-0.05", categoryId: "7171" }),
    ]);
    expect(result.responseSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it.each([
    ["variable", (value: any) => { value[0].id = "69"; }],
    ["unit", (value: any) => { value[0].unidade = "index"; }],
    ["category", (value: any) => { value[0].resultados[0].classificacoes[0].categoria = { "7170": "wrong" }; }],
    ["area", (value: any) => { value[0].resultados[0].series[0].localidade.id = "35"; }],
  ])("rejects wrong %s metadata", async (_name, mutate) => {
    const value = JSON.parse(await readFile(fixtureUrl, "utf8"));
    mutate(value);
    expect(() => parseOfficialSeries(Buffer.from(JSON.stringify(value)), "2026-05", "2026-06"))
      .toThrow();
  });

  it("records official special values as missing rather than zero", async () => {
    const value = JSON.parse(await readFile(fixtureUrl, "utf8"));
    value[0].resultados[0].series[0].serie["202605"] = "...";
    const result = parseOfficialSeries(
      Buffer.from(JSON.stringify(value)),
      "2026-05",
      "2026-06",
    );
    expect(result.points.map((point) => point.month)).toEqual(["2026-06"]);
    expect(result.missingMonths).toEqual([{ month: "2026-05", sourceValue: "..." }]);
  });

  it("rejects duplicate raw serie month keys before JSON parsing can collapse them", async () => {
    const body = await readFile(duplicateFixtureUrl);

    expect(() => parseOfficialSeries(body, "2026-05", "2026-06"))
      .toThrow(/duplicate.*2026-05/i);
  });

  it("uses bounded, no-redirect official requests", async () => {
    const body = await readFile(fixtureUrl);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const result = await fetchOfficialSeries(async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }, "2026-04", "2026-06");

    expect(result.points).toHaveLength(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("servicodados.ibge.gov.br/api/v3/agregados/7060");
    expect(calls[0]?.init).toMatchObject({ method: "GET", redirect: "error" });
  });

  it("rejects an oversized body", async () => {
    await expect(fetchOfficialSeries(async () => new Response("x".repeat(2 * 1024 * 1024 + 1), {
      status: 200,
      headers: { "content-type": "application/json" },
    }), "2026-04", "2026-06")).rejects.toThrow(/large|size|bytes/i);
  });

  it.each(["application/jsonp", "text/application/json"])(
    "rejects the inexact JSON media type %s",
    async (contentType) => {
      const body = await readFile(fixtureUrl);
      await expect(fetchOfficialSeries(async () => new Response(body, {
        status: 200,
        headers: { "content-type": contentType },
      }), "2026-04", "2026-06")).rejects.toThrow(/content type|JSON/i);
    },
  );

  it("accepts application/json with media-type parameters", async () => {
    const body = await readFile(fixtureUrl);
    await expect(fetchOfficialSeries(async () => new Response(body, {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    }), "2026-04", "2026-06")).resolves.toMatchObject({ status: "available" });
  });
});
