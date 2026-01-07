#!/usr/bin/env node
/**
 * MCP Server for Browser Automation
 * Exposes browser tools via the Model Context Protocol (stdio transport)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getClient } from "./browserbase-client.js";

// Initialize browser client
const browserClient = getClient();
let currentTabId = null;

// Create MCP server
const server = new Server(
  {
    name: "browser-automation",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define available tools
const TOOLS = [
  {
    name: "browser_navigate",
    description: "Navigate to a URL in the browser. Creates a new browser session if none exists.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to navigate to",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_screenshot",
    description: "Take a screenshot of the current page. Returns the screenshot as a base64-encoded image.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "browser_click",
    description: "Click at specific coordinates on the page",
    inputSchema: {
      type: "object",
      properties: {
        x: {
          type: "number",
          description: "X coordinate to click",
        },
        y: {
          type: "number",
          description: "Y coordinate to click",
        },
      },
      required: ["x", "y"],
    },
  },
  {
    name: "browser_type",
    description: "Type text at the current cursor position",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Text to type",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "browser_scroll",
    description: "Scroll the page in a direction",
    inputSchema: {
      type: "object",
      properties: {
        direction: {
          type: "string",
          enum: ["up", "down", "left", "right"],
          description: "Direction to scroll",
        },
        amount: {
          type: "number",
          description: "Amount to scroll (1-10, default 3)",
        },
      },
      required: ["direction"],
    },
  },
  {
    name: "browser_get_text",
    description: "Get the text content of the current page",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "browser_find",
    description: "Find elements on the page matching a query and get their coordinates",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Text to search for in elements (searches text, aria-label, placeholder, etc.)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "browser_execute_js",
    description: "Execute JavaScript code on the page and return the result",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "JavaScript code to execute",
        },
      },
      required: ["code"],
    },
  },
  {
    name: "browser_press_key",
    description: "Press a keyboard key (e.g., Enter, Tab, Escape, ArrowDown)",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Key to press (e.g., 'Enter', 'Tab', 'Escape', 'ArrowDown')",
        },
      },
      required: ["key"],
    },
  },
];

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Ensure browser session exists
async function ensureSession() {
  if (!currentTabId || !browserClient.sessions.has(currentTabId)) {
    const [tabId] = await browserClient.createSession();
    currentTabId = tabId;
    console.error(`[MCP] Created browser session: ${tabId}`);
  }
  return currentTabId;
}

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "browser_navigate": {
        const tabId = await ensureSession();
        const message = await browserClient.navigate(tabId, args.url);
        // Wait a bit for page to stabilize
        await new Promise((r) => setTimeout(r, 1000));
        return {
          content: [{ type: "text", text: message }],
        };
      }

      case "browser_screenshot": {
        const tabId = await ensureSession();
        const [data, width, height] = await browserClient.screenshot(tabId);
        return {
          content: [
            {
              type: "text",
              text: `Screenshot captured (${width}x${height}). Use the coordinates shown for clicking.`,
            },
            {
              type: "image",
              data,
              mimeType: "image/jpeg",
            },
          ],
        };
      }

      case "browser_click": {
        const tabId = await ensureSession();
        const message = await browserClient.click(tabId, args.x, args.y);
        await new Promise((r) => setTimeout(r, 500));
        return {
          content: [{ type: "text", text: message }],
        };
      }

      case "browser_type": {
        const tabId = await ensureSession();
        const message = await browserClient.type(tabId, args.text);
        return {
          content: [{ type: "text", text: message }],
        };
      }

      case "browser_scroll": {
        const tabId = await ensureSession();
        const amount = args.amount || 3;
        const message = await browserClient.scroll(tabId, 640, 360, args.direction, amount);
        await new Promise((r) => setTimeout(r, 300));
        return {
          content: [{ type: "text", text: message }],
        };
      }

      case "browser_get_text": {
        const tabId = await ensureSession();
        const text = await browserClient.getPageText(tabId);
        return {
          content: [{ type: "text", text: text.substring(0, 10000) }],
        };
      }

      case "browser_find": {
        const tabId = await ensureSession();
        const page = browserClient._getPage(tabId);

        // Execute find script
        const script = `
          (function() {
            const query = ${JSON.stringify(args.query.toLowerCase())};
            const results = [];
            const allElements = document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"], [role="textbox"], [role="combobox"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [onclick], [tabindex]');

            for (const el of allElements) {
              const text = (el.textContent || '').trim().toLowerCase();
              const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
              const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
              const title = (el.getAttribute('title') || '').toLowerCase();
              const name = (el.getAttribute('name') || '').toLowerCase();
              const id = (el.id || '').toLowerCase();

              if (text.includes(query) || ariaLabel.includes(query) || placeholder.includes(query) ||
                  title.includes(query) || name.includes(query) || id.includes(query)) {
                const rect = el.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                  results.push({
                    tag: el.tagName.toLowerCase(),
                    text: (el.textContent || '').trim().substring(0, 50),
                    ariaLabel: el.getAttribute('aria-label'),
                    x: Math.round(rect.x + rect.width / 2),
                    y: Math.round(rect.y + rect.height / 2),
                  });
                }
              }
              if (results.length >= 20) break;
            }
            return results;
          })()
        `;

        const matches = await page.evaluate(script) || [];

        let resultText = `Found ${matches.length} matches for '${args.query}':\n`;
        for (let i = 0; i < matches.length; i++) {
          const m = matches[i];
          const label = m.ariaLabel || m.text || m.tag;
          resultText += `  ${i + 1}. [${m.tag}] "${label}" - click at (${m.x}, ${m.y})\n`;
        }

        if (matches.length === 0) {
          resultText = `No matches found for '${args.query}'. Try a different search term.`;
        }

        return {
          content: [{ type: "text", text: resultText }],
        };
      }

      case "browser_execute_js": {
        const tabId = await ensureSession();
        const result = await browserClient.executeScript(tabId, args.code);
        const resultText = result === undefined ? "undefined" : JSON.stringify(result, null, 2);
        return {
          content: [{ type: "text", text: `Result: ${resultText}` }],
        };
      }

      case "browser_press_key": {
        const tabId = await ensureSession();
        const message = await browserClient.pressKey(tabId, args.key, []);
        return {
          content: [{ type: "text", text: message }],
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    console.error(`[MCP] Error in ${name}:`, error);
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

// Cleanup on exit
process.on("SIGINT", async () => {
  console.error("[MCP] Shutting down...");
  await browserClient.cleanup();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.error("[MCP] Shutting down...");
  await browserClient.cleanup();
  process.exit(0);
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[MCP] Browser automation server started");
}

main().catch((error) => {
  console.error("[MCP] Fatal error:", error);
  process.exit(1);
});
