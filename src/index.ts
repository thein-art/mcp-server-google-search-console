#!/usr/bin/env node
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
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
import type { SiteList, SitemapList } from "./types.js";

function log(msg: string) {
  console.error(`[gsc-mcp] ${msg}`);
}

async function main() {
  const { provider, label } = await createTokenProvider();
  log(`Authenticated via ${label}`);

  const client = new GscApiClient(provider);
  const resolver = new SiteResolver(client);

  const server = new McpServer({
    name: "google-search-console",
    version: "0.1.0",
  });

  // Read tools — always available
  registerListSitesTool(server, client);
  registerSiteDetailsTool(server, client, resolver);
  registerSearchAnalyticsTool(server, client, resolver);
  registerInspectUrlTool(server, client, resolver);
  registerBatchInspectTool(server, client, resolver);
  registerListSitemapsTool(server, client, resolver);
  registerPerformanceSummaryTool(server, client, resolver);

  // Write tools — only registered when write scope is configured
  if (hasWriteScope()) {
    registerSubmitSitemapTool(server, client, resolver);
    registerDeleteSitemapTool(server, client, resolver);
    log("Write scope detected — submit_sitemap and delete_sitemap enabled.");
  } else {
    log("Read-only scope — write tools disabled. Set GSC_SCOPES to enable.");
  }

  // MCP Prompts — guided multi-step SEO workflows
  registerPrompts(server);
  log("Registered 3 MCP prompts.");

  // MCP Resource — sites://list for property auto-discovery
  server.registerResource("gsc_sites", "sites://list", {
    title: "GSC Properties",
    description: "List all Google Search Console properties accessible with the current credentials. Enables LLMs to auto-discover available sites without calling list_sites first.",
    mimeType: "application/json",
  }, async () => {
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
  });
  log("Registered sites://list resource.");

  // MCP Resource Template — sitemaps for a specific property
  server.registerResource(
    "gsc_sitemaps",
    new ResourceTemplate("sitemaps://{site_url}", { list: undefined }),
    {
      title: "GSC Sitemaps",
      description:
        "List all sitemaps for a Google Search Console property. Returns sitemap health summary with errors, warnings, and index rates.",
      mimeType: "application/json",
    },
    async (uri, { site_url }) => {
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
