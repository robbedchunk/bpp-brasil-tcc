import { createServer as createTcpServer, type Server as TcpServer } from "node:net";

import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { executeDom } from "../../src/collection/dom.js";
import { executeRestrictedScript } from "../../src/collection/script.js";
import {
  DomExtractionStrategySchema,
  ScriptStrategySchema,
} from "../../src/strategies/schema.js";
import {
  startLocalHttpServer,
  type LocalHttpServer,
} from "../helpers/local-http-server.js";

const fields = {
  title: [{ selector: ".title" }],
  brand: [{ selector: ".brand" }],
  price: [{ selector: ".price" }],
  promoPrice: [{ selector: ".promo" }],
  unit: [{ selector: ".unit" }],
  availability: [{ selector: ".available", attribute: "data-value" }],
};

const productMarkup = `<h1 class="title">Produto Seguro</h1>
  <span class="brand">Marca</span><span class="price">R$ 10,00</span>
  <span class="promo">R$ 9,00</span><span class="unit">1 kg</span>
  <span class="available" data-value="true"></span>`;

async function startTcp(onConnection: () => void): Promise<{ port: number; close(): Promise<void> }> {
  const server: TcpServer = createTcpServer((socket) => {
    onConnection();
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("TCP port unavailable");
  return {
    port: address.port,
    close: async () => new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    }),
  };
}

describe("browser network boundaries", () => {
  let browser: Browser;
  let allowed: LocalHttpServer;
  let denied: LocalHttpServer;
  let tcp: Awaited<ReturnType<typeof startTcp>>;
  let deniedHits = 0;
  let serviceWorkerHits = 0;
  let webSocketConnections = 0;

  beforeAll(async () => {
    tcp = await startTcp(() => {
      webSocketConnections += 1;
    });
    denied = await startLocalHttpServer((_request, response) => {
      deniedHits += 1;
      response.end("denied");
    });
    const deniedViaDifferentHost = denied.origin.replace("127.0.0.1", "localhost");
    allowed = await startLocalHttpServer((request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      if (request.url === "/redirect") {
        response.writeHead(302, { location: `${deniedViaDifferentHost}/contacted` });
        response.end();
        return;
      }
      if (request.url === "/click") {
        response.end(`<a id="leave" href="${deniedViaDifferentHost}/contacted">leave</a>${productMarkup}`);
        return;
      }
      if (request.url === "/sw.js") {
        serviceWorkerHits += 1;
        response.setHeader("content-type", "text/javascript");
        response.end("self.addEventListener('fetch', () => undefined)");
        return;
      }
      if (request.url === "/service-worker") {
        response.end(`${productMarkup}<div id="status"></div><script>
          document.querySelector('#status').id = 'sw-started';
          navigator.serviceWorker.register('/sw.js').catch(() => undefined);
        </script><script src="/delay.js"></script>`);
        return;
      }
      if (request.url === "/websocket") {
        response.end(`${productMarkup}<div id="ws-status"></div><script>
          document.querySelector('#ws-status').id = 'ws-started';
          const socket = new WebSocket('ws://127.0.0.1:${tcp.port}/socket');
          socket.addEventListener('error', () => undefined);
        </script><script src="/delay.js"></script>`);
        return;
      }
      if (request.url === "/delay.js") {
        response.setHeader("content-type", "text/javascript");
        setTimeout(() => response.end("void 0"), 150);
        return;
      }
      if (request.url === "/large") {
        response.end(`${productMarkup}<div>${"x".repeat(50_000)}</div>`);
        return;
      }
      response.end(productMarkup);
    });
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser.close();
    await allowed.close();
    await denied.close();
    await tcp.close();
  });

  it("prevents initial and click redirects before the denied server is contacted", async () => {
    const dom = DomExtractionStrategySchema.parse({
      schemaVersion: 1,
      purpose: "extraction",
      tier: "dom",
      allowedDomains: ["127.0.0.1"],
      url: "{productUrl}",
      selectors: fields,
    });
    const script = ScriptStrategySchema.parse({
      schemaVersion: 1,
      purpose: "extraction",
      tier: "script",
      allowedDomains: ["127.0.0.1"],
      operations: [
        { op: "goto", url: "{productUrl}" },
        { op: "click", selector: "#leave" },
        { op: "extract", source: "dom", selectors: fields },
      ],
    });
    const ref = {
      canonicalUrl: `${allowed.origin}/redirect`,
      externalId: "1",
      sourceCategory: null,
    };

    await expect(executeDom(dom, ref, { browser })).resolves.toMatchObject({
      ok: false,
      failure: { category: "domain-denied" },
    });
    await expect(executeRestrictedScript(
      script,
      { ...ref, canonicalUrl: `${allowed.origin}/click` },
      { browser },
    )).resolves.toMatchObject({
      ok: false,
      failure: { category: "domain-denied" },
    });
    expect(deniedHits).toBe(0);
  });

  it("blocks service-worker script fetches", async () => {
    const strategy = ScriptStrategySchema.parse({
      schemaVersion: 1,
      purpose: "extraction",
      tier: "script",
      allowedDomains: ["127.0.0.1"],
      operations: [
        { op: "goto", url: "{productUrl}" },
        { op: "waitFor", selector: "#sw-started", state: "attached", timeoutMs: 2_000 },
        { op: "extract", source: "dom", selectors: fields },
      ],
    });

    const result = await executeRestrictedScript(strategy, {
      canonicalUrl: `${allowed.origin}/service-worker`,
      externalId: null,
      sourceCategory: null,
    }, { browser });

    expect(result.ok).toBe(true);
    expect(serviceWorkerHits).toBe(0);
  });

  it("blocks WebSockets before a TCP connection is made", async () => {
    const strategy = ScriptStrategySchema.parse({
      schemaVersion: 1,
      purpose: "extraction",
      tier: "script",
      allowedDomains: ["127.0.0.1"],
      operations: [
        { op: "goto", url: "{productUrl}" },
        { op: "waitFor", selector: "#ws-started", state: "attached", timeoutMs: 2_000 },
        { op: "extract", source: "dom", selectors: fields },
      ],
    });

    const result = await executeRestrictedScript(strategy, {
      canonicalUrl: `${allowed.origin}/websocket`,
      externalId: null,
      sourceCategory: null,
    }, { browser });

    expect(result.ok).toBe(true);
    expect(webSocketConnections).toBe(0);
  });

  it("rejects browser navigation bodies above maxBodyBytes", async () => {
    const strategy = DomExtractionStrategySchema.parse({
      schemaVersion: 1,
      purpose: "extraction",
      tier: "dom",
      allowedDomains: ["127.0.0.1"],
      url: "{productUrl}",
      selectors: fields,
    });

    const result = await executeDom(strategy, {
      canonicalUrl: `${allowed.origin}/large`,
      externalId: null,
      sourceCategory: null,
    }, { browser, maxBodyBytes: 256 });

    expect(result).toMatchObject({
      ok: false,
      failure: { category: "parse" },
    });
  });
});
