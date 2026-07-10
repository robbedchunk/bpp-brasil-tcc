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
});
