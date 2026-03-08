import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GscApiClient } from "../api-client.js";
import type { SiteResolver } from "../site-resolver.js";
import type { InspectUrlResponse } from "../types.js";
import { toolResult, toolError, siteUrlSchema, resolveSiteUrl } from "../util.js";
import { buildInspectionSummary } from "./inspect-url.js";

/** Run async tasks with a concurrency limit, preserving result order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

interface CompactResult {
  url: string;
  _summary: string;
  verdict: string;
  coverageState?: string;
  lastCrawlTime?: string;
  crawledAs?: string;
  googleCanonical?: string;
  userCanonical?: string;
  error?: string;
}

export function registerBatchInspectTool(server: McpServer, client: GscApiClient, resolver: SiteResolver) {
  server.registerTool("batch_inspect_urls", {
    title: "Batch Inspect URLs",
    description: [
      "Inspect multiple URLs' index status in Google Search Console in a single call.",
      "Returns a compact summary per URL plus an aggregate overview.",
      "Use this instead of calling inspect_url repeatedly — saves tool calls and is faster.",
      "Max 20 URLs per call. All URLs must belong to the same site_url property.",
      "Rate limit: ~600 requests/min per property.",
    ].join(" "),
    inputSchema: z.object({
      urls: z
        .array(z.string().url())
        .min(1)
        .max(20)
        .describe("URLs to inspect (max 20). All must belong to the site_url property."),
      site_url: siteUrlSchema,
      language_code: z
        .string()
        .describe("IETF BCP-47 language code for localized issue messages (e.g. 'de', 'en-US'). Defaults to 'en-US'.")
        .optional(),
    }),
  }, async ({ urls, site_url, language_code }) => {
    try {
      const { siteUrl, resolvedNote } = await resolveSiteUrl(resolver, site_url);

      const results = await mapWithConcurrency(urls, async (url): Promise<CompactResult> => {
        try {
          const body: Record<string, unknown> = {
            inspectionUrl: url,
            siteUrl,
          };
          if (language_code) body.languageCode = language_code;

          const data = await client.postInspection<InspectUrlResponse>(
            "/urlInspection/index:inspect",
            body,
          );

          const r = data.inspectionResult;
          const idx = r.indexStatusResult;

          return {
            url,
            _summary: buildInspectionSummary(r),
            verdict: idx?.verdict ?? "UNKNOWN",
            coverageState: idx?.coverageState,
            lastCrawlTime: idx?.lastCrawlTime,
            crawledAs: idx?.crawledAs,
            googleCanonical: idx?.googleCanonical,
            userCanonical: idx?.userCanonical,
          };
        } catch (e) {
          return {
            url,
            _summary: `Error: ${e instanceof Error ? e.message : String(e)}`,
            verdict: "ERROR",
            error: e instanceof Error ? e.message : String(e),
          };
        }
      }, 5);

      // Build aggregate summary
      const counts = { indexed: 0, notIndexed: 0, errors: 0 };
      for (const r of results) {
        if (r.verdict === "ERROR") counts.errors++;
        else if (r.verdict === "PASS") counts.indexed++;
        else counts.notIndexed++;
      }

      const parts = [`${urls.length} URLs inspected:`];
      if (counts.indexed > 0) parts.push(`${counts.indexed} indexed`);
      if (counts.notIndexed > 0) parts.push(`${counts.notIndexed} not indexed`);
      if (counts.errors > 0) parts.push(`${counts.errors} errors`);

      return toolResult({
        ...(resolvedNote ? { _resolved: resolvedNote } : {}),
        _summary: parts.join(" "),
        results,
      });
    } catch (e) {
      return toolError(e);
    }
  });
}
