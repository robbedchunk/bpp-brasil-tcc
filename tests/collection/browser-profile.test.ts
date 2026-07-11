import { describe, expect, it, vi } from "vitest";

const playwright = vi.hoisted(() => ({
  launch: vi.fn(),
}));

vi.mock("playwright", () => ({
  chromium: { launch: playwright.launch },
}));

import { withRestrictedPage } from "../../src/collection/browser.js";
import { DEFAULT_RESEARCH_USER_AGENT } from "../../src/collection/http.js";

describe("academic browser profile", () => {
  it("launches a stable pt-BR São Paulo context with minimal webdriver hardening", async () => {
    const addInitScript = vi.fn(async () => undefined);
    const closeContext = vi.fn(async () => undefined);
    const closeBrowser = vi.fn(async () => undefined);
    const newContext = vi.fn(async () => ({
      addInitScript,
      newPage: vi.fn(async () => {
        throw new Error("profile captured");
      }),
      close: closeContext,
    }));
    playwright.launch.mockResolvedValue({ newContext, close: closeBrowser });

    await expect(withRestrictedPage(
      ["shop.test"],
      {},
      async () => "unreachable",
    )).rejects.toThrow("profile captured");

    expect(playwright.launch).toHaveBeenCalledWith({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    expect(newContext).toHaveBeenCalledWith({
      userAgent: DEFAULT_RESEARCH_USER_AGENT,
      serviceWorkers: "block",
      locale: "pt-BR",
      timezoneId: "America/Sao_Paulo",
      viewport: { width: 1365, height: 768 },
    });
    expect(addInitScript).toHaveBeenCalledOnce();
    expect(addInitScript).toHaveBeenCalledWith({
      content: expect.stringMatching(/navigator[\s\S]*webdriver/iu),
    });
    expect(closeContext).toHaveBeenCalledOnce();
    expect(closeBrowser).toHaveBeenCalledOnce();
  });
});
