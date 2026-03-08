import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GscApiClient } from "../api-client.js";
import type { SiteResolver } from "../site-resolver.js";
import type { SearchAnalyticsResponse } from "../types.js";
import {
  toolResult,
  toolError,
  siteUrlSchema,
  encodeSiteUrl,
  resolveSiteUrl,
  daysAgo,
  today,
} from "../util.js";

const PERIOD_DAYS: Record<string, number> = { "7d": 7, "28d": 28, "90d": 90 };

interface Metrics {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

function roundMetrics(m: Metrics): Metrics {
  return {
    clicks: m.clicks,
    impressions: m.impressions,
    ctr: Math.round(m.ctr * 10000) / 10000,
    position: Math.round(m.position * 10) / 10,
  };
}

function pctChange(cur: number, prev: number): string {
  if (prev === 0) return cur === 0 ? "0%" : "+∞";
  const pct = ((cur - prev) / prev) * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${Math.round(pct * 10) / 10}%`;
}

function formatNum(n: number): string {
  return n.toLocaleString("en-US");
}

export function registerPerformanceSummaryTool(
  server: McpServer,
  client: GscApiClient,
  resolver: SiteResolver,
) {
  server.registerTool("get_performance_summary", {
    title: "Performance Summary",
    description: [
      "Get a quick performance overview for a site: aggregated metrics for the current period,",
      "automatic comparison with the previous period (same length), and top 10 queries by clicks.",
      "One call instead of multiple get_search_analytics calls. Ideal for 'how is the site doing?' questions.",
    ].join(" "),
    inputSchema: z.object({
      site_url: siteUrlSchema,
      period: z
        .enum(["7d", "28d", "90d"])
        .describe("Time period to summarize. Default: '28d'.")
        .optional(),
      search_type: z
        .enum(["web", "image", "video", "news", "googleNews", "discover"])
        .describe("Search type to filter by. Default: 'web'.")
        .optional(),
    }),
  }, async ({ site_url, period, search_type }) => {
    try {
      const { siteUrl, resolvedNote } = await resolveSiteUrl(resolver, site_url);
      const days = PERIOD_DAYS[period ?? "28d"];
      const endDate = today();
      const startDate = daysAgo(days);
      const prevEndDate = daysAgo(days + 1);
      const prevStartDate = daysAgo(days * 2);

      const endpoint = `/sites/${encodeSiteUrl(siteUrl)}/searchAnalytics/query`;

      const buildBody = (start: string, end: string, dims?: string[], limit?: number): Record<string, unknown> => {
        const body: Record<string, unknown> = {
          startDate: start,
          endDate: end,
        };
        if (dims) body.dimensions = dims;
        if (search_type) body.type = search_type;
        if (limit) body.rowLimit = limit;
        return body;
      };

      const [currentData, previousData, topQueriesData] = await Promise.all([
        client.post<SearchAnalyticsResponse>(endpoint, buildBody(startDate, endDate)),
        client.post<SearchAnalyticsResponse>(endpoint, buildBody(prevStartDate, prevEndDate)),
        client.post<SearchAnalyticsResponse>(endpoint, buildBody(startDate, endDate, ["query"], 10)),
      ]);

      const zeroMetrics: Metrics = { clicks: 0, impressions: 0, ctr: 0, position: 0 };
      const current = roundMetrics(currentData.rows?.[0] ?? zeroMetrics);
      const previous = roundMetrics(previousData.rows?.[0] ?? zeroMetrics);

      const delta: Metrics = {
        clicks: current.clicks - previous.clicks,
        impressions: current.impressions - previous.impressions,
        ctr: Math.round((current.ctr - previous.ctr) * 10000) / 10000,
        position: Math.round((current.position - previous.position) * 10) / 10,
      };

      const delta_pct = {
        clicks: pctChange(current.clicks, previous.clicks),
        impressions: pctChange(current.impressions, previous.impressions),
        ctr: pctChange(current.ctr, previous.ctr),
        position: pctChange(current.position, previous.position),
      };

      const top_queries = (topQueriesData.rows ?? []).map((r) => ({
        query: r.keys?.[0] ?? "",
        ...roundMetrics(r),
      }));

      const topQuery = top_queries[0];
      const topQueryNote = topQuery ? ` Top query: '${topQuery.query}' (${formatNum(topQuery.clicks)} clicks).` : "";
      const _summary = `${days}-day summary: ${formatNum(current.clicks)} clicks (${delta_pct.clicks}), ${formatNum(current.impressions)} impressions (${delta_pct.impressions}), ${(current.ctr * 100).toFixed(1)}% CTR, avg pos ${current.position}.${topQueryNote}`;

      return toolResult({
        ...(resolvedNote ? { _resolved: resolvedNote } : {}),
        site: siteUrl,
        period: {
          label: period ?? "28d",
          current: { start: startDate, end: endDate },
          previous: { start: prevStartDate, end: prevEndDate },
        },
        current,
        previous,
        delta,
        delta_pct,
        top_queries,
        _summary,
      });
    } catch (e) {
      return toolError(e);
    }
  });
}
