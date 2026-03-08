import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GscApiClient } from "../api-client.js";
import type { SiteResolver } from "../site-resolver.js";
import type { SearchAnalyticsResponse, DimensionFilter, Dimension } from "../types.js";
import {
  toolResult,
  toolError,
  siteUrlSchema,
  dateSchema,
  dimensionsSchema,
  dimensionFilterSchema,
  encodeSiteUrl,
  resolveSiteUrl,
  daysAgo,
  today,
  validateDateRange,
  roundMetrics,
  formatNum,
  pctChange,
} from "../util.js";
import type { Metrics } from "../util.js";

function daysBetween(start: string, end: string): number {
  const s = new Date(start + "T00:00:00Z");
  const e = new Date(end + "T00:00:00Z");
  return Math.round((e.getTime() - s.getTime()) / 86400000) + 1;
}

/** Build a human-readable _summary for standard (non-comparison) results. */
function buildStandardSummary(
  rows: Array<Record<string, unknown>>,
  start: string,
  end: string,
  dims: string[] | undefined,
): string {
  const days = daysBetween(start, end);
  if (rows.length === 0) return `${days} days, no data.`;

  // Aggregated (no dimensions) — single row
  if (!dims || dims.length === 0) {
    const r = rows[0] as Record<string, unknown>;
    const clicks = r.clicks as number;
    const impressions = r.impressions as number;
    const ctr = r.ctr as number;
    const position = r.position as number;
    return `${days} days: ${formatNum(clicks)} clicks, ${formatNum(impressions)} impressions, ${(ctr * 100).toFixed(1)}% CTR, avg pos ${position}.`;
  }

  // With dimensions — summarize totals + top entry
  let totalClicks = 0;
  let totalImpressions = 0;
  for (const r of rows) {
    totalClicks += r.clicks as number;
    totalImpressions += r.impressions as number;
  }
  const top = rows[0];
  const topClicks = top.clicks as number;
  const topLabel = (top.keys as string[] | undefined)?.[0] ?? "?";
  return `${days} days, ${rows.length} rows: ${formatNum(totalClicks)} clicks, ${formatNum(totalImpressions)} impressions. Top: '${topLabel}' (${formatNum(topClicks)} clicks).`;
}

/** Build a human-readable _summary for comparison results. */
function buildComparisonSummary(
  rows: Array<Record<string, unknown>>,
  start: string,
  end: string,
  inBoth: number,
  onlyCurrent: number,
  onlyPrevious: number,
): string {
  const days = daysBetween(start, end);
  if (rows.length === 0) return `${days}d vs prev: no data.`;

  // Sum current/previous clicks across all rows
  let curClicks = 0;
  let prevClicks = 0;
  for (const r of rows) {
    if (r.current) curClicks += (r.current as Metrics).clicks;
    if (r.previous) prevClicks += (r.previous as Metrics).clicks;
  }
  const clicksPct = pctChange(curClicks, prevClicks);

  // Find top mover (row with largest absolute delta clicks)
  let topMover = "";
  const first = rows[0] as { keys?: string[]; delta?: Metrics };
  if (first?.delta && first.keys?.[0]) {
    const sign = first.delta.clicks >= 0 ? "+" : "";
    topMover = ` Top mover: '${first.keys[0]}' (${sign}${formatNum(first.delta.clicks)} clicks).`;
  }

  return `${days}d vs prev: clicks ${clicksPct} (${formatNum(curClicks)}←${formatNum(prevClicks)}), ${inBoth} in both, ${onlyCurrent} new, ${onlyPrevious} lost.${topMover}`;
}

/** Determine the effective granularity based on auto-detection or explicit setting. */
export function resolveGranularity(
  gran: "daily" | "weekly" | "monthly" | "auto" | undefined,
  days: number,
): "daily" | "weekly" | "monthly" {
  if (!gran || gran === "daily") return "daily";
  if (gran === "weekly") return "weekly";
  if (gran === "monthly") return "monthly";
  // auto
  if (days <= 14) return "daily";
  if (days <= 60) return "weekly";
  return "monthly";
}

