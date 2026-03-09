import { z } from "zod";
import type { ZodTypeAny } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GscApiClient } from "../api-client.js";
import type { SiteResolver } from "../site-resolver.js";
import { toolResult, toolError, encodeSiteUrl, resolveSiteUrl } from "../util.js";

export function registerSubmitSitemapTool(server: McpServer, client: GscApiClient, resolver: SiteResolver, completableSiteUrl: ZodTypeAny) {
  server.registerTool("submit_sitemap", {
    title: "Submit Sitemap",
    description:
      "Submit a sitemap to Google Search Console for crawling. Idempotent — resubmitting an existing sitemap is safe and triggers a recrawl. Requires write scope (GSC_SCOPES='https://www.googleapis.com/auth/webmasters').",
    inputSchema: z.object({
      site_url: completableSiteUrl,
      feedpath: z.string().url().describe("Full URL of the sitemap (e.g. 'https://example.com/sitemap.xml'). Must be accessible to Googlebot."),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, async ({ site_url, feedpath }, { signal }) => {
    try {
      const { siteUrl, resolvedNote } = await resolveSiteUrl(resolver, site_url as string);
      await client.put(
        `/sites/${encodeSiteUrl(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`,
        signal,
      );
      return toolResult({
        ...(resolvedNote ? { _resolved: resolvedNote } : {}),
        success: true,
        feedpath,
      });
    } catch (e) {
      return toolError(e);
    }
  });
}
