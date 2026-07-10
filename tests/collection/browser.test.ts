import { describe, expect, it, vi } from "vitest";

import { withRestrictedPage } from "../../src/collection/browser.js";

describe("withRestrictedPage", () => {
  it("closes an isolated context when page setup fails", async () => {
    const closeContext = vi.fn(async () => undefined);
    const closeBrowser = vi.fn(async () => undefined);
    const browser = {
      newContext: vi.fn(async () => ({
        newPage: vi.fn(async () => {
          throw new Error("page setup failed");
        }),
        close: closeContext,
      })),
      close: closeBrowser,
    };

    await expect(withRestrictedPage(
      ["shop.test"],
      { browser: browser as never },
      async () => "unreachable",
    )).rejects.toThrow("page setup failed");

    expect(closeContext).toHaveBeenCalledOnce();
    expect(closeBrowser).not.toHaveBeenCalled();
  });

  it("closes an isolated context when execution fails after setup", async () => {
    const closeContext = vi.fn(async () => undefined);
    const page = {
      setDefaultTimeout: vi.fn(),
      on: vi.fn(),
      mainFrame: vi.fn(),
    };
    const browserContext = {
      newPage: vi.fn(async () => page),
      routeWebSocket: vi.fn(async () => undefined),
      route: vi.fn(async () => undefined),
      close: closeContext,
    };
    const browser = {
      newContext: vi.fn(async () => browserContext),
      close: vi.fn(async () => undefined),
    };

    await expect(withRestrictedPage(
      ["shop.test"],
      { browser: browser as never },
      async () => {
        throw new Error("execution failed");
      },
    )).rejects.toThrow("execution failed");

    expect(closeContext).toHaveBeenCalledOnce();
    expect(browser.close).not.toHaveBeenCalled();
  });
});