/** Get bucket key for a date string based on granularity. */
export function dateBucketKey(dateStr: string, gran: "weekly" | "monthly"): string {
  if (gran === "monthly") return dateStr.slice(0, 7); // YYYY-MM
  // ISO week: find Monday of the week
  const d = new Date(dateStr + "T00:00:00Z");
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day; // Monday = 1
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10); // Monday date as bucket key
}

/** Aggregate rows by date granularity. Date must be the first dimension in keys. */
export function aggregateByDateGranularity(
  rows: Array<Record<string, unknown>>,
  gran: "weekly" | "monthly",
  dateIndex: number,
): Array<Record<string, unknown>> {
  const buckets = new Map<string, { clicks: number; impressions: number; positionWeighted: number; keys: string[] }>();

  for (const row of rows) {
    const keys = (row.keys as string[]) ?? [];
    const bucketDate = dateBucketKey(keys[dateIndex], gran);
    const newKeys = [...keys];
    newKeys[dateIndex] = bucketDate;
    const bucketKey = newKeys.join("\0");

    const existing = buckets.get(bucketKey);
    const clicks = (row as unknown as Metrics).clicks;
    const impressions = (row as unknown as Metrics).impressions;
    const position = (row as unknown as Metrics).position;

    if (existing) {
      existing.clicks += clicks;
      existing.impressions += impressions;
      existing.positionWeighted += position * impressions;
    } else {
      buckets.set(bucketKey, {
        clicks,
        impressions,
        positionWeighted: position * impressions,
        keys: newKeys,
      });
    }
  }

  return Array.from(buckets.values()).map((b) => {
    const position = b.impressions > 0 ? Math.round((b.positionWeighted / b.impressions) * 10) / 10 : 0;
    const ctr = b.impressions > 0 ? Math.round((b.clicks / b.impressions) * 10000) / 10000 : 0;
    return {
      keys: b.keys,
      clicks: b.clicks,
      impressions: b.impressions,
      ctr,
      position,
    };
  });
}

/** Calculate comparison period dates from primary period and compare_period mode. */
export function calcCompareDates(
  start: string,
  end: string,
  mode: "previous_period" | "year_over_year",
): { compareStart: string; compareEnd: string } {
  const s = new Date(start + "T00:00:00Z");
  const e = new Date(end + "T00:00:00Z");

  if (mode === "year_over_year") {
    const origDayS = s.getUTCDate();
    s.setUTCFullYear(s.getUTCFullYear() - 1);
    if (s.getUTCDate() !== origDayS) s.setUTCDate(0); // clamp to last day of prev month
    const origDayE = e.getUTCDate();
    e.setUTCFullYear(e.getUTCFullYear() - 1);
    if (e.getUTCDate() !== origDayE) e.setUTCDate(0);
  } else {
    // previous_period: same length, directly before
    const days = Math.round((e.getTime() - s.getTime()) / 86400000) + 1;
    e.setTime(s.getTime() - 86400000); // day before start
    s.setTime(e.getTime() - (days - 1) * 86400000);
  }

  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { compareStart: fmt(s), compareEnd: fmt(e) };
}

