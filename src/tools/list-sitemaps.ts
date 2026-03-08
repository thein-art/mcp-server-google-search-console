import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GscApiClient } from "../api-client.js";
import type { SiteResolver } from "../site-resolver.js";
import type { SitemapList, WmxSitemap } from "../types.js";
import { toolResult, toolError, siteUrlSchema, encodeSiteUrl, resolveSiteUrl } from "../util.js";

interface SitemapSummary {
  path: string;
  type: string | undefined;
  lastDownloaded: string | undefined;
  isPending: boolean;
  isSitemapsIndex: boolean;
  errors: number;
  warnings: number;
  submitted: number;
  indexed: number;
  indexRate: string | null;
}

export function summarizeSitemap(s: WmxSitemap): SitemapSummary {
  const errors = parseInt(s.errors, 10) || 0;
  const warnings = parseInt(s.warnings, 10) || 0;
  let submitted = 0;
  let indexed = 0;
  for (const c of s.contents ?? []) {
    submitted += parseInt(c.submitted, 10) || 0;
    indexed += parseInt(c.indexed ?? "0", 10) || 0;
  }
  return {
    path: s.path,
    type: s.type,
    lastDownloaded: s.lastDownloaded,
    isPending: s.isPending,
    isSitemapsIndex: s.isSitemapsIndex,
    errors,
    warnings,
    submitted,
    indexed,
    indexRate: submitted > 0 ? `${Math.round((indexed / submitted) * 100)}%` : null,
  };
}

export function registerListSitemapsTool(server: McpServer, client: GscApiClient, resolver: SiteResolver) {
  server.registerTool("list_sitemaps", {
    title: "List Sitemaps",
    description:
      "List all sitemaps submitted for a Google Search Console property. Returns sitemap health summary with errors, warnings, and index rates. Use sitemapIndex to filter child sitemaps of a specific sitemap index.",
    inputSchema: z.object({
      site_url: siteUrlSchema,
      sitemapIndex: z.string().url().optional()
        .describe("Filter to only sitemaps within this sitemap index URL (e.g. 'https://example.com/sitemap_index.xml')."),
    }),
  }, async ({ site_url, sitemapIndex }) => {
    try {
      const { siteUrl, resolvedNote } = await resolveSiteUrl(resolver, site_url);
      let path = `/sites/${encodeSiteUrl(siteUrl)}/sitemaps`;
      if (sitemapIndex) {
        path += `?sitemapIndex=${encodeURIComponent(sitemapIndex)}`;
      }
      const data = await client.get<SitemapList>(path);
      const raw = data.sitemap ?? [];
      const sitemaps = raw.map(summarizeSitemap);

      // Aggregate summary
      const totalErrors = sitemaps.reduce((sum, s) => sum + s.errors, 0);
      const totalWarnings = sitemaps.reduce((sum, s) => sum + s.warnings, 0);
      const totalSubmitted = sitemaps.reduce((sum, s) => sum + s.submitted, 0);
      const totalIndexed = sitemaps.reduce((sum, s) => sum + s.indexed, 0);
      const withErrors = sitemaps.filter((s) => s.errors > 0).length;
      const withWarnings = sitemaps.filter((s) => s.warnings > 0).length;

      const parts: string[] = [`${sitemaps.length} sitemaps`];
      if (withErrors > 0) parts.push(`${withErrors} with errors (${totalErrors} total)`);
      if (withWarnings > 0) parts.push(`${withWarnings} with warnings (${totalWarnings} total)`);
      if (totalSubmitted > 0) {
        const rate = Math.round((totalIndexed / totalSubmitted) * 100);
        parts.push(`${totalSubmitted} URLs submitted, ${totalIndexed} indexed (${rate}%)`);
      }

      return toolResult({
        ...(resolvedNote ? { _resolved: resolvedNote } : {}),
        _summary: parts.join(". ") + ".",
        sitemaps,
      });
    } catch (e) {
      return toolError(e);
    }
  });
}
