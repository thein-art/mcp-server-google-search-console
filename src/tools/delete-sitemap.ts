import { z } from "zod";
import type { ZodTypeAny } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GscApiClient } from "../api-client.js";
import type { SiteResolver } from "../site-resolver.js";
import { toolResult, toolError, encodeSiteUrl, resolveSiteUrl } from "../util.js";

export function registerDeleteSitemapTool(server: McpServer, client: GscApiClient, resolver: SiteResolver, completableSiteUrl: ZodTypeAny) {
  server.registerTool("delete_sitemap", {
    title: "Delete Sitemap",
    description:
      "Delete a sitemap from Google Search Console. This only removes the sitemap registration — it does not affect the actual file or indexed URLs. Requires write scope and explicit confirmation (confirm: true).",
    inputSchema: z.object({
      site_url: completableSiteUrl,
      feedpath: z.string().url().describe("The exact URL of the sitemap to delete. Use list_sitemaps to find the correct path."),
      confirm: z
        .boolean()
        .describe("Must be set to true to confirm deletion. Safety gate to prevent accidental deletions."),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async ({ site_url, feedpath, confirm }, { signal }) => {
    try {
      if (!confirm) {
        throw new Error(
          "Deletion not confirmed. Set confirm: true to proceed with deleting the sitemap.",
        );
      }

      const { siteUrl, resolvedNote } = await resolveSiteUrl(resolver, site_url as string);
      await client.delete(
        `/sites/${encodeSiteUrl(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`,
        signal,
      );
      return toolResult({
        ...(resolvedNote ? { _resolved: resolvedNote } : {}),
        success: true,
        deleted: feedpath,
      });
    } catch (e) {
      return toolError(e);
    }
  });
}