export function registerSearchAnalyticsTool(server: McpServer, client: GscApiClient, resolver: SiteResolver) {
  server.registerTool("get_search_analytics", {
    title: "Search Analytics",
    description: [
      "Query Google Search Console search analytics data (clicks, impressions, CTR, position).",
      "IMPORTANT: Without dimensions, returns a single aggregated row. Set dimensions (e.g. ['query'], ['page'], ['date','query']) to get per-keyword/per-page/per-date breakdowns.",
      "Sorted by clicks descending (by date ascending when date dimension is used). API returns top results, not all.",
      "Data is typically finalized with a 2-3 day delay. Default date range: last 28 days.",
      "For period comparisons (winners/losers), use compare_period or compare_start_date/compare_end_date.",
      "Prefer convenience filters (filter_query, filter_page, filter_device, filter_country) over generic filters.",
      "Country codes: ISO 3166-1 alpha-3 lowercase (e.g. 'deu', 'fra', 'usa'). Device values: DESKTOP, MOBILE, TABLET.",
    ].join(" "),
    inputSchema: z.object({
      site_url: siteUrlSchema,
      start_date: dateSchema
        .describe("Start date (YYYY-MM-DD). Defaults to 28 days ago. Note: Google uses PT timezone for dates.")
        .optional(),
      end_date: dateSchema
        .describe("End date (YYYY-MM-DD). Defaults to today. Finalized data is typically 2-3 days behind.")
        .optional(),
      dimensions: dimensionsSchema
        .describe("REQUIRED for breakdowns. Without this, returns one aggregated row. Common: ['query'] for keywords, ['page'] for URLs, ['date','query'] for trends. Order determines keys[] order in response. Auto-inferred from convenience filters if omitted.")
        .optional(),
      search_type: z
        .enum(["web", "image", "video", "news", "googleNews", "discover"])
        .describe("Search type to filter by. Defaults to 'web'.")
        .optional(),
      filter_query: z.string().optional()
        .describe("Filter queries containing this text (shorthand for contains-filter). Auto-adds 'query' dimension if dimensions not set."),
      filter_page: z.string().optional()
        .describe("Filter pages containing this URL substring (shorthand for contains-filter). Auto-adds 'query' dimension if dimensions not set."),
      filter_device: z.enum(["DESKTOP", "MOBILE", "TABLET"]).optional()
        .describe("Filter by device type."),
      filter_country: z.string().regex(/^[a-z]{3}$/).optional()
        .describe("Filter by country (ISO 3166-1 alpha-3 lowercase, e.g. 'deu', 'usa', 'fra')."),
      filters: z
        .array(dimensionFilterSchema)
        .describe("Advanced dimension filters (AND-combined). Operators: equals, notEquals, contains, notContains, includingRegex, excludingRegex. Merged with convenience filters. Note: page/query filters are case-sensitive.")
        .optional(),
      compare_period: z
        .enum(["previous_period", "year_over_year"])
        .describe("Auto-calculate comparison dates. 'previous_period': same-length window directly before start_date. 'year_over_year': same dates one year ago.")
        .optional(),
      compare_start_date: dateSchema
        .describe("Comparison period start (YYYY-MM-DD). Use for custom comparison ranges. Mutually exclusive with compare_period.")
        .optional(),
      compare_end_date: dateSchema
        .describe("Comparison period end (YYYY-MM-DD). Required when compare_start_date is set.")
        .optional(),
      aggregation_type: z
        .enum(["auto", "byPage", "byProperty", "byNewsShowcasePanel"])
        .describe("How to aggregate. 'auto' (default): byPage when page dimension used, byProperty otherwise.")
        .optional(),
      row_limit: z
        .number()
        .int()
        .min(1)
        .max(25000)
        .describe("Max rows in final result (1-25000, default 1000). API returns top results, not all. In comparison mode, API calls internally oversample for complete joins.")
        .optional(),
      start_row: z
        .number()
        .int()
        .min(0)
        .describe("Zero-based offset for pagination. Not supported in comparison mode.")
        .optional(),
      data_state: z
        .enum(["all", "final", "hourly_all"])
        .describe("'final' (default): finalized data only. 'all': includes fresh/incomplete data. 'hourly_all': hourly breakdown (use with hour dimension).")
        .optional(),
      date_granularity: z
        .enum(["daily", "weekly", "monthly", "auto"])
        .describe("Aggregate date-dimension rows into buckets. Only applies when 'date' is in dimensions. 'daily': no change (default). 'weekly': ISO week buckets. 'monthly': YYYY-MM buckets. 'auto': ≤14d=daily, 15-60d=weekly, >60d=monthly. Metrics are aggregated: clicks/impressions summed, position weighted by impressions, CTR recalculated.")
        .optional(),
    }),
  }, async ({
    site_url,
    start_date,
    end_date,
    dimensions,
    search_type,
    filter_query,
    filter_page,
    filter_device,
    filter_country,
    filters,
    compare_period,
    compare_start_date,
    compare_end_date,
    aggregation_type,
    row_limit,
    start_row,
    data_state,
    date_granularity,
  }) => {
    try {
      // Validate comparison params
      if (compare_period && (compare_start_date || compare_end_date)) {
        throw new Error("Cannot use compare_period together with compare_start_date/compare_end_date. Use one or the other.");
      }
      if ((compare_start_date && !compare_end_date) || (!compare_start_date && compare_end_date)) {
        throw new Error("Both compare_start_date and compare_end_date must be set together.");
      }

      const { siteUrl, resolvedNote } = await resolveSiteUrl(resolver, site_url);

      const resolvedStart = start_date ?? daysAgo(28);
      const resolvedEnd = end_date ?? today();
      validateDateRange(resolvedStart, resolvedEnd);

      // Build convenience filters
      const autoFilters: DimensionFilter[] = [];
      const autoDimensions: Dimension[] = [];

      if (filter_query) {
        autoFilters.push({ dimension: "query", operator: "contains", expression: filter_query });
        autoDimensions.push("query");
      }
      if (filter_page) {
        autoFilters.push({ dimension: "page", operator: "contains", expression: filter_page });
        autoDimensions.push("page");
      }
      if (filter_device) {
        autoFilters.push({ dimension: "device", operator: "equals", expression: filter_device });
      }
      if (filter_country) {
        autoFilters.push({ dimension: "country", operator: "equals", expression: filter_country });
      }

      const allFilters = [...autoFilters, ...(filters ?? [])];
      const uniqueAutoDimensions = [...new Set(autoDimensions)];
      const effectiveDimensions = dimensions ?? (uniqueAutoDimensions.length > 0 ? uniqueAutoDimensions : undefined);

      // Determine if we're in comparison mode
      let compareStart: string | undefined;
      let compareEnd: string | undefined;

      if (compare_period) {
        const calc = calcCompareDates(resolvedStart, resolvedEnd, compare_period);
        compareStart = calc.compareStart;
        compareEnd = calc.compareEnd;
      } else if (compare_start_date && compare_end_date) {
        validateDateRange(compare_start_date, compare_end_date);
        compareStart = compare_start_date;
        compareEnd = compare_end_date;
      }

      const isComparison = compareStart !== undefined && compareEnd !== undefined;

      // Build API request body
      const buildBody = (startD: string, endD: string): Record<string, unknown> => {
        const body: Record<string, unknown> = {
          startDate: startD,
          endDate: endD,
        };
        if (effectiveDimensions) body.dimensions = effectiveDimensions;
        if (search_type) body.type = search_type;
        if (aggregation_type) body.aggregationType = aggregation_type;
        if (data_state) body.dataState = data_state;
        if (allFilters.length > 0) {
          body.dimensionFilterGroups = [
            { groupType: "and", filters: allFilters },
          ];
        }
        return body;
      };

      const endpoint = `/sites/${encodeSiteUrl(siteUrl)}/searchAnalytics/query`;

      if (!isComparison) {
        // --- Standard (non-comparison) mode ---
        const body = buildBody(resolvedStart, resolvedEnd);
        if (row_limit !== undefined) body.rowLimit = row_limit;
        if (start_row !== undefined) body.startRow = start_row;

        const data = await client.post<SearchAnalyticsResponse>(endpoint, body);

        let rows: Array<Record<string, unknown>> = (data.rows ?? []).map((r) => ({
          ...(r.keys ? { keys: r.keys } : {}),
          ...roundMetrics(r),
        }));

        // Apply date_granularity post-processing
        let appliedGranularity: string | undefined;
        const dateIndex = effectiveDimensions?.indexOf("date") ?? -1;
        if (date_granularity && dateIndex >= 0) {
          const days = daysBetween(resolvedStart, resolvedEnd);
          const resolved = resolveGranularity(date_granularity, days);
          if (resolved !== "daily") {
            rows = aggregateByDateGranularity(rows, resolved, dateIndex);
            appliedGranularity = resolved;
          }
        }

        const result: Record<string, unknown> = {
          ...(resolvedNote ? { _resolved: resolvedNote } : {}),
          _summary: buildStandardSummary(rows, resolvedStart, resolvedEnd, effectiveDimensions),
          site: siteUrl,
          dateRange: { start: resolvedStart, end: resolvedEnd },
          rows,
          rowCount: rows.length,
          aggregationType: data.responseAggregationType,
        };

        if (appliedGranularity) {
          result.dateGranularity = appliedGranularity;
        }
        if (data.metadata) {
          result.metadata = data.metadata;
        }

        return toolResult(result);
      }

      // --- Comparison mode ---
      const finalLimit = row_limit ?? 1000;
      // Oversample: fetch more rows per API call to ensure complete joins
      const apiLimit = Math.max(finalLimit * 3, 2000);

      const currentBody = buildBody(resolvedStart, resolvedEnd);
      currentBody.rowLimit = apiLimit;
      const previousBody = buildBody(compareStart!, compareEnd!);
      previousBody.rowLimit = apiLimit;

      const [currentData, previousData] = await Promise.all([
        client.post<SearchAnalyticsResponse>(endpoint, currentBody),
        client.post<SearchAnalyticsResponse>(endpoint, previousBody),
      ]);

      // Join by keys
      const currentMap = new Map<string, Metrics>();
      for (const r of currentData.rows ?? []) {
        const key = JSON.stringify(r.keys ?? []);
        currentMap.set(key, r);
      }
      const previousMap = new Map<string, Metrics>();
      for (const r of previousData.rows ?? []) {
        const key = JSON.stringify(r.keys ?? []);
        previousMap.set(key, r);
      }

      const allKeys = new Set([...currentMap.keys(), ...previousMap.keys()]);

      const comparedRows: Array<Record<string, unknown>> = [];
      for (const key of allKeys) {
        const cur = currentMap.get(key);
        const prev = previousMap.get(key);

        const curMetrics = cur ? roundMetrics(cur) : null;
        const prevMetrics = prev ? roundMetrics(prev) : null;

        const row: Record<string, unknown> = {};
        if (effectiveDimensions) {
          row.keys = JSON.parse(key) as string[];
        }
        row.current = curMetrics;
        row.previous = prevMetrics;

        if (curMetrics && prevMetrics) {
          row.delta = {
            clicks: curMetrics.clicks - prevMetrics.clicks,
            impressions: curMetrics.impressions - prevMetrics.impressions,
            ctr: Math.round((curMetrics.ctr - prevMetrics.ctr) * 10000) / 10000,
            position: Math.round((curMetrics.position - prevMetrics.position) * 10) / 10,
          };
        }

        comparedRows.push(row);
      }

      // Sort by |delta.clicks| descending — biggest movers first (winners AND losers)
      // Rows with delta come first, then current-only (new), then previous-only (lost)
      comparedRows.sort((a, b) => {
        const da = a.delta as Metrics | undefined;
        const db = b.delta as Metrics | undefined;
        if (da && db) return Math.abs(db.clicks) - Math.abs(da.clicks);
        if (da) return -1;
        if (db) return 1;
        // Both missing delta: sort by whichever has clicks
        const ca = (a.current as Metrics | null)?.clicks ?? 0;
        const cb = (b.current as Metrics | null)?.clicks ?? 0;
        return cb - ca;
      });

      // Trim to final limit
      const trimmed = comparedRows.slice(0, finalLimit);

      // Summary stats
      const inBoth = comparedRows.filter((r) => r.current && r.previous).length;
      const onlyCurrent = comparedRows.filter((r) => r.current && !r.previous).length;
      const onlyPrevious = comparedRows.filter((r) => !r.current && r.previous).length;

      const result: Record<string, unknown> = {
        ...(resolvedNote ? { _resolved: resolvedNote } : {}),
        _summary: buildComparisonSummary(trimmed, resolvedStart, resolvedEnd, inBoth, onlyCurrent, onlyPrevious),
        site: siteUrl,
        currentPeriod: { start: resolvedStart, end: resolvedEnd },
        previousPeriod: { start: compareStart, end: compareEnd },
        _comparison: `${inBoth} in both periods, ${onlyCurrent} only in current (new), ${onlyPrevious} only in previous (lost). Rows with null current/previous were not in that period's top ${apiLimit} results.`,
        rows: trimmed,
        rowCount: trimmed.length,
      };

      return toolResult(result);
    } catch (e) {
      return toolError(e);
    }
  });
}
