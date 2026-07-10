import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { RobotsPolicy } from "../../src/discovery/robots.js";
import { DEFAULT_RESEARCH_USER_AGENT } from "../../src/collection/http.js";

describe("RobotsPolicy", () => {
  it("applies allow/disallow precedence and exposes declared sitemaps", async () => {
    const text = await readFile(
      new URL("../fixtures/generic/robots.txt", import.meta.url),
      "utf8",
    );
    const robots = RobotsPolicy.parse("https://shop.test/robots.txt", text);

    expect(robots.canFetch("https://shop.test/produto/1")).toBe(true);
    expect(robots.canFetch("https://shop.test/private/x")).toBe(false);
    expect(robots.canFetch("https://shop.test/private/public/x")).toBe(true);
    expect(robots.sitemaps).toEqual(["https://shop.test/sitemap.xml"]);
    expect(robots.userAgent).toBe(DEFAULT_RESEARCH_USER_AGENT);
  });

  it("never applies one origin's policy to a different origin", () => {
    const robots = RobotsPolicy.parse(
      "https://shop.test/robots.txt",
      "User-agent: *\nDisallow:\n",
    );

    expect(robots.canFetch("https://evil.test/product/1")).toBe(false);
  });
});
