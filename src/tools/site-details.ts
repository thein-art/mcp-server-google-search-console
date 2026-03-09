import { z } from "zod";
import type { ZodTypeAny } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GscApiClient } from "../api-client.js";
import type { SiteResolver } from "../site-resolver.js";
import type { Site } from "../types.js";
import { toolError, encodeSiteUrl, resolveSiteUrl } from "../util.js";

const outputSchema = z.object({
  _resolved: z.string().optional(),
  siteUrl: z.string(),
  permissionLevel: z.string(),
}).passthrough();

export function registerSiteDetailsTool(server: McpServer, client: GscApiClient, resolver: SiteResolver, completableSiteUrl: ZodTypeAny) {
  server.registerTool("get_site", {
    title: "Get Site Details",
    description:
      "Get details for a specific Google Search Console property, including permission level.",
    inputSchema: z.object({
      site_url: completableSiteUrl,
    }),
    outputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async ({ site_url }, { signal }) => {
    try {
      const { siteUrl, resolvedNote } = await resolveSiteUrl(resolver, site_url as string);
      const data = await client.get<Site>(`/sites/${encodeSiteUrl(siteUrl)}`, signal);
      const payload = { ...(resolvedNote ? { _resolved: resolvedNote } : {}), ...data };
      return {
        structuredContent: payload,
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
      };
    } catch (e) {
      return toolError(e);
    }
  });
}
