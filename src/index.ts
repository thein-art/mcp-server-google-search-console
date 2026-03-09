#!/usr/bin/env node
import { createRequire } from "node:module";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTokenProvider, hasWriteScope } from "./auth.js";
import { GscApiClient } from "./api-client.js";
import { SiteResolver } from "./site-resolver.js";
import { registerListSitesTool } from "./tools/list-sites.js";
import { registerSiteDetailsTool } from "./tools/site-details.js";
import { registerSearchAnalyticsTool } from "./tools/search-analytics.js";
import { registerInspectUrlTool } from "./tools/inspect-url.js";
import { registerBatchInspectTool } from "./tools/batch-inspect.js";
import { registerListSitemapsTool } from "./tools/list-sitemaps.js";
import { registerSubmitSitemapTool } from "./tools/submit-sitemap.js";
import { registerDeleteSitemapTool } from "./tools/delete-sitemap.js";
import { registerPerformanceSummaryTool } from "./tools/performance-summary.js";
import { registerPrompts } from "./prompts.js";
import { summarizeSitemap } from "./tools/list-sitemaps.js";
import { siteUrlSchema } from "./util.js";
import type { SiteList, SitemapList } from "./types.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

let mcpServer: McpServer | null = null;

function log(msg: string, level: "info" | "warning" | "error" = "info") {
  console.error(`[gsc-mcp] ${msg}`);
  mcpServer?.sendLoggingMessage({ level, data: msg }).catch(() => {});
}

// Process-level error handlers as safety nets
process.on("unhandledRejection", (reason) => {
  log(`Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`, "error");
});
process.on("uncaughtException", (err) => {
  log(`Uncaught exception: ${err.message}`, "error");
  process.exit(1);
});

async function main() {
  const { provider, label } = await createTokenProvider();
  log(`Authenticated via ${label}`);

  const client = new GscApiClient(provider);
  const resolver = new SiteResolver(client);

  // Completable site_url schema — enables autocomplete in MCP clients
  const completableSiteUrl = completable(siteUrlSchema, async (value) => {
    const urls = await resolver.listSiteUrls();
    return urls.filter((u) => u.toLowerCase().includes(value.toLowerCase()));
  });

  const server = new McpServer(
    { name: "google-search-console", version },
    { capabilities: { logging: {} }, enforceStrictCapabilities: true },
  );
  mcpServer = server;

  // Read tools — always available
  registerListSitesTool(server, client);
  registerSiteDetailsTool(server, client, resolver, completableSiteUrl);
  registerSearchAnalyticsTool(server, client, resolver, completableSiteUrl);
  registerInspectUrlTool(server, client, resolver, completableSiteUrl);
  registerBatchInspectTool(server, client, resolver, completableSiteUrl);
  registerListSitemapsTool(server, client, resolver, completableSiteUrl);
  registerPerformanceSummaryTool(server, client, resolver, completableSiteUrl);

  // Write tools — only registered when write scope is configured
  if (hasWriteScope()) {
    registerSubmitSitemapTool(server, client, resolver, completableSiteUrl);
    registerDeleteSitemapTool(server, client, resolver, completableSiteUrl);
    log("Write scope detected — submit_sitemap and delete_sitemap enabled.");
  } else {
    log("Read-only scope — write tools disabled. Set GSC_SCOPES to enable.");
  }

  // MCP Prompts — guided multi-step SEO workflows
  registerPrompts(server, completableSiteUrl);
  log("Registered 3 MCP prompts.");

  // MCP Resource — sites://list for property auto-discovery
  server.registerResource("gsc_sites", "sites://list", {
    title: "GSC Properties",
    description: "List all Google Search Console properties accessible with the current credentials. Enables LLMs to auto-discover available sites without calling list_sites first.",
    mimeType: "application/json",
    annotations: { audience: ["assistant"], priority: 1.0 },
  }, async () => {
    try {
      const data = await client.get<SiteList>("/sites");
      const sites = (data.siteEntry ?? []).map((s) => ({
        siteUrl: s.siteUrl,
        permissionLevel: s.permissionLevel,
      }));
      return {
        contents: [
          {
            uri: "sites://list",
            mimeType: "application/json",
            text: JSON.stringify(sites, null, 2),
          },
        ],
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`Resource sites://list error: ${msg}`, "error");
      return {
        contents: [
          {
            uri: "sites://list",
            mimeType: "application/json",
            text: JSON.stringify({ error: msg }),
          },
        ],
      };
    }
  });
  log("Registered sites://list resource.");

  // MCP Resource Template — sitemaps for a specific property
  server.registerResource(
    "gsc_sitemaps",
    new ResourceTemplate("sitemaps://{site_url}", {
      list: async () => {
        const urls = await resolver.listSiteUrls();
        return {
          resources: urls.map((u) => ({
            uri: `sitemaps://${u}`,
            name: `Sitemaps for ${u}`,
            mimeType: "application/json",
          })),
        };
      },
      complete: {
        site_url: async (value) => {
          const urls = await resolver.listSiteUrls();
          return urls.filter((u) => u.toLowerCase().includes(value.toLowerCase()));
        },
      },
    }),
    {
      title: "GSC Sitemaps",
      description:
        "List all sitemaps for a Google Search Console property. Returns sitemap health summary with errors, warnings, and index rates.",
      mimeType: "application/json",
      annotations: { audience: ["assistant"], priority: 0.5 },
    },
    async (uri, { site_url }) => {
      try {
        const encoded = encodeURIComponent(site_url as string);
        const data = await client.get<SitemapList>(`/sites/${encoded}/sitemaps`);
        const sitemaps = (data.sitemap ?? []).map(summarizeSitemap);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(sitemaps, null, 2),
            },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`Resource sitemaps://${site_url} error: ${msg}`, "error");
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({ error: msg }),
            },
          ],
        };
      }
    },
  );
  log("Registered sitemaps://{site_url} resource template.");

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("Server started.");

  // Graceful shutdown
  const shutdown = async () => {
    log("Shutting down...");
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[gsc-mcp] Failed to start:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
