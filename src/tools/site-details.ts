import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GscApiClient } from "../api-client.js";
import type { SiteResolver } from "../site-resolver.js";
import type { Site } from "../types.js";
import { toolResult, toolError, siteUrlSchema, encodeSiteUrl, resolveSiteUrl } from "../util.js";

export function registerSiteDetailsTool(server: McpServer, client: GscApiClient, resolver: SiteResolver) {
  server.registerTool("get_site", {
    title: "Get Site Details",
    description:
      "Get details for a specific Google Search Console property, including permission level.",
    inputSchema: z.object({
      site_url: siteUrlSchema,
    }),
  }, async ({ site_url }) => {
    try {
      const { siteUrl, resolvedNote } = await resolveSiteUrl(resolver, site_url);
      const data = await client.get<Site>(`/sites/${encodeSiteUrl(siteUrl)}`);
      return toolResult({ ...(resolvedNote ? { _resolved: resolvedNote } : {}), ...data });
    } catch (e) {
      return toolError(e);
    }
  });
}
